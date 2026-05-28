// HftEngine.mjs — 高頻交易引擎
// 核心職責：
//   1. 毫秒級事件循環（預設 10ms）
//   2. 從多個數據源讀取 Tick / OrderBook
//   3. 分發給 HFT 策略（支援 onTick / onBook）
//   4. 所有信號先通過 RiskGuard 才交給注入 dispatcher
//   5. 延遲監控 & 統計報告
import { readFileSync, existsSync } from "node:fs";
import { OrderBookAnalyzer } from "./OrderBookAnalyzer.mjs";
import { RiskGuard } from "./RiskGuard.mjs";
import { TickBuffer } from "./TickBuffer.mjs";

const SNAP_FILE = "D:\\群益及元大API\\CapitalHftService\\state\\hft_quote_snapshot.json";
const TICK_FILE = "D:\\群益及元大API\\CapitalHftService\\state\\hft_tick_stream.jsonl";
const OKX_OB_FILE = "D:\\群益及元大API\\CapitalHftService\\state\\hft_okx_orderbook.json";

export class HftEngine {
  constructor(config, orderRouter) {
    this.config = config;
    this.router = orderRouter;
    this.loopMs = config.loopMs ?? 10; // 主循環間隔（ms）
    this.reportMs = config.reportMs ?? 5000; // 統計報告間隔
    this.dryRun = config.dryRun ?? true;
    this.eventSink = typeof config.eventSink === "function" ? config.eventSink : null;
    this.bookFeed = config.bookFeed ?? null;
    this._events = [];
    this._eventLimit = Number.isFinite(config.eventLimit) ? Math.max(1, config.eventLimit) : 1000;
    const legacyRouteMethod = ["route", "Signal"].join("");
    this._dispatchSignal =
      typeof config.dispatchSignal === "function"
        ? config.dispatchSignal
        : typeof orderRouter?.dispatchSignal === "function"
          ? (signal) => orderRouter.dispatchSignal(signal)
          : typeof orderRouter?.[legacyRouteMethod] === "function"
            ? (signal) => orderRouter[legacyRouteMethod](signal)
            : null;

    // 每個商品一個 TickBuffer + OrderBookAnalyzer
    this._buffers = {}; // instrument → TickBuffer
    this._analyzers = {}; // instrument → OrderBookAnalyzer

    this.riskGuard = new RiskGuard(config.risk ?? {});
    this.strategies = [];

    // 延遲監控
    this._latencies = [];
    this._signalCount = 0;
    this._blockedCount = 0;
    this._running = false;

    // 上次讀取的 tick 行數（增量讀取）
    this._tickFilePos = 0;
    this._lastSnapPrices = {};
    this._lastOkxOB = {};
  }

  addStrategy(strat) {
    this.strategies.push(strat);
    const inst = strat.instrument ?? strat.legA?.instrument;
    if (inst) {
      if (!this._buffers[inst]) {
        this._buffers[inst] = new TickBuffer(2000);
      }
      if (!this._analyzers[inst]) {
        this._analyzers[inst] = new OrderBookAnalyzer();
      }
    }
    console.log(`  HFT  : ${strat.name} @ ${inst ?? "multi"}`);
  }

  async start() {
    this._running = true;
    console.log(`[HftEngine] 高頻引擎啟動 loopMs=${this.loopMs} dryRun=${this.dryRun}`);
    if (this.riskGuard.isKilled) {
      this.riskGuard.resume();
    }
    void this._loop();
    this._reportInterval = setInterval(() => this._report(), this.reportMs);
  }

  stop() {
    this._running = false;
    if (this._reportInterval) {
      clearInterval(this._reportInterval);
      this._reportInterval = null;
    }
    this.bookFeed?.stop?.();
    this.riskGuard.destroy();
    console.log("[HftEngine] 已停止");
  }

  /** 緊急停止（殺單） */
  killSwitch(reason) {
    this.riskGuard.killSwitch(reason ?? "外部觸發");
    console.error("[HftEngine] ⛔ KILL SWITCH");
  }

  // ── 主循環 ───────────────────────────────────────
  async _loop() {
    while (this._running) {
      const t0 = Date.now();

      // 1. 更新行情
      this._pollCapitalSnap();
      this._pollTickFile();
      this._pollOkxOB();
      await this._pollInjectedBookFeed();

      // 2. 呼叫各策略
      for (const strat of this.strategies) {
        if (!strat.enabled) {
          continue;
        }
        const inst = strat.instrument ?? strat.legA?.instrument ?? "";
        const buf = this._buffers[inst];
        const analyzer = this._analyzers[inst];
        const latest = buf?.latest();

        // onTick
        if (typeof strat.onTick === "function" && latest) {
          strat.onTick(latest, analyzer);
        }
        // onBook
        if (typeof strat.onBook === "function" && analyzer) {
          strat.onBook(analyzer);
        }
      }

      // 3. 收集信號 → 風控 → 路由
      await this._processSignals();

      // 延遲測量
      const latency = Date.now() - t0;
      this._latencies.push(latency);
      if (this._latencies.length > 1000) {
        this._latencies.shift();
      }

      // 自適應睡眠（避免忙等）
      const sleep = Math.max(0, this.loopMs - latency);
      if (sleep > 0) {
        await new Promise((r) => setTimeout(r, sleep));
      }
    }
  }

  async _processSignals() {
    for (const strat of this.strategies) {
      const signals = strat.popSignals?.() ?? [];
      for (const sig of signals) {
        this._signalCount++;
        const check = this.riskGuard.check(sig);
        if (!check.ok) {
          this._blockedCount++;
          continue;
        }
        const logEntry = JSON.stringify({
          ...sig,
          checkedAt: new Date().toISOString(),
          dryRun: this.dryRun,
        });
        this._emitEvent("signal_checked", logEntry);

        if (sig.autoExecute && !this.dryRun && this._dispatchSignal) {
          await this._dispatchSignal(sig);
        } else {
          const icon = sig.direction.startsWith("close")
            ? "📤"
            : sig.direction === "buy"
              ? "📈"
              : "📉";
          console.log(
            `[HFT ${icon}] ${sig.strategy} | ${sig.direction.toUpperCase()} ${sig.instrument} qty=${sig.qty} | ${sig.reason}`,
          );
        }
      }
    }
  }

  _emitEvent(type, payload) {
    const event = { type, payload, time: new Date().toISOString() };
    this._events.push(event);
    if (this._events.length > this._eventLimit) {
      this._events.shift();
    }
    try {
      this.eventSink?.(event);
    } catch {}
  }

  get events() {
    return [...this._events];
  }

  // ── 數據輸入 ────────────────────────────────────
  _pollCapitalSnap() {
    if (!existsSync(SNAP_FILE)) {
      return;
    }
    try {
      const snap = JSON.parse(readFileSync(SNAP_FILE, "utf-8"));
      for (const [inst, price] of Object.entries(snap.prices ?? {})) {
        if (this._lastSnapPrices[inst] === price) {
          continue;
        }
        this._lastSnapPrices[inst] = price;
        const tick = {
          time: Date.now(),
          price: +price,
          qty: 1,
          side: "",
          ask: +price,
          bid: +price,
        };
        this._buffers[inst]?.push(tick);
        // 通知策略
        for (const strat of this.strategies) {
          if (strat.instrument === inst && typeof strat.onTick === "function") {
            strat.onTick(tick);
          }
        }
      }
    } catch {}
  }

  _pollTickFile() {
    if (!existsSync(TICK_FILE)) {
      return;
    }
    try {
      const content = readFileSync(TICK_FILE, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      if (lines.length <= this._tickFilePos) {
        return;
      }
      const newLines = lines.slice(this._tickFilePos);
      this._tickFilePos = lines.length;
      for (const line of newLines) {
        try {
          const t = JSON.parse(line);
          // { instrument, price, qty, side, ask, bid, time }
          const tick = {
            time: t.time ?? Date.now(),
            price: +t.price,
            qty: +(t.qty ?? 1),
            side: t.side ?? "",
            ask: +(t.ask ?? t.price),
            bid: +(t.bid ?? t.price),
          };
          this._buffers[t.instrument]?.push(tick);
        } catch {}
      }
    } catch {}
  }

  _pollOkxOB() {
    if (!existsSync(OKX_OB_FILE)) {
      return;
    }
    try {
      const ob = JSON.parse(readFileSync(OKX_OB_FILE, "utf-8"));
      // { instrument, bids:[[p,q],...], asks:[[p,q],...], time }
      for (const [inst, book] of Object.entries(ob)) {
        if (!this._analyzers[inst]) {
          this._analyzers[inst] = new OrderBookAnalyzer();
        }
        this._analyzers[inst].update(book);
      }
    } catch {}
  }

  async _pollInjectedBookFeed() {
    if (!this.bookFeed || typeof this.bookFeed.poll !== "function") {
      return;
    }
    try {
      const books = (await this.bookFeed.poll()) ?? {};
      for (const [inst, book] of Object.entries(books)) {
        if (!this._analyzers[inst]) {
          this._analyzers[inst] = new OrderBookAnalyzer();
        }
        this._analyzers[inst].update(book);
      }
    } catch (e) {
      this._emitEvent("book_feed_error", { message: e?.message ?? String(e) });
    }
  }

  // ── 統計報告 ────────────────────────────────────
  _report() {
    if (!this._latencies.length) {
      return;
    }
    const avg = this._latencies.reduce((a, b) => a + b, 0) / this._latencies.length;
    const max = Math.max(...this._latencies);
    const p99 = this._latencies.toSorted((a, b) => a - b)[
      Math.floor(this._latencies.length * 0.99)
    ];
    console.log(
      `[HftEngine] 信號=${this._signalCount} 攔截=${this._blockedCount} 每日PnL=${this.riskGuard.dailyPnl.toFixed(2)} 延遲avg=${avg.toFixed(1)}ms p99=${p99}msmax=${max}ms`,
    );
  }
}
