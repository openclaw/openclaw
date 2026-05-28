// ArbitrageEngine.mjs — 套利引擎
// 管理所有套利策略的生命週期：
//   - ArbitrageBase 子類：訂閱兩條腿的 DataFeed bar 事件
//   - 掃描型（CrossExchange / Triangular）：每 scanMs 毫秒主動掃描
//   - 信號路由到 OrderRouter（雙腿同時下單）
import { appendFileSync } from "node:fs";

const ARB_SIGNAL_LOG = "D:\\群益及元大API\\CapitalHftService\\state\\hft_arb_signals.jsonl";

export class ArbitrageEngine {
  constructor(config, dataFeed, orderRouter) {
    this.config = config;
    this.feed = dataFeed;
    this.router = orderRouter;
    this.strategies = [];
    this._scanMs = config.scanMs ?? 2000;
    this._running = false;
  }

  addStrategy(strat) {
    this.strategies.push(strat);

    // ArbitrageBase 子類：訂閱 DataFeed
    if (strat.legA && strat.legB) {
      this.feed.subscribe(strat.legA.instrument, strat.legA.broker, (ev) => {
        if (ev.type === "bar") {
          strat.onBarA?.(ev.bar);
        }
      });
      this.feed.subscribe(strat.legB.instrument, strat.legB.broker, (ev) => {
        if (ev.type === "bar") {
          strat.onBarB?.(ev.bar);
        }
      });
      console.log(`  ARB  : ${strat.name} | ${strat.legA.instrument} ↔ ${strat.legB.instrument}`);
    } else {
      // 掃描型
      console.log(`  ARB  : ${strat.name} [scan mode]`);
    }
  }

  async start() {
    this._running = true;
    console.log(`[ArbitrageEngine] ${this.strategies.length} 套利策略啟動`);
    void this._loop();
  }

  stop() {
    this._running = false;
  }

  async _loop() {
    while (this._running) {
      this.feed.pollCapital?.();

      for (const strat of this.strategies) {
        if (!strat.enabled) {
          continue;
        }

        // 掃描型（CrossExchange / Triangular）
        if (typeof strat.scan === "function") {
          await strat.scan();
        }

        // 收集信號
        const signals = strat.popSignals?.() ?? [];
        for (const sig of signals) {
          this._logSignal(sig);
          if (sig.autoExecute || this.config.forceAutoAll) {
            await this._routeSpread(sig);
          } else {
            this._printSignal(sig);
          }
        }
      }

      await new Promise((r) => setTimeout(r, this._scanMs));
    }
  }

  async _routeSpread(sig) {
    if (sig.type === "spread") {
      // 同時路由兩條腿
      await Promise.all([
        this.router.routeSignal({
          ...sig.legA,
          strategy: sig.strategy,
          reason: sig.reason,
          autoExecute: sig.autoExecute,
        }),
        this.router.routeSignal({
          ...sig.legB,
          strategy: sig.strategy,
          reason: sig.reason,
          autoExecute: sig.autoExecute,
        }),
      ]);
    } else if (sig.type === "triangular") {
      // 三角套利三條腿序列執行（需快速）
      for (const leg of sig.legs ?? []) {
        await this.router.routeSignal({
          instrument: leg.symbol,
          broker: sig.broker ?? "okx",
          direction: leg.action,
          qty: sig.qty ?? 0.01,
          strategy: sig.strategy,
          reason: sig.reason,
          autoExecute: sig.autoExecute,
        });
      }
    }
  }

  _printSignal(sig) {
    if (sig.type === "spread") {
      console.log(`[ARB SIGNAL] ${sig.strategy} ${sig.direction}`);
      console.log(
        `  Leg A: ${sig.legA.direction.toUpperCase()} ${sig.legA.instrument} qty=${sig.legA.qty}`,
      );
      console.log(
        `  Leg B: ${sig.legB.direction.toUpperCase()} ${sig.legB.instrument} qty=${sig.legB.qty}`,
      );
      console.log(`  理由: ${sig.reason}`);
    } else if (sig.type === "triangular") {
      console.log(`[ARB SIGNAL] ${sig.strategy} 三角套利 profit=${(sig.profit * 100).toFixed(3)}%`);
      console.log(`  理由: ${sig.reason}`);
    }
  }

  _logSignal(sig) {
    try {
      appendFileSync(
        ARB_SIGNAL_LOG,
        JSON.stringify({ ...sig, loggedAt: new Date().toISOString() }) + "\n",
      );
    } catch {}
  }
}
