// DashboardServer.mjs — 即時策略監控 Web Dashboard (增強版)
// 使用 Express + Server-Sent Events (SSE) + 原生 HTML/CSS/JS
//
// 新增功能（v2）：
//   資本/回撤即時面板（RiskController 資料）
//   成交歷史 Tab（FillTracker 資料）
//   PnL 折線圖（SVG sparkline）
//   熱重載通知 Toast
//   /api/reload 手動觸發設定重載
//   /api/risk   RiskController 狀態

import { createServer } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const express = require("express");
const { WebSocketServer } = require("ws");

export class DashboardServer {
  /**
   * @param {object} opts
   * @param {number}  opts.port           HTTP 埠 (預設 3210)
   * @param {object}  opts.engine         StrategyEngine 實例 (可選)
   * @param {number}  opts.broadcastMs    心跳廣播間隔 ms (預設 2000)
   * @param {object}  opts.configWatcher  ConfigWatcher 實例（用於 /api/reload）
   */
  constructor(opts = {}) {
    this.port = opts.port ?? 3210;
    this.engine = opts.engine ?? null;
    this.broadcastMs = opts.broadcastMs ?? 2000;
    this.configWatcher = opts.configWatcher ?? null;

    // 內部狀態
    this._signalLog = []; // 最近 500 筆訊號
    this._fillLog = []; // 最近 200 筆成交
    this._positions = {}; // instrument → { qty, avgPrice, unrealizedPnl }
    this._dailyPnl = 0;
    this._totalPnl = 0;
    this._pnlHistory = []; // [{ ts, value }] 最近 120 筆（畫 sparkline 用）
    this._capital = {}; // RiskController 狀態快照
    this._startTime = Date.now();
    this._clients = new Set();

    this._app = express();
    this._server = createServer(this._app);
    this._wss = new WebSocketServer({ server: this._server });
    this._setupRoutes();
    this._setupWs();
  }

  // ── 外部推送 API ──────────────────────────────────────────────
  pushSignal(sig) {
    const entry = { ...sig, id: Date.now(), ts: sig.ts ?? new Date().toISOString() };
    this._signalLog.unshift(entry);
    if (this._signalLog.length > 500) {
      this._signalLog.pop();
    }
    this._broadcast({ type: "signal", data: entry });
  }

  pushFill(fill) {
    const entry = { ...fill, id: Date.now(), ts: fill.ts ?? new Date().toISOString() };
    this._fillLog.unshift(entry);
    if (this._fillLog.length > 200) {
      this._fillLog.pop();
    }
    this._broadcast({ type: "fill", data: entry });
  }

  pushPosition(instrument, qty, avgPrice, unrealizedPnl) {
    this._positions[instrument] = {
      qty,
      avgPrice: avgPrice ?? 0,
      unrealizedPnl: unrealizedPnl ?? 0,
    };
    this._broadcast({ type: "position", data: { instrument, qty, avgPrice, unrealizedPnl } });
  }

  pushPnl(daily, total) {
    this._dailyPnl = daily ?? 0;
    this._totalPnl = total ?? 0;
    // 累積 PnL 歷史（每次推送記錄一點）
    this._pnlHistory.push({ ts: Date.now(), value: this._totalPnl });
    if (this._pnlHistory.length > 120) {
      this._pnlHistory.shift();
    }
    this._broadcast({ type: "pnl", data: { daily: this._dailyPnl, total: this._totalPnl } });
  }

  pushAlert(message, level = "info") {
    const entry = { message, level, ts: new Date().toISOString() };
    this._broadcast({ type: "alert", data: entry });
  }

  /** 推送 RiskController 資本狀態 */
  pushCapital(rcStatus) {
    this._capital = { ...rcStatus, ts: new Date().toISOString() };
    this._broadcast({ type: "capital", data: this._capital });
  }

  /** 推送熱重載通知 */
  pushHotReload(diff) {
    const summary = `熱重載 +${diff.added.length}新增 -${diff.removed.length}移除 ~${diff.updated.length}更新`;
    this._broadcast({ type: "hot_reload", data: { summary, diff, ts: diff.ts } });
    this.pushAlert(summary, "info");
  }

  // ── 路由 ──────────────────────────────────────────────────────
  _setupRoutes() {
    const app = this._app;
    app.use(express.json());

    // 主頁
    app.get("/", (req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(this._buildHtml());
    });

    // SSE
    app.get("/stream", (req, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.flushHeaders();

      // 初始快照
      this._sendSse(res, {
        type: "snapshot",
        data: {
          signals: this._signalLog.slice(0, 50),
          fills: this._fillLog.slice(0, 30),
          positions: this._positions,
          pnl: { daily: this._dailyPnl, total: this._totalPnl },
          pnlHistory: this._pnlHistory,
          strategies: this._getStrategiesList(),
          capital: this._capital,
          uptime: Math.floor((Date.now() - this._startTime) / 1000),
        },
      });

      this._clients.add(res);
      req.on("close", () => this._clients.delete(res));
    });

    // REST
    app.get("/api/signals", (req, res) => res.json(this._signalLog.slice(0, 100)));
    app.get("/api/fills", (req, res) => res.json(this._fillLog.slice(0, 100)));
    app.get("/api/positions", (req, res) => res.json(this._positions));
    app.get("/api/strategies", (req, res) => res.json(this._getStrategiesList()));
    app.get("/api/capital", (req, res) => res.json(this._capital));
    app.get("/api/pnl-history", (req, res) => res.json(this._pnlHistory));
    app.get("/api/health", (req, res) =>
      res.json({
        uptime: Math.floor((Date.now() - this._startTime) / 1000),
        signals: this._signalLog.length,
        fills: this._fillLog.length,
        positions: Object.keys(this._positions).length,
        clients: this._clients.size,
        dailyPnl: this._dailyPnl,
        totalPnl: this._totalPnl,
        strategies: this.engine?.strategies?.length ?? 0,
        running: this.engine?._running ?? false,
      }),
    );

    // 策略控制
    app.post("/api/strategy/:name/enable", (req, res) => {
      this._setStrategyEnabled(req.params.name, true);
      res.json({ ok: true, name: req.params.name, enabled: true });
    });
    app.post("/api/strategy/:name/disable", (req, res) => {
      this._setStrategyEnabled(req.params.name, false);
      res.json({ ok: true, name: req.params.name, enabled: false });
    });

    // 熱重載觸發
    app.post("/api/reload", (req, res, next) => {
      void Promise.resolve()
        .then(async () => {
          if (!this.configWatcher) {
            res.status(503).json({ error: "ConfigWatcher 未掛載" });
            return;
          }
          const diff = await this.configWatcher.forceReload();
          if (diff) {
            res.json({ ok: true, diff });
          } else {
            res.json({ ok: false, message: "無變動或解析失敗" });
          }
        })
        .catch(next);
    });

    // RiskController 手動恢復
    app.post("/api/risk/resume", (req, res) => {
      const rc = this.engine?.riskController;
      if (!rc) {
        res.status(503).json({ error: "RiskController 未掛載" });
        return;
      }
      rc.resume();
      this.pushAlert("RiskController 已手動恢復", "info");
      res.json({ ok: true });
    });
  }

  _setupWs() {
    this._wss.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "connected", ts: new Date().toISOString() }));
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.type === "ping") {
            ws.send(JSON.stringify({ type: "pong" }));
          }
        } catch {}
      });
    });
  }

  _broadcast(payload) {
    const json = JSON.stringify(payload);
    for (const res of this._clients) {
      this._sendSse(res, payload);
    }
    for (const ws of this._wss.clients) {
      if (ws.readyState === 1) {
        ws.send(json);
      }
    }
  }

  _sendSse(res, payload) {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {}
  }

  _getStrategiesList() {
    if (!this.engine) {
      return [];
    }
    return this.engine.strategies.map((s) => ({
      name: s.name,
      instrument: s.instrument,
      broker: s.broker,
      enabled: s._enabled,
      auto: s.autoExecute,
      params: s.params,
    }));
  }

  _setStrategyEnabled(name, enabled) {
    const strat = this.engine?.strategies.find((s) => s.name === name);
    if (strat) {
      if (enabled) {
        strat.enable();
      } else {
        strat.disable();
      }
    }
    this._broadcast({ type: "strategy_update", data: { name, enabled } });
  }

  // ── 啟動 ──────────────────────────────────────────────────────
  start() {
    this._server.listen(this.port, () => {
      console.log(`[Dashboard] 🖥️  http://localhost:${this.port}`);
    });

    // 心跳 + RiskController 同步
    this._timer = setInterval(() => {
      // 心跳
      this._broadcast({
        type: "heartbeat",
        data: {
          uptime: Math.floor((Date.now() - this._startTime) / 1000),
          clients: this._clients.size,
          signals: this._signalLog.length,
          fills: this._fillLog.length,
          memMb: +(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1),
        },
      });

      // 同步 RiskController 狀態
      const rc = this.engine?.riskController;
      if (rc) {
        const st = rc.status();
        this.pushCapital({
          capital: st.capital,
          dailyPnl: st.dailyPnl,
          drawdownPct: st.drawdownPct,
          killed: st.killed,
          blockedCount: st.blockedCount,
        });
      }

      // 同步 FillTracker 部位未實現損益
      const ft = this.engine?.fillTracker;
      if (ft) {
        const positions = ft.getPositions();
        for (const [inst, pos] of Object.entries(positions)) {
          if (pos.qty !== 0) {
            this.pushPosition(inst, pos.qty, pos.avgPrice, pos.unrealizedPnl ?? 0);
          }
        }
      }
    }, this.broadcastMs);
  }

  stop() {
    clearInterval(this._timer);
    this._server.close();
    console.log("[Dashboard] 已關閉");
  }

  // ── 增強版 HTML ────────────────────────────────────────────────
  _buildHtml() {
    return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenClaw Dashboard</title>
<style>
  :root {
    --bg:#0d1117;--surface:#161b22;--surface2:#1c2128;--border:#30363d;
    --text:#c9d1d9;--muted:#8b949e;--green:#3fb950;--red:#f85149;
    --yellow:#d29922;--blue:#58a6ff;--purple:#bc8cff;--orange:#f0883e;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;font-size:13px;height:100vh;overflow:hidden;display:flex;flex-direction:column}
  /* Header */
  header{background:var(--surface);border-bottom:1px solid var(--border);padding:10px 20px;display:flex;align-items:center;gap:12px;flex-shrink:0}
  header h1{font-size:15px;color:var(--blue);font-weight:700;letter-spacing:-0.02em}
  .badge{padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600}
  .badge-green{background:#122213;color:var(--green)}
  .badge-red{background:#2d1117;color:var(--red)}
  .badge-yellow{background:#2d2208;color:var(--yellow)}
  #hdr-right{margin-left:auto;display:flex;align-items:center;gap:10px;font-size:11px;color:var(--muted)}
  /* Toast */
  #toast{position:fixed;top:56px;right:16px;z-index:999;display:flex;flex-direction:column;gap:6px;pointer-events:none}
  .toast-item{padding:8px 14px;border-radius:6px;font-size:12px;animation:fadeIn .2s ease;max-width:320px;word-break:break-all}
  .toast-info{background:#0d2137;color:var(--blue);border:1px solid #1a4060}
  .toast-warn{background:#2d1f08;color:var(--yellow);border:1px solid #5a3e10}
  .toast-crit{background:#2d1117;color:var(--red);border:1px solid #5a2020}
  .toast-reload{background:#0d2830;color:#56d364;border:1px solid #1a5040}
  @keyframes fadeIn{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}
  /* Layout */
  .layout{display:flex;flex:1;overflow:hidden;gap:0}
  /* Stat bar */
  .stat-bar{display:grid;grid-template-columns:repeat(6,1fr);gap:1px;background:var(--border);border-bottom:1px solid var(--border);flex-shrink:0}
  .stat-cell{background:var(--surface2);padding:8px 12px}
  .stat-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px}
  .stat-val{font-size:18px;font-weight:700}
  .pos{color:var(--green)}.neg{color:var(--red)}.neutral{color:var(--text)}
  .stat-sub{font-size:10px;color:var(--muted);margin-top:2px}
  /* Sidebar */
  .sidebar{width:260px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden;flex-shrink:0}
  .sidebar-section{border-bottom:1px solid var(--border);overflow:hidden;display:flex;flex-direction:column}
  .sidebar-title{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;padding:8px 12px 6px;flex-shrink:0;display:flex;align-items:center;justify-content:space-between}
  /* Strategies */
  #strat-list{overflow-y:auto;flex:1;min-height:0}
  .strat-row{display:flex;align-items:center;gap:6px;padding:5px 12px;border-bottom:1px solid #21262d}
  .strat-row:last-child{border:none}
  .strat-name{flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .strat-inst{color:var(--muted);font-size:10px;min-width:55px}
  .toggle-btn{padding:1px 8px;border-radius:3px;border:none;cursor:pointer;font-size:10px;font-weight:600}
  .toggle-on{background:#122213;color:var(--green)}
  .toggle-off{background:#2d1117;color:var(--red)}
  /* Positions */
  #pos-table-wrap{overflow-y:auto;flex:1;min-height:0}
  /* Risk panel */
  .risk-grid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--border);margin:0}
  .risk-cell{background:var(--surface2);padding:6px 10px}
  .risk-label{font-size:10px;color:var(--muted);margin-bottom:2px}
  .risk-val{font-size:13px;font-weight:600}
  /* Main area */
  .main{flex:1;display:flex;flex-direction:column;overflow:hidden}
  /* Tabs */
  .tabs{display:flex;border-bottom:1px solid var(--border);background:var(--surface);flex-shrink:0}
  .tab{padding:8px 16px;font-size:12px;cursor:pointer;color:var(--muted);border-bottom:2px solid transparent;transition:.15s}
  .tab.active{color:var(--blue);border-bottom-color:var(--blue)}
  .tab:hover:not(.active){color:var(--text)}
  .tab-content{display:none;flex:1;overflow:hidden;flex-direction:column}
  .tab-content.active{display:flex}
  /* Signal log */
  #signal-log{overflow-y:auto;flex:1;padding:4px 0}
  .sig-item{display:flex;gap:8px;align-items:flex-start;padding:5px 12px;border-bottom:1px solid #21262d}
  .sig-item:last-child{border:none}
  .dir-buy{color:var(--green);font-weight:700;font-size:11px;min-width:38px}
  .dir-sell{color:var(--red);font-weight:700;font-size:11px;min-width:38px}
  .dir-cls{color:var(--muted);font-weight:700;font-size:11px;min-width:38px}
  .sig-time{color:var(--muted);font-size:10px;min-width:52px;padding-top:1px}
  .sig-body{flex:1;line-height:1.4}
  .sig-strat{color:var(--blue);font-size:11px}
  .sig-reason{color:var(--muted);font-size:11px}
  /* Fill log */
  #fill-log{overflow-y:auto;flex:1;padding:4px 0}
  .fill-item{display:flex;gap:8px;align-items:center;padding:5px 12px;border-bottom:1px solid #21262d}
  .fill-pnl-pos{color:var(--green);font-size:11px;min-width:70px;text-align:right}
  .fill-pnl-neg{color:var(--red);font-size:11px;min-width:70px;text-align:right}
  .fill-pnl-zero{color:var(--muted);font-size:11px;min-width:70px;text-align:right}
  /* Chart */
  #chart-tab{padding:12px}
  svg.sparkline{width:100%;height:120px;overflow:visible}
  .spark-line{fill:none;stroke:var(--blue);stroke-width:1.5}
  .spark-area{fill:url(#spark-grad);opacity:.25}
  .chart-label{font-size:10px;fill:var(--muted)}
  /* Tables */
  table{width:100%;border-collapse:collapse}
  th{font-size:10px;color:var(--muted);text-align:left;padding:4px 8px;font-weight:500;background:var(--surface);position:sticky;top:0}
  td{padding:5px 8px;border-bottom:1px solid #21262d;font-size:12px}
  tr:last-child td{border:none}
  /* Reload btn */
  .reload-btn{padding:3px 10px;border-radius:4px;border:1px solid var(--border);background:var(--surface2);color:var(--text);cursor:pointer;font-size:11px}
  .reload-btn:hover{border-color:var(--blue);color:var(--blue)}
  /* Killed badge */
  .killed-banner{background:#2d1117;color:var(--red);border:1px solid #5a2020;padding:4px 12px;font-size:11px;display:flex;align-items:center;gap:8px}
  button.resume-btn{padding:2px 8px;background:var(--green);color:#000;border:none;border-radius:3px;cursor:pointer;font-size:11px;font-weight:700}
</style>
</head>
<body>
<header>
  <h1>🦞 OpenClaw</h1>
  <span id="conn-badge" class="badge badge-red">● 離線</span>
  <span id="kill-badge" style="display:none" class="badge badge-red">🔴 熔斷中</span>
  <span id="reload-badge" style="display:none" class="badge badge-yellow">♻ 熱重載</span>
  <div id="hdr-right">
    <span id="uptime">--:--:--</span>
    <span id="hdr-stats">訊號:0 | 成交:0 | 客:0</span>
    <button class="reload-btn" onclick="triggerReload()">⟳ 重載設定</button>
  </div>
</header>
<div id="kill-bar" style="display:none" class="killed-banner">
  ⚠️ RiskController 熔斷 — 自動停止交易
  <button class="resume-btn" onclick="resumeRisk()">手動恢復</button>
</div>
<div id="toast"></div>

<!-- Stat Bar -->
<div class="stat-bar">
  <div class="stat-cell"><div class="stat-label">今日損益</div><div class="stat-val neutral" id="daily-pnl">+0</div></div>
  <div class="stat-cell"><div class="stat-label">累計損益</div><div class="stat-val neutral" id="total-pnl">+0</div></div>
  <div class="stat-cell"><div class="stat-label">資本</div><div class="stat-val neutral" id="capital">--</div></div>
  <div class="stat-cell"><div class="stat-label">回撤</div><div class="stat-val neutral" id="drawdown">0%</div><div class="stat-sub" id="drawdown-sub"></div></div>
  <div class="stat-cell"><div class="stat-label">訊號 / 成交</div><div class="stat-val" id="counts" style="color:var(--blue)">0 / 0</div></div>
  <div class="stat-cell"><div class="stat-label">活躍部位</div><div class="stat-val neutral" id="pos-count">0</div></div>
</div>

<div class="layout">
  <!-- 左側欄 -->
  <div class="sidebar">
    <!-- Risk mini panel -->
    <div class="sidebar-section" style="flex-shrink:0">
      <div class="sidebar-title">⚡ 風控狀態</div>
      <div class="risk-grid" id="risk-grid">
        <div class="risk-cell"><div class="risk-label">每日P&L限額</div><div class="risk-val" id="rc-daily">--</div></div>
        <div class="risk-cell"><div class="risk-label">阻擋次數</div><div class="risk-val" id="rc-blocked">0</div></div>
      </div>
    </div>
    <!-- Positions -->
    <div class="sidebar-section" style="flex:0 0 auto;max-height:200px">
      <div class="sidebar-title">📂 部位</div>
      <div id="pos-table-wrap">
        <table>
          <thead><tr><th>商品</th><th>口</th><th>均價</th><th>未實現</th></tr></thead>
          <tbody id="pos-table"></tbody>
        </table>
        <div id="no-pos" style="color:var(--muted);font-size:12px;padding:8px 12px">無部位</div>
      </div>
    </div>
    <!-- Strategies -->
    <div class="sidebar-section" style="flex:1;min-height:0">
      <div class="sidebar-title">
        🤖 策略
        <span id="strat-count" style="color:var(--blue)">0</span>
      </div>
      <div id="strat-list"></div>
    </div>
  </div>

  <!-- 主區域 -->
  <div class="main">
    <div class="tabs">
      <div class="tab active" onclick="showTab('signals',this)">📡 訊號</div>
      <div class="tab" onclick="showTab('fills',this)">💰 成交</div>
      <div class="tab" onclick="showTab('chart',this)">📈 圖表</div>
    </div>

    <!-- 訊號 Tab -->
    <div id="tab-signals" class="tab-content active">
      <div id="signal-log"></div>
    </div>

    <!-- 成交 Tab -->
    <div id="tab-fills" class="tab-content">
      <div id="fill-log"></div>
    </div>

    <!-- 圖表 Tab -->
    <div id="tab-chart" class="tab-content">
      <div id="chart-tab">
        <div style="font-size:11px;color:var(--muted);margin-bottom:8px">累計損益曲線（最近 120 筆更新）</div>
        <svg class="sparkline" id="pnl-chart" viewBox="0 0 800 120" preserveAspectRatio="none">
          <defs>
            <linearGradient id="spark-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#58a6ff" stop-opacity=".4"/>
              <stop offset="100%" stop-color="#58a6ff" stop-opacity="0"/>
            </linearGradient>
          </defs>
          <line x1="0" y1="60" x2="800" y2="60" stroke="#30363d" stroke-width="1"/>
          <polyline class="spark-area" id="chart-area" points=""/>
          <polyline class="spark-line" id="chart-line" points=""/>
          <text class="chart-label" x="4" y="14" id="chart-max"></text>
          <text class="chart-label" x="4" y="118" id="chart-min"></text>
        </svg>
      </div>
    </div>
  </div>
</div>

<script>
// ── 工具 ──────────────────────────────────────────────────────────
const fmt  = v => (v >= 0 ? '+' : '') + Number(v).toLocaleString();
const cls  = v => v > 0 ? 'pos' : v < 0 ? 'neg' : 'neutral';
const ts2  = ts => ts ? ts.slice(11, 19) : '';

let signals = [], fills = [], positions = {}, strategies = [];
let pnlHistory = [], capital = {};

// ── Tab 切換 ──────────────────────────────────────────────────────
function showTab(name, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
  if (name === 'chart') renderChart();
}

// ── 渲染函數 ─────────────────────────────────────────────────────
function renderSignals() {
  const el = document.getElementById('signal-log');
  el.innerHTML = signals.slice(0, 80).map(s => {
    const d = s.direction ?? '';
    const dc = d==='buy'?'dir-buy':d==='sell'?'dir-sell':'dir-cls';
    const dl = d==='buy'?'▲ BUY':d==='sell'?'▼ SELL':
               d==='close_long'?'✕ CL':d==='close_short'?'✕ CS':(d||'--').toUpperCase();
    return \`<div class="sig-item">
      <span class="sig-time">\${ts2(s.ts)}</span>
      <span class="\${dc}">\${dl}</span>
      <span class="sig-body">
        <span class="sig-strat">\${s.strategy??''}</span>
        <span style="color:var(--text)"> \${s.instrument??''}</span>
        <span style="color:var(--muted)"> qty=\${s.qty??''}</span><br>
        <span class="sig-reason">\${s.reason??''}</span>
      </span>
    </div>\`;
  }).join('');
  document.getElementById('counts').textContent = signals.length + ' / ' + fills.length;
}

function renderFills() {
  const el = document.getElementById('fill-log');
  el.innerHTML = fills.slice(0, 80).map(f => {
    const d = f.direction??'';
    const dc = d==='buy'?'dir-buy':d==='sell'?'dir-sell':'dir-cls';
    const dl = d==='buy'?'▲ BUY':d==='sell'?'▼ SELL':
               d==='close_long'?'✕ CL':d==='close_short'?'✕ CS':(d||'--').toUpperCase();
    const pnl = f.pnl ?? 0;
    const pc = pnl>0?'fill-pnl-pos':pnl<0?'fill-pnl-neg':'fill-pnl-zero';
    return \`<div class="fill-item">
      <span class="sig-time">\${ts2(f.ts)}</span>
      <span class="\${dc}">\${dl}</span>
      <span class="sig-strat" style="min-width:90px">\${f.strategy??''}</span>
      <span style="color:var(--text);min-width:60px">\${f.instrument??''}</span>
      <span style="color:var(--muted)">qty=\${f.qty??''} @\${(f.fillPrice??0).toFixed?.(1)??f.fillPrice}</span>
      <span class="\${pc}">\${pnl!==0?fmt(pnl):''}</span>
    </div>\`;
  }).join('') || '<div style="color:var(--muted);padding:12px">無成交記錄</div>';
}

function renderPositions() {
  const keys = Object.keys(positions).filter(k => positions[k].qty !== 0);
  document.getElementById('no-pos').style.display = keys.length ? 'none' : 'block';
  document.getElementById('pos-count').textContent = keys.length;
  document.getElementById('pos-table').innerHTML = keys.map(k => {
    const p = positions[k];
    const upnl = p.unrealizedPnl ?? 0;
    const qcol = p.qty>0?'var(--green)':'var(--red)';
    return \`<tr>
      <td>\${k}</td>
      <td style="color:\${qcol}">\${p.qty}</td>
      <td>\${(p.avgPrice??0).toFixed?.(1)}</td>
      <td class="\${cls(upnl)}" style="font-size:11px">\${fmt(upnl)}</td>
    </tr>\`;
  }).join('');
}

function renderStrategies() {
  document.getElementById('strat-count').textContent = strategies.length;
  document.getElementById('strat-list').innerHTML = strategies.map(s => {
    const bcls = s.enabled ? 'toggle-on' : 'toggle-off';
    const btxt = s.enabled ? 'ON' : 'OFF';
    const pcls = s.params && Object.keys(s.params).length ? '' : 'display:none';
    const ptip = s.params ? Object.entries(s.params).map(([k,v])=>\`\${k}:\${v}\`).join(' ') : '';
    return \`<div class="strat-row" title="\${ptip}">
      <span class="strat-name">\${s.name}</span>
      <span class="strat-inst">\${s.instrument}</span>
      <button class="toggle-btn \${bcls}" onclick="toggleStrat('\${s.name}',\${!s.enabled})">\${btxt}</button>
    </div>\`;
  }).join('') || '<div style="color:var(--muted);font-size:11px;padding:8px 12px">無策略</div>';
}

function renderPnl(daily, total) {
  const dp = document.getElementById('daily-pnl');
  const tp = document.getElementById('total-pnl');
  dp.textContent = fmt(daily); dp.className = 'stat-val ' + cls(daily);
  tp.textContent = fmt(total); tp.className = 'stat-val ' + cls(total);
}

function renderCapital(cap) {
  if (!cap) return;
  if (cap.capital != null) {
    document.getElementById('capital').textContent = Number(cap.capital).toLocaleString();
  }
  if (cap.drawdownPct != null) {
    const dd = document.getElementById('drawdown');
    dd.textContent = cap.drawdownPct.toFixed(2) + '%';
    dd.className = 'stat-val ' + (cap.drawdownPct < -5 ? 'neg' : 'neutral');
  }
  if (cap.dailyPnl != null) {
    document.getElementById('rc-daily').textContent = fmt(cap.dailyPnl);
  }
  if (cap.blockedCount != null) {
    document.getElementById('rc-blocked').textContent = cap.blockedCount;
  }
  // 熔斷提示
  const killBar = document.getElementById('kill-bar');
  const killBadge = document.getElementById('kill-badge');
  if (cap.killed) {
    killBar.style.display = 'flex';
    killBadge.style.display = 'inline';
  } else {
    killBar.style.display = 'none';
    killBadge.style.display = 'none';
  }
}

function renderChart() {
  if (pnlHistory.length < 2) return;
  const vals  = pnlHistory.map(p => p.value);
  const minV  = Math.min(...vals);
  const maxV  = Math.max(...vals);
  const range = maxV - minV || 1;
  const W = 800, H = 120, PAD = 4;
  const x = (i) => PAD + (i / (vals.length - 1)) * (W - PAD * 2);
  const y = (v) => H - PAD - ((v - minV) / range) * (H - PAD * 2);

  const pts  = vals.map((v,i) => \`\${x(i).toFixed(1)},\${y(v).toFixed(1)}\`).join(' ');
  const area = \`\${x(0).toFixed(1)},\${H} \` + pts + \` \${x(vals.length-1).toFixed(1)},\${H}\`;

  document.getElementById('chart-line').setAttribute('points', pts);
  document.getElementById('chart-area').setAttribute('points', area);
  document.getElementById('chart-max').textContent = fmt(maxV);
  document.getElementById('chart-min').textContent = fmt(minV);

  // 零線顏色
  const zeroY = y(0);
  document.querySelector('.spark-line').style.stroke =
    vals[vals.length-1] >= 0 ? 'var(--green)' : 'var(--red)';
}

// ── Toast ─────────────────────────────────────────────────────────
function showToast(msg, type='info', ms=4000) {
  const c = document.getElementById('toast');
  const d = document.createElement('div');
  d.className = 'toast-item toast-' + type;
  d.textContent = msg;
  c.appendChild(d);
  setTimeout(() => d.remove(), ms);
}

// ── API actions ───────────────────────────────────────────────────
function toggleStrat(name, enable) {
  fetch(\`/api/strategy/\${encodeURIComponent(name)}/\${enable?'enable':'disable'}\`,{method:'POST'});
}

async function triggerReload() {
  const btn = document.querySelector('.reload-btn');
  const orig = btn.textContent;
  btn.textContent = '載入中…';
  try {
    const r = await fetch('/api/reload', {method:'POST'});
    const j = await r.json();
    if (j.ok) showToast('設定重載成功', 'reload', 5000);
    else showToast(j.message || '無變動', 'info');
  } catch(e) { showToast('重載失敗: ' + e.message, 'crit'); }
  btn.textContent = orig;
}

async function resumeRisk() {
  await fetch('/api/risk/resume', {method:'POST'});
  showToast('RiskController 已恢復', 'info');
}

// ── SSE ───────────────────────────────────────────────────────────
function connect() {
  const es = new EventSource('/stream');
  const badge = document.getElementById('conn-badge');

  es.onopen = () => {
    badge.textContent = '● 連線中'; badge.className = 'badge badge-green';
  };
  es.onerror = () => {
    badge.textContent = '● 離線'; badge.className = 'badge badge-red';
    es.close(); setTimeout(connect, 3000);
  };

  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    switch(msg.type) {
      case 'snapshot':
        signals    = msg.data.signals    ?? [];
        fills      = msg.data.fills      ?? [];
        positions  = msg.data.positions  ?? {};
        strategies = msg.data.strategies ?? [];
        pnlHistory = msg.data.pnlHistory ?? [];
        capital    = msg.data.capital    ?? {};
        renderPnl(msg.data.pnl?.daily??0, msg.data.pnl?.total??0);
        renderSignals(); renderFills(); renderPositions();
        renderStrategies(); renderCapital(capital); renderChart();
        break;
      case 'signal':
        signals.unshift(msg.data);
        if(signals.length>500) signals.pop();
        renderSignals();
        break;
      case 'fill':
        fills.unshift(msg.data);
        if(fills.length>200) fills.pop();
        renderFills();
        break;
      case 'position':
        positions[msg.data.instrument] = msg.data;
        renderPositions();
        break;
      case 'pnl':
        renderPnl(msg.data.daily, msg.data.total);
        break;
      case 'capital':
        capital = msg.data;
        renderCapital(capital);
        break;
      case 'alert':
        showToast(msg.data.message, msg.data.level==='warning'?'warn':msg.data.level==='critical'?'crit':'info');
        break;
      case 'hot_reload':
        showToast('♻ ' + msg.data.summary, 'reload', 6000);
        document.getElementById('reload-badge').style.display = 'inline';
        setTimeout(()=>document.getElementById('reload-badge').style.display='none', 5000);
        break;
      case 'strategy_update': {
        const s = strategies.find(x => x.name===msg.data.name);
        if(s) s.enabled = msg.data.enabled;
        renderStrategies();
        break;
      }
      case 'heartbeat': {
        const sec = msg.data.uptime??0;
        const h=String(Math.floor(sec/3600)).padStart(2,'0');
        const m=String(Math.floor((sec%3600)/60)).padStart(2,'0');
        const s=String(sec%60).padStart(2,'0');
        document.getElementById('uptime').textContent = h+':'+m+':'+s;
        document.getElementById('hdr-stats').textContent =
          \`訊號:\${msg.data.signals??0} | 成交:\${msg.data.fills??0} | 客:\${msg.data.clients??0} | \${msg.data.memMb??0}MB\`;
        break;
      }
    }
  };
}

connect();
</script>
</body>
</html>`;
  }
}
