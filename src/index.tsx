import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'

const app = new Hono()

app.use('/api/*', cors())
app.use('/static/*', serveStatic({ root: './' }))

// ─── 시뮬레이션 데이터 상태 ───────────────────────────────────────────
let currentState = {
  timestamp: new Date().toISOString(),
  runways: [
    { id: 'RWY15L/33R', name: '15L/33R', status: 'SAFE', length: 4000, width: 60 },
    { id: 'RWY15R/33L', name: '15R/33L', status: 'SAFE', length: 3750, width: 60 },
    { id: 'RWY16L/34R', name: '16L/34R', status: 'CAUTION', length: 4000, width: 60 },
    { id: 'RWY16R/34L', name: '16R/34L', status: 'SAFE', length: 3750, width: 60 },
  ],
  sensors: {
    drone: { status: 'ACTIVE', battery: 87, coverage: 94, lastScan: '2분 전' },
    radar: { status: 'ACTIVE', range: '5km', targets: 2, lastUpdate: '실시간' },
    thermal: { status: 'ACTIVE', tempMin: -2, tempMax: 8, iceRisk: 'LOW' },
    surface: { status: 'ACTIVE', friction: 0.72, moisture: 'DRY', temp: 3.2 },
  },
  weather: {
    temp: 3.2,
    humidity: 68,
    wind: { speed: 12, direction: 'NNW' },
    visibility: 9800,
    condition: '맑음',
    iceRisk: 'LOW',
  },
  alerts: [] as Array<{id: string; type: string; runway: string; level: string; message: string; time: string}>,
  eventLog: [
    { id: 'e001', type: 'FOD', runway: 'RWY16L/34R', level: 'CAUTION', message: '이물질 감지 - 소형 금속 파편 추정 (드론 카메라)', time: '14:32:11' },
    { id: 'e002', type: 'BIRD', runway: 'RWY15L/33R', level: 'INFO', message: '조류 2마리 감지 - 레이더 추적 중', time: '14:28:45' },
    { id: 'e003', type: 'SURFACE', runway: 'RWY15R/33L', level: 'INFO', message: '노면 습도 정상 범위 확인', time: '14:25:00' },
    { id: 'e004', type: 'ICE', runway: 'RWY16L/34R', level: 'CAUTION', message: '결빙 위험 지수 상승 - 열화상 이상 감지', time: '14:20:33' },
    { id: 'e005', type: 'SYSTEM', runway: 'ALL', level: 'INFO', message: '시스템 전체 점검 완료 - 정상 운영 중', time: '14:00:00' },
  ] as Array<{id: string; type: string; runway: string; level: string; message: string; time: string}>,
  safetyIndex: [72, 75, 80, 78, 82, 79, 85, 83, 81, 84, 87, 85],
}

let simInterval: ReturnType<typeof setInterval> | null = null

function getOverallStatus() {
  const statuses = currentState.runways.map(r => r.status)
  if (statuses.includes('HOLD')) return 'HOLD'
  if (statuses.includes('CAUTION')) return 'CAUTION'
  return 'SAFE'
}

// ─── API 라우트 ───────────────────────────────────────────────────────

app.get('/api/status', (c) => {
  return c.json({
    ...currentState,
    overall: getOverallStatus(),
    timestamp: new Date().toISOString(),
  })
})

app.get('/api/runways', (c) => {
  return c.json({ runways: currentState.runways, overall: getOverallStatus() })
})

app.get('/api/sensors', (c) => {
  return c.json(currentState.sensors)
})

app.get('/api/weather', (c) => {
  return c.json(currentState.weather)
})

app.get('/api/events', (c) => {
  return c.json({ events: currentState.eventLog })
})

app.get('/api/alerts', (c) => {
  return c.json({ alerts: currentState.alerts })
})

// 경보 발령 API
app.post('/api/alert', async (c) => {
  const body = await c.req.json<{runway: string; level: string; type: string; message: string}>()
  const alert = {
    id: `a${Date.now()}`,
    type: body.type || 'MANUAL',
    runway: body.runway || 'ALL',
    level: body.level || 'CAUTION',
    message: body.message || '수동 경보 발령',
    time: new Date().toLocaleTimeString('ko-KR', { hour12: false }),
  }
  currentState.alerts.unshift(alert)
  currentState.eventLog.unshift({
    id: `e${Date.now()}`,
    ...alert,
  })

  // 해당 활주로 상태 업데이트
  if (body.runway !== 'ALL') {
    const rwy = currentState.runways.find(r => r.id === body.runway)
    if (rwy) rwy.status = body.level as string
  }

  return c.json({ success: true, alert })
})

// 활주로 상태 초기화
app.post('/api/clear/:runwayId', async (c) => {
  const runwayId = c.req.param('runwayId')
  const rwy = currentState.runways.find(r => r.id === runwayId)
  if (rwy) {
    rwy.status = 'SAFE'
    currentState.alerts = currentState.alerts.filter(a => a.runway !== runwayId)
    currentState.eventLog.unshift({
      id: `e${Date.now()}`,
      type: 'CLEAR',
      runway: runwayId,
      level: 'INFO',
      message: `${runwayId} 이상 해제 - SAFE 등급 복구`,
      time: new Date().toLocaleTimeString('ko-KR', { hour12: false }),
    })
  }
  return c.json({ success: true })
})

// 시뮬레이션 트리거
app.post('/api/simulate', async (c) => {
  const body = await c.req.json<{scenario: string}>()
  const scenario = body.scenario

  const scenarios: Record<string, () => void> = {
    fod: () => {
      currentState.runways[0].status = 'HOLD'
      currentState.eventLog.unshift({
        id: `e${Date.now()}`, type: 'FOD', runway: 'RWY15L/33R', level: 'HOLD',
        message: '⚠️ 긴급 - FOD 대형 이물질 감지! 드론 정밀 촬영 중', time: new Date().toLocaleTimeString('ko-KR', { hour12: false })
      })
    },
    bird: () => {
      currentState.runways[1].status = 'CAUTION'
      currentState.eventLog.unshift({
        id: `e${Date.now()}`, type: 'BIRD', runway: 'RWY15R/33L', level: 'CAUTION',
        message: '조류 떼(10마리 이상) 활주로 진입 - 조류 퇴치 조치 중', time: new Date().toLocaleTimeString('ko-KR', { hour12: false })
      })
    },
    ice: () => {
      currentState.runways[2].status = 'HOLD'
      currentState.weather.iceRisk = 'HIGH'
      currentState.sensors.thermal.iceRisk = 'HIGH'
      currentState.eventLog.unshift({
        id: `e${Date.now()}`, type: 'ICE', runway: 'RWY16L/34R', level: 'HOLD',
        message: '🧊 결빙 위험! 열화상 센서 이상 구역 감지 - 제설 차량 출동', time: new Date().toLocaleTimeString('ko-KR', { hour12: false })
      })
    },
    clear: () => {
      currentState.runways.forEach(r => r.status = 'SAFE')
      currentState.weather.iceRisk = 'LOW'
      currentState.sensors.thermal.iceRisk = 'LOW'
      currentState.alerts = []
      currentState.eventLog.unshift({
        id: `e${Date.now()}`, type: 'CLEAR', runway: 'ALL', level: 'INFO',
        message: '✅ 전체 활주로 안전 확인 완료 - ALL CLEAR', time: new Date().toLocaleTimeString('ko-KR', { hour12: false })
      })
    },
  }

  if (scenarios[scenario]) {
    scenarios[scenario]()
    return c.json({ success: true, scenario })
  }
  return c.json({ success: false, message: '알 수 없는 시나리오' }, 400)
})

// ─── 메인 HTML 페이지 ─────────────────────────────────────────────────
app.get('/', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI 올클리어 — 인천공항 활주로 통합 안전 플랫폼</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;700;900&family=JetBrains+Mono:wght@400;700&display=swap');
    * { font-family: 'Noto Sans KR', sans-serif; }
    .mono { font-family: 'JetBrains Mono', monospace; }

    body { background: #050d1a; color: #e2e8f0; }

    /* 글로우 효과 */
    .glow-safe    { box-shadow: 0 0 20px rgba(34,197,94,0.4), 0 0 40px rgba(34,197,94,0.15); }
    .glow-caution { box-shadow: 0 0 20px rgba(234,179,8,0.4), 0 0 40px rgba(234,179,8,0.15); }
    .glow-hold    { box-shadow: 0 0 20px rgba(239,68,68,0.5), 0 0 60px rgba(239,68,68,0.25); }

    .text-glow-safe    { text-shadow: 0 0 12px rgba(34,197,94,0.8); }
    .text-glow-caution { text-shadow: 0 0 12px rgba(234,179,8,0.8); }
    .text-glow-hold    { text-shadow: 0 0 12px rgba(239,68,68,0.9); }

    /* 배경 그리드 */
    .grid-bg {
      background-image: linear-gradient(rgba(0,255,255,0.03) 1px, transparent 1px),
                        linear-gradient(90deg, rgba(0,255,255,0.03) 1px, transparent 1px);
      background-size: 40px 40px;
    }

    /* 활주로 */
    .runway-strip {
      background: repeating-linear-gradient(
        90deg,
        #1e293b 0px, #1e293b 30px,
        #0f172a 30px, #0f172a 60px
      );
      border: 1px solid #334155;
      position: relative;
      overflow: hidden;
    }
    .runway-center-line {
      position: absolute;
      top: 50%;
      left: 0; right: 0;
      height: 2px;
      background: repeating-linear-gradient(90deg, #facc15 0, #facc15 20px, transparent 20px, transparent 40px);
      transform: translateY(-50%);
    }

    /* 펄스 애니메이션 */
    @keyframes pulse-safe    { 0%,100%{opacity:1} 50%{opacity:0.6} }
    @keyframes pulse-caution { 0%,100%{opacity:1} 50%{opacity:0.4} }
    @keyframes pulse-hold    { 0%,100%{opacity:1} 50%{opacity:0.2} }
    @keyframes scanline { 0%{transform:translateY(-100%)} 100%{transform:translateY(100vh)} }
    @keyframes blink { 0%,100%{opacity:1} 49%{opacity:1} 50%{opacity:0} }

    .animate-pulse-safe    { animation: pulse-safe    2s ease-in-out infinite; }
    .animate-pulse-caution { animation: pulse-caution 1.5s ease-in-out infinite; }
    .animate-pulse-hold    { animation: pulse-hold    0.8s ease-in-out infinite; }
    .animate-blink         { animation: blink         1s step-end infinite; }

    /* 카드 */
    .card {
      background: rgba(15,23,42,0.9);
      border: 1px solid rgba(51,65,85,0.6);
      backdrop-filter: blur(8px);
    }
    .card-header {
      background: rgba(30,41,59,0.8);
      border-bottom: 1px solid rgba(51,65,85,0.6);
    }

    /* 레이더 */
    @keyframes radar-sweep {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
    .radar-sweep {
      animation: radar-sweep 3s linear infinite;
      transform-origin: 50% 50%;
    }

    /* 스크롤바 */
    ::-webkit-scrollbar { width: 4px; }
    ::-webkit-scrollbar-track { background: #0f172a; }
    ::-webkit-scrollbar-thumb { background: #334155; border-radius: 2px; }

    /* 스캔라인 오버레이 */
    .scanline-overlay::after {
      content:'';
      position: absolute;
      top:0;left:0;right:0;
      height: 2px;
      background: rgba(0,255,255,0.1);
      animation: scanline 4s linear infinite;
      pointer-events: none;
    }
  </style>
</head>
<body class="grid-bg min-h-screen">

<!-- ═══ 상단 헤더 ═══════════════════════════════════════════════════ -->
<header class="sticky top-0 z-50" style="background:rgba(5,13,26,0.95);border-bottom:1px solid rgba(6,182,212,0.3);backdrop-filter:blur(12px)">
  <div class="max-w-screen-2xl mx-auto px-4 py-3 flex items-center justify-between">
    <div class="flex items-center gap-4">
      <div class="w-10 h-10 rounded-lg flex items-center justify-center" style="background:linear-gradient(135deg,#0ea5e9,#6366f1)">
        <i class="fas fa-plane text-white text-lg"></i>
      </div>
      <div>
        <div class="text-xl font-black tracking-tight" style="color:#38bdf8">AI 올클리어</div>
        <div class="text-xs text-slate-400 mono">INCHEON INTL AIRPORT · RUNWAY SAFETY PLATFORM v1.0</div>
      </div>
    </div>

    <div class="flex items-center gap-6">
      <!-- 현재 시각 -->
      <div class="text-center">
        <div id="clock" class="text-2xl font-bold mono" style="color:#38bdf8">--:--:--</div>
        <div class="text-xs text-slate-500">KST (UTC+9)</div>
      </div>

      <!-- 전체 상태 배지 -->
      <div id="overall-badge" class="px-6 py-2 rounded-lg font-black text-lg mono glow-safe" style="background:rgba(34,197,94,0.15);border:2px solid #22c55e;color:#22c55e">
        ● SAFE
      </div>

      <!-- 연결 상태 -->
      <div class="flex items-center gap-2 text-sm">
        <span class="w-2 h-2 rounded-full bg-green-400 animate-pulse"></span>
        <span class="text-slate-400 mono">LIVE</span>
      </div>
    </div>
  </div>
</header>

<!-- ═══ 경보 배너 ═══════════════════════════════════════════════════ -->
<div id="alert-banner" class="hidden">
  <div class="px-4 py-2 text-center font-bold text-sm animate-pulse-hold" style="background:rgba(239,68,68,0.2);border-bottom:1px solid #ef4444;color:#fca5a5">
    <i class="fas fa-exclamation-triangle mr-2"></i>
    <span id="alert-banner-text"></span>
  </div>
</div>

<div class="max-w-screen-2xl mx-auto px-4 py-4">

  <!-- ═══ 시나리오 시뮬레이션 버튼 ═══════════════════════════════════ -->
  <div class="card rounded-xl p-4 mb-4 flex flex-wrap items-center gap-3">
    <div class="text-sm font-semibold text-slate-400 mr-2">
      <i class="fas fa-flask mr-1" style="color:#a78bfa"></i> 시뮬레이션:
    </div>
    <button onclick="simulate('fod')" class="px-4 py-2 rounded-lg text-sm font-bold transition-all hover:scale-105" style="background:rgba(239,68,68,0.15);border:1px solid #ef4444;color:#fca5a5">
      <i class="fas fa-exclamation-circle mr-1"></i> FOD 이물질
    </button>
    <button onclick="simulate('bird')" class="px-4 py-2 rounded-lg text-sm font-bold transition-all hover:scale-105" style="background:rgba(234,179,8,0.15);border:1px solid #eab308;color:#fde047">
      <i class="fas fa-dove mr-1"></i> 조류 충돌
    </button>
    <button onclick="simulate('ice')" class="px-4 py-2 rounded-lg text-sm font-bold transition-all hover:scale-105" style="background:rgba(147,197,253,0.15);border:1px solid #93c5fd;color:#bfdbfe">
      <i class="fas fa-snowflake mr-1"></i> 결빙 위험
    </button>
    <button onclick="simulate('clear')" class="px-4 py-2 rounded-lg text-sm font-bold transition-all hover:scale-105" style="background:rgba(34,197,94,0.15);border:1px solid #22c55e;color:#86efac">
      <i class="fas fa-check-circle mr-1"></i> 전체 해제
    </button>
    <div class="ml-auto text-xs text-slate-500 mono">
      <i class="fas fa-info-circle mr-1"></i> 버튼을 눌러 실제 시나리오를 체험해보세요
    </div>
  </div>

  <!-- ═══ 메인 그리드 ═══════════════════════════════════════════════ -->
  <div class="grid grid-cols-12 gap-4">

    <!-- ── 좌측: 활주로 맵 (8칸) ──────────────────────────────────── -->
    <div class="col-span-12 lg:col-span-8">

      <!-- 활주로 맵 카드 -->
      <div class="card rounded-xl mb-4 overflow-hidden scanline-overlay" style="position:relative">
        <div class="card-header px-5 py-3 flex items-center justify-between">
          <div class="flex items-center gap-3">
            <i class="fas fa-map" style="color:#38bdf8"></i>
            <span class="font-bold text-slate-200">인천국제공항 활주로 현황</span>
            <span class="text-xs px-2 py-0.5 rounded mono" style="background:rgba(56,189,248,0.1);border:1px solid rgba(56,189,248,0.3);color:#38bdf8">ICAO: RKSI</span>
          </div>
          <span class="text-xs text-slate-500 mono">4 RUNWAYS MONITORED</span>
        </div>

        <div class="p-6" style="background:linear-gradient(180deg,rgba(5,13,26,0.9) 0%,rgba(15,23,42,0.7) 100%)">
          <!-- 공항 맵 SVG -->
          <div class="relative" style="height:320px">
            <svg viewBox="0 0 800 320" class="w-full h-full">
              <!-- 배경 -->
              <rect width="800" height="320" fill="rgba(15,23,42,0.5)" rx="8"/>

              <!-- 터미널 구역 -->
              <rect x="310" y="110" width="180" height="100" rx="6" fill="rgba(99,102,241,0.15)" stroke="rgba(99,102,241,0.4)" stroke-width="1"/>
              <text x="400" y="155" text-anchor="middle" fill="#a5b4fc" font-size="11" font-weight="bold">터미널 구역</text>
              <text x="400" y="172" text-anchor="middle" fill="#6366f1" font-size="9">T1 · T2</text>

              <!-- 유도로 -->
              <line x1="100" y1="160" x2="310" y2="160" stroke="rgba(251,191,36,0.3)" stroke-width="1" stroke-dasharray="6,4"/>
              <line x1="490" y1="160" x2="700" y2="160" stroke="rgba(251,191,36,0.3)" stroke-width="1" stroke-dasharray="6,4"/>

              <!-- RWY 15L/33R (최좌측) -->
              <g id="map-rwy-0">
                <rect x="60" y="20" width="60" height="280" rx="4" fill="rgba(30,41,59,0.8)" stroke="rgba(51,65,85,0.6)" stroke-width="1"/>
                <line x1="90" y1="20" x2="90" y2="300" stroke="rgba(250,204,21,0.4)" stroke-width="1" stroke-dasharray="10,8"/>
                <rect id="rwy-0-indicator" x="62" y="22" width="56" height="276" rx="3" fill="rgba(34,197,94,0.1)" stroke="#22c55e" stroke-width="1.5" opacity="0.8"/>
                <text x="90" y="13" text-anchor="middle" fill="#94a3b8" font-size="9" font-weight="bold">15L</text>
                <text x="90" y="315" text-anchor="middle" fill="#94a3b8" font-size="9" font-weight="bold">33R</text>
                <text id="rwy-0-status" x="90" y="165" text-anchor="middle" fill="#22c55e" font-size="10" font-weight="bold">SAFE</text>
              </g>

              <!-- RWY 15R/33L -->
              <g id="map-rwy-1">
                <rect x="160" y="20" width="60" height="280" rx="4" fill="rgba(30,41,59,0.8)" stroke="rgba(51,65,85,0.6)" stroke-width="1"/>
                <line x1="190" y1="20" x2="190" y2="300" stroke="rgba(250,204,21,0.4)" stroke-width="1" stroke-dasharray="10,8"/>
                <rect id="rwy-1-indicator" x="162" y="22" width="56" height="276" rx="3" fill="rgba(34,197,94,0.1)" stroke="#22c55e" stroke-width="1.5" opacity="0.8"/>
                <text x="190" y="13" text-anchor="middle" fill="#94a3b8" font-size="9" font-weight="bold">15R</text>
                <text x="190" y="315" text-anchor="middle" fill="#94a3b8" font-size="9" font-weight="bold">33L</text>
                <text id="rwy-1-status" x="190" y="165" text-anchor="middle" fill="#22c55e" font-size="10" font-weight="bold">SAFE</text>
              </g>

              <!-- RWY 16L/34R -->
              <g id="map-rwy-2">
                <rect x="540" y="20" width="60" height="280" rx="4" fill="rgba(30,41,59,0.8)" stroke="rgba(51,65,85,0.6)" stroke-width="1"/>
                <line x1="570" y1="20" x2="570" y2="300" stroke="rgba(250,204,21,0.4)" stroke-width="1" stroke-dasharray="10,8"/>
                <rect id="rwy-2-indicator" x="542" y="22" width="56" height="276" rx="3" fill="rgba(234,179,8,0.15)" stroke="#eab308" stroke-width="1.5" opacity="0.8"/>
                <text x="570" y="13" text-anchor="middle" fill="#94a3b8" font-size="9" font-weight="bold">16L</text>
                <text x="570" y="315" text-anchor="middle" fill="#94a3b8" font-size="9" font-weight="bold">34R</text>
                <text id="rwy-2-status" x="570" y="165" text-anchor="middle" fill="#eab308" font-size="10" font-weight="bold">CAUTION</text>
              </g>

              <!-- RWY 16R/34L -->
              <g id="map-rwy-3">
                <rect x="640" y="20" width="60" height="280" rx="4" fill="rgba(30,41,59,0.8)" stroke="rgba(51,65,85,0.6)" stroke-width="1"/>
                <line x1="670" y1="20" x2="670" y2="300" stroke="rgba(250,204,21,0.4)" stroke-width="1" stroke-dasharray="10,8"/>
                <rect id="rwy-3-indicator" x="642" y="22" width="56" height="276" rx="3" fill="rgba(34,197,94,0.1)" stroke="#22c55e" stroke-width="1.5" opacity="0.8"/>
                <text x="670" y="13" text-anchor="middle" fill="#94a3b8" font-size="9" font-weight="bold">16R</text>
                <text x="670" y="315" text-anchor="middle" fill="#94a3b8" font-size="9" font-weight="bold">34L</text>
                <text id="rwy-3-status" x="670" y="165" text-anchor="middle" fill="#22c55e" font-size="10" font-weight="bold">SAFE</text>
              </g>

              <!-- 레이더 원 -->
              <circle cx="400" cy="160" r="50" fill="none" stroke="rgba(56,189,248,0.1)" stroke-width="1"/>
              <circle cx="400" cy="160" r="100" fill="none" stroke="rgba(56,189,248,0.07)" stroke-width="1"/>
              <circle cx="400" cy="160" r="150" fill="none" stroke="rgba(56,189,248,0.05)" stroke-width="1"/>

              <!-- 레이더 스위프 -->
              <g class="radar-sweep" style="transform-box:fill-box">
                <line x1="400" y1="160" x2="400" y2="60" stroke="rgba(56,189,248,0.6)" stroke-width="1.5"/>
                <path d="M 400 160 L 400 60 A 100 100 0 0 1 450 185 Z" fill="rgba(56,189,248,0.05)"/>
              </g>

              <!-- 드론 아이콘 -->
              <g id="drone-icon">
                <circle cx="90" cy="80" r="6" fill="rgba(168,85,247,0.3)" stroke="#a855f7" stroke-width="1"/>
                <text x="90" y="84" text-anchor="middle" fill="#a855f7" font-size="7">✈</text>
              </g>
            </svg>
          </div>

          <!-- 활주로 상태 카드 목록 -->
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4" id="runway-cards">
            <!-- JS로 동적 생성 -->
          </div>
        </div>
      </div>

      <!-- 안전 지수 차트 + 이벤트 로그 -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">

        <!-- 안전 지수 차트 -->
        <div class="card rounded-xl overflow-hidden">
          <div class="card-header px-5 py-3 flex items-center gap-3">
            <i class="fas fa-chart-line" style="color:#34d399"></i>
            <span class="font-bold text-slate-200">통합 안전 지수</span>
            <span class="ml-auto text-xs text-slate-500 mono">최근 12시간</span>
          </div>
          <div class="p-4">
            <canvas id="safetyChart" height="160"></canvas>
          </div>
        </div>

        <!-- 이벤트 로그 -->
        <div class="card rounded-xl overflow-hidden">
          <div class="card-header px-5 py-3 flex items-center gap-3">
            <i class="fas fa-list-alt" style="color:#fb923c"></i>
            <span class="font-bold text-slate-200">이벤트 로그</span>
            <span id="event-count" class="ml-auto text-xs px-2 py-0.5 rounded-full mono" style="background:rgba(251,146,60,0.15);border:1px solid rgba(251,146,60,0.4);color:#fb923c">0건</span>
          </div>
          <div class="overflow-y-auto" style="max-height:200px" id="event-log">
            <!-- JS 동적 생성 -->
          </div>
        </div>

      </div>
    </div>

    <!-- ── 우측: 센서 & 기상 패널 (4칸) ───────────────────────────── -->
    <div class="col-span-12 lg:col-span-4 flex flex-col gap-4">

      <!-- 센서 상태 -->
      <div class="card rounded-xl overflow-hidden">
        <div class="card-header px-5 py-3 flex items-center gap-3">
          <i class="fas fa-satellite-dish" style="color:#a78bfa"></i>
          <span class="font-bold text-slate-200">센서 시스템 상태</span>
        </div>
        <div class="p-4 flex flex-col gap-3" id="sensor-panel">
          <!-- JS 동적 생성 -->
        </div>
      </div>

      <!-- 기상 정보 -->
      <div class="card rounded-xl overflow-hidden">
        <div class="card-header px-5 py-3 flex items-center gap-3">
          <i class="fas fa-cloud-sun" style="color:#38bdf8"></i>
          <span class="font-bold text-slate-200">기상 현황</span>
          <span class="ml-auto text-xs text-slate-500">기상청 연동</span>
        </div>
        <div class="p-4" id="weather-panel">
          <!-- JS 동적 생성 -->
        </div>
      </div>

      <!-- AI 판정 엔진 -->
      <div class="card rounded-xl overflow-hidden">
        <div class="card-header px-5 py-3 flex items-center gap-3">
          <i class="fas fa-brain" style="color:#f472b6"></i>
          <span class="font-bold text-slate-200">AI 판정 엔진</span>
          <span class="ml-auto flex items-center gap-1 text-xs" style="color:#4ade80">
            <span class="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse inline-block"></span>
            가동 중
          </span>
        </div>
        <div class="p-4 space-y-3" id="ai-panel">
          <div class="text-xs text-slate-400 mb-2">분석 항목별 신뢰도</div>
          <!-- FOD -->
          <div>
            <div class="flex justify-between text-xs mb-1">
              <span class="text-slate-300"><i class="fas fa-exclamation-triangle mr-1" style="color:#fb923c"></i>FOD 탐지 (CNN)</span>
              <span class="mono" style="color:#fb923c">96.2%</span>
            </div>
            <div class="w-full rounded-full h-1.5" style="background:#1e293b">
              <div class="h-1.5 rounded-full" style="width:96%;background:linear-gradient(90deg,#f97316,#fb923c)"></div>
            </div>
          </div>
          <!-- 조류 -->
          <div>
            <div class="flex justify-between text-xs mb-1">
              <span class="text-slate-300"><i class="fas fa-dove mr-1" style="color:#facc15"></i>조류 감지 (YOLO)</span>
              <span class="mono" style="color:#facc15">94.8%</span>
            </div>
            <div class="w-full rounded-full h-1.5" style="background:#1e293b">
              <div class="h-1.5 rounded-full" style="width:95%;background:linear-gradient(90deg,#eab308,#facc15)"></div>
            </div>
          </div>
          <!-- 결빙 -->
          <div>
            <div class="flex justify-between text-xs mb-1">
              <span class="text-slate-300"><i class="fas fa-snowflake mr-1" style="color:#93c5fd"></i>결빙 예측 (열화상)</span>
              <span class="mono" style="color:#93c5fd">91.5%</span>
            </div>
            <div class="w-full rounded-full h-1.5" style="background:#1e293b">
              <div class="h-1.5 rounded-full" style="width:91%;background:linear-gradient(90deg,#3b82f6,#93c5fd)"></div>
            </div>
          </div>
          <!-- 노면 -->
          <div>
            <div class="flex justify-between text-xs mb-1">
              <span class="text-slate-300"><i class="fas fa-road mr-1" style="color:#34d399"></i>노면 상태 분석</span>
              <span class="mono" style="color:#34d399">93.1%</span>
            </div>
            <div class="w-full rounded-full h-1.5" style="background:#1e293b">
              <div class="h-1.5 rounded-full" style="width:93%;background:linear-gradient(90deg,#10b981,#34d399)"></div>
            </div>
          </div>

          <div class="pt-2 border-t" style="border-color:rgba(51,65,85,0.5)">
            <div class="flex justify-between text-xs">
              <span class="text-slate-500">총 처리 이벤트</span>
              <span class="mono text-slate-300" id="ai-total-events">1,247</span>
            </div>
            <div class="flex justify-between text-xs mt-1">
              <span class="text-slate-500">오탐률</span>
              <span class="mono" style="color:#4ade80">0.3%</span>
            </div>
            <div class="flex justify-between text-xs mt-1">
              <span class="text-slate-500">평균 응답 시간</span>
              <span class="mono" style="color:#38bdf8">1.2s</span>
            </div>
          </div>
        </div>
      </div>

    </div>
  </div>
</div>

<!-- 알림 토스트 -->
<div id="toast" class="fixed bottom-6 right-6 z-50 hidden transition-all duration-300">
  <div class="px-5 py-3 rounded-xl font-semibold text-sm shadow-2xl flex items-center gap-3" id="toast-inner">
    <i id="toast-icon" class="fas fa-check-circle"></i>
    <span id="toast-msg"></span>
  </div>
</div>

<script>
// ── 상수 ──────────────────────────────────────────────────────────────
const STATUS_CONFIG = {
  SAFE:    { color: '#22c55e', bg: 'rgba(34,197,94,0.15)',   border: '#22c55e', label: '✓ SAFE',    glow: 'glow-safe',    icon: 'fa-check-circle' },
  CAUTION: { color: '#eab308', bg: 'rgba(234,179,8,0.15)',   border: '#eab308', label: '⚡ CAUTION', glow: 'glow-caution', icon: 'fa-exclamation-triangle' },
  HOLD:    { color: '#ef4444', bg: 'rgba(239,68,68,0.2)',    border: '#ef4444', label: '✗ HOLD',    glow: 'glow-hold',    icon: 'fa-ban' },
}

const SENSOR_LABELS = {
  drone:   { icon: 'fa-helicopter', label: '자율 드론', color: '#a855f7' },
  radar:   { icon: 'fa-broadcast-tower', label: 'X-band 레이더', color: '#38bdf8' },
  thermal: { icon: 'fa-thermometer-half', label: '열화상 카메라', color: '#f97316' },
  surface: { icon: 'fa-road', label: '노면 센서', color: '#34d399' },
}

const EVENT_ICONS = {
  FOD: { icon: 'fa-exclamation-circle', color: '#ef4444' },
  BIRD: { icon: 'fa-dove', color: '#eab308' },
  ICE: { icon: 'fa-snowflake', color: '#93c5fd' },
  SURFACE: { icon: 'fa-road', color: '#34d399' },
  SYSTEM: { icon: 'fa-cog', color: '#94a3b8' },
  CLEAR: { icon: 'fa-check-circle', color: '#22c55e' },
  MANUAL: { icon: 'fa-user', color: '#a78bfa' },
}

const LEVEL_COLORS = {
  HOLD: '#ef4444', CAUTION: '#eab308', INFO: '#64748b',
}

// ── 차트 초기화 ──────────────────────────────────────────────────────
let safetyChart
function initChart(data) {
  const ctx = document.getElementById('safetyChart').getContext('2d')
  const labels = Array.from({length:12}, (_,i) => {
    const h = new Date(); h.setHours(h.getHours()-11+i)
    return h.getHours().toString().padStart(2,'0')+':00'
  })
  safetyChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: '안전 지수',
        data,
        borderColor: '#22c55e',
        backgroundColor: 'rgba(34,197,94,0.08)',
        borderWidth: 2,
        pointRadius: 3,
        pointBackgroundColor: '#22c55e',
        tension: 0.4,
        fill: true,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color:'#64748b', font:{size:10} }, grid: { color:'rgba(51,65,85,0.3)' } },
        y: { min:0, max:100, ticks: { color:'#64748b', font:{size:10} }, grid: { color:'rgba(51,65,85,0.3)' } }
      }
    }
  })
}

// ── 렌더 함수 ─────────────────────────────────────────────────────────
function renderRunwayCards(runways) {
  const container = document.getElementById('runway-cards')
  container.innerHTML = runways.map((r, i) => {
    const cfg = STATUS_CONFIG[r.status] || STATUS_CONFIG.SAFE
    return \`
    <div class="rounded-lg p-3 \${cfg.glow} transition-all duration-500 cursor-pointer hover:scale-105"
         style="background:\${cfg.bg};border:1.5px solid \${cfg.border}"
         onclick="clearRunway('\${r.id}')">
      <div class="flex items-center justify-between mb-2">
        <span class="text-xs font-bold mono text-slate-300">\${r.name}</span>
        <i class="fas \${cfg.icon} text-sm" style="color:\${cfg.color}"></i>
      </div>
      <div class="text-base font-black mono \${r.status === 'SAFE' ? 'text-glow-safe' : r.status === 'CAUTION' ? 'text-glow-caution' : 'text-glow-hold'}" style="color:\${cfg.color}">\${cfg.label}</div>
      <div class="text-xs text-slate-500 mt-1">\${r.length}m × \${r.width}m</div>
    </div>\`
  }).join('')
}

function renderSensors(sensors) {
  const panel = document.getElementById('sensor-panel')
  panel.innerHTML = Object.entries(sensors).map(([key, val]) => {
    const meta = SENSOR_LABELS[key]
    const isActive = val.status === 'ACTIVE'
    let detail = ''
    if (key === 'drone')   detail = \`배터리 \${val.battery}% · 커버리지 \${val.coverage}%\`
    if (key === 'radar')   detail = \`범위 \${val.range} · 탐지 \${val.targets}개\`
    if (key === 'thermal') detail = \`온도 \${val.tempMin}~\${val.tempMax}°C · 결빙위험 \${val.iceRisk}\`
    if (key === 'surface') detail = \`마찰계수 \${val.friction} · 상태 \${val.moisture}\`
    return \`
    <div class="flex items-center gap-3 p-3 rounded-lg" style="background:rgba(30,41,59,0.6);border:1px solid rgba(51,65,85,0.4)">
      <div class="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style="background:rgba(\${hexToRgb(meta.color)},0.15)">
        <i class="fas \${meta.icon} text-sm" style="color:\${meta.color}"></i>
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center justify-between">
          <span class="text-sm font-semibold text-slate-200">\${meta.label}</span>
          <span class="text-xs px-2 py-0.5 rounded-full mono \${isActive ? 'text-green-400' : 'text-red-400'}" style="background:\${isActive ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)'};border:1px solid \${isActive ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}">
            \${isActive ? '● 정상' : '● 오프라인'}
          </span>
        </div>
        <div class="text-xs text-slate-500 mt-0.5 truncate">\${detail}</div>
      </div>
    </div>\`
  }).join('')
}

function renderWeather(w) {
  const iceColor = w.iceRisk === 'HIGH' ? '#ef4444' : w.iceRisk === 'MEDIUM' ? '#eab308' : '#22c55e'
  document.getElementById('weather-panel').innerHTML = \`
  <div class="grid grid-cols-2 gap-3">
    <div class="p-3 rounded-lg text-center" style="background:rgba(30,41,59,0.6);border:1px solid rgba(51,65,85,0.4)">
      <div class="text-2xl font-black mono" style="color:#38bdf8">\${w.temp}°C</div>
      <div class="text-xs text-slate-500 mt-1">기온</div>
    </div>
    <div class="p-3 rounded-lg text-center" style="background:rgba(30,41,59,0.6);border:1px solid rgba(51,65,85,0.4)">
      <div class="text-2xl font-black mono" style="color:#a78bfa">\${w.humidity}%</div>
      <div class="text-xs text-slate-500 mt-1">습도</div>
    </div>
    <div class="p-3 rounded-lg text-center" style="background:rgba(30,41,59,0.6);border:1px solid rgba(51,65,85,0.4)">
      <div class="text-lg font-bold mono" style="color:#fb923c">\${w.wind.speed}<span class="text-sm">kt</span></div>
      <div class="text-xs text-slate-500 mt-0.5">\${w.wind.direction}</div>
      <div class="text-xs text-slate-500">풍향/풍속</div>
    </div>
    <div class="p-3 rounded-lg text-center" style="background:rgba(30,41,59,0.6);border:1px solid rgba(51,65,85,0.4)">
      <div class="text-lg font-bold mono" style="color:#34d399">\${(w.visibility/1000).toFixed(1)}<span class="text-sm">km</span></div>
      <div class="text-xs text-slate-500 mt-0.5">시정</div>
    </div>
  </div>
  <div class="mt-3 p-3 rounded-lg flex items-center justify-between" style="background:rgba(30,41,59,0.6);border:1px solid rgba(51,65,85,0.4)">
    <div class="flex items-center gap-2">
      <i class="fas fa-snowflake" style="color:\${iceColor}"></i>
      <span class="text-sm text-slate-300">결빙 위험도</span>
    </div>
    <span class="font-bold mono text-sm" style="color:\${iceColor}">\${w.iceRisk}</span>
  </div>
  <div class="mt-2 p-3 rounded-lg flex items-center justify-between" style="background:rgba(30,41,59,0.6);border:1px solid rgba(51,65,85,0.4)">
    <div class="flex items-center gap-2">
      <i class="fas fa-cloud-sun" style="color:#38bdf8"></i>
      <span class="text-sm text-slate-300">날씨</span>
    </div>
    <span class="font-bold text-sm" style="color:#94a3b8">\${w.condition}</span>
  </div>\`
}

function renderEventLog(events) {
  document.getElementById('event-count').textContent = events.length + '건'
  document.getElementById('event-log').innerHTML = events.slice(0, 15).map(e => {
    const meta = EVENT_ICONS[e.type] || EVENT_ICONS.SYSTEM
    const lvlColor = LEVEL_COLORS[e.level] || '#64748b'
    return \`
    <div class="px-4 py-2.5 border-b flex items-start gap-3" style="border-color:rgba(51,65,85,0.3)">
      <div class="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5" style="background:rgba(\${hexToRgb(meta.color)},0.15)">
        <i class="fas \${meta.icon} text-xs" style="color:\${meta.color}"></i>
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 mb-0.5">
          <span class="text-xs px-1.5 rounded mono" style="background:rgba(\${hexToRgb(lvlColor)},0.15);color:\${lvlColor}">\${e.level}</span>
          <span class="text-xs text-slate-500 mono">\${e.runway}</span>
          <span class="ml-auto text-xs text-slate-600 mono">\${e.time}</span>
        </div>
        <div class="text-xs text-slate-300 leading-relaxed">\${e.message}</div>
      </div>
    </div>\`
  }).join('')
}

function updateMapRunways(runways) {
  const colors = { SAFE: '#22c55e', CAUTION: '#eab308', HOLD: '#ef4444' }
  const fills  = { SAFE: 'rgba(34,197,94,0.1)', CAUTION: 'rgba(234,179,8,0.15)', HOLD: 'rgba(239,68,68,0.2)' }
  runways.forEach((r, i) => {
    const ind = document.getElementById(\`rwy-\${i}-indicator\`)
    const txt = document.getElementById(\`rwy-\${i}-status\`)
    if (ind) { ind.setAttribute('fill', fills[r.status] || fills.SAFE); ind.setAttribute('stroke', colors[r.status] || colors.SAFE) }
    if (txt) { txt.setAttribute('fill', colors[r.status] || colors.SAFE); txt.textContent = r.status }
  })
}

function updateOverallBadge(status) {
  const badge = document.getElementById('overall-badge')
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.SAFE
  badge.style.background = cfg.bg
  badge.style.border = \`2px solid \${cfg.border}\`
  badge.style.color = cfg.color
  badge.className = 'px-6 py-2 rounded-lg font-black text-lg mono ' + cfg.glow
  badge.textContent = cfg.label
}

function updateAlertBanner(alerts) {
  const banner = document.getElementById('alert-banner')
  if (alerts && alerts.length > 0) {
    document.getElementById('alert-banner-text').textContent = \`⚠ 활성 경보 \${alerts.length}건: \${alerts[0].message}\`
    banner.classList.remove('hidden')
  } else {
    banner.classList.add('hidden')
  }
}

// ── 유틸 ────────────────────────────────────────────────────────────
function hexToRgb(hex) {
  const r = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex)
  return r ? \`\${parseInt(r[1],16)},\${parseInt(r[2],16)},\${parseInt(r[3],16)}\` : '255,255,255'
}

function showToast(msg, type = 'success') {
  const toast = document.getElementById('toast')
  const inner = document.getElementById('toast-inner')
  const icon  = document.getElementById('toast-icon')
  const text  = document.getElementById('toast-msg')
  const styles = {
    success: { bg:'rgba(34,197,94,0.2)',  border:'1px solid #22c55e', color:'#86efac', icon:'fa-check-circle' },
    warning: { bg:'rgba(234,179,8,0.2)',  border:'1px solid #eab308', color:'#fde047', icon:'fa-exclamation-triangle' },
    error:   { bg:'rgba(239,68,68,0.2)',  border:'1px solid #ef4444', color:'#fca5a5', icon:'fa-times-circle' },
  }
  const s = styles[type] || styles.success
  inner.style.cssText = \`background:\${s.bg};border:\${s.border};color:\${s.color}\`
  icon.className = 'fas ' + s.icon
  text.textContent = msg
  toast.classList.remove('hidden')
  setTimeout(() => toast.classList.add('hidden'), 3000)
}

// ── 시계 ─────────────────────────────────────────────────────────────
function updateClock() {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('ko-KR', {hour12:false})
}
setInterval(updateClock, 1000)
updateClock()

// ── 메인 데이터 루프 ──────────────────────────────────────────────────
let chartData = []
async function fetchAndRender() {
  try {
    const res = await fetch('/api/status')
    const data = await res.json()

    renderRunwayCards(data.runways)
    renderSensors(data.sensors)
    renderWeather(data.weather)
    renderEventLog(data.eventLog)
    updateMapRunways(data.runways)
    updateOverallBadge(data.overall)
    updateAlertBanner(data.alerts)

    if (safetyChart && data.safetyIndex) {
      safetyChart.data.datasets[0].data = data.safetyIndex
      safetyChart.update('none')
    }
  } catch(e) { console.error('fetch error', e) }
}

// ── 시뮬레이션 ───────────────────────────────────────────────────────
async function simulate(scenario) {
  const labels = { fod: 'FOD 이물질 감지', bird: '조류 충돌 경보', ice: '결빙 위험 경보', clear: '전체 안전 해제' }
  const types  = { fod: 'error', bird: 'warning', ice: 'warning', clear: 'success' }
  try {
    await fetch('/api/simulate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({scenario}) })
    showToast('시나리오 실행: ' + (labels[scenario] || scenario), types[scenario] || 'success')
    fetchAndRender()
  } catch(e) { showToast('시뮬레이션 오류', 'error') }
}

// ── 활주로 해제 ──────────────────────────────────────────────────────
async function clearRunway(runwayId) {
  try {
    await fetch(\`/api/clear/\${encodeURIComponent(runwayId)}\`, { method:'POST' })
    showToast(\`\${runwayId} 이상 해제 완료\`, 'success')
    fetchAndRender()
  } catch(e) {}
}

// ── 초기화 ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const res = await fetch('/api/status')
  const data = await res.json()
  initChart(data.safetyIndex || Array.from({length:12},()=>Math.floor(70+Math.random()*20)))
  fetchAndRender()
  setInterval(fetchAndRender, 5000)
})
</script>
</body>
</html>`)
})

export default app
