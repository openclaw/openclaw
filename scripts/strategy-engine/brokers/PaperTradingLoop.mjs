/**
 * PaperTradingLoop.mjs — 通用紙上交易循環
 * 接收任意 BrokerAdapter，跑統一的 paper trading 流程
 * 群益、OKX、IB、未來任何券商都用同一個 loop
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..", "..", "..");
const SNAPSHOT_DIR = path.join(ROOT, ".openclaw", "ui");

export class PaperTradingLoop {
  /**
   * @param {Object} opts
   * @param {import('./BrokerAdapter.mjs').BrokerAdapter} opts.adapter - 券商 adapter
   * @param {string[]} opts.symbols - 監控的商品列表
   * @param {number} opts.intervalMs - 輪詢間隔（毫秒）
   * @param {Function} [opts.onSignal] - 收到策略信號時的回調
   * @param {Function} [opts.onQuote] - 收到新報價時的回調
   */
  constructor(opts = {}) {
    this.adapter = opts.adapter;
    this.symbols = opts.symbols ?? [];
    this.intervalMs = opts.intervalMs ?? 5000;
    this.onSignal = opts.onSignal ?? null;
    this.onQuote = opts.onQuote ?? null;
    this._running = false;
    this._stats = {
      cycles: 0,
      quotes: 0,
      signals: 0,
      fills: 0,
      startedAt: null,
      lastCycleAt: null,
      errors: 0,
      consecutiveErrors: 0,
    };
  }

  async start() {
    this._running = true;
    this._stats.startedAt = new Date().toISOString();
    console.log(
      `[PaperLoop:${this.adapter.name}] 啟動，${this.symbols.length} 商品，間隔 ${this.intervalMs}ms`,
    );

    while (this._running) {
      try {
        await this._cycle();
        this._stats.consecutiveErrors = 0;
      } catch (e) {
        this._stats.errors++;
        this._stats.consecutiveErrors++;
        console.error(`[PaperLoop:${this.adapter.name}] 循環錯誤: ${e.message}`);
        // 連續錯誤過多時降速
        if (this._stats.consecutiveErrors > 5) {
          await new Promise((r) => setTimeout(r, 30000));
        }
      }
      await new Promise((r) => setTimeout(r, this.intervalMs));
    }
  }

  stop() {
    this._running = false;
    console.log(`[PaperLoop:${this.adapter.name}] 停止，共 ${this._stats.cycles} 循環`);
  }

  async _cycle() {
    this._stats.cycles++;
    this._stats.lastCycleAt = new Date().toISOString();

    // 1. 檢查 adapter 健康
    const healthy = await this.adapter.isHealthy();
    if (!healthy) {
      console.log(`[PaperLoop:${this.adapter.name}] adapter 不健康，跳過此循環`);
      return;
    }

    // 2. 拉報價
    for (const symbol of this.symbols) {
      try {
        const quote = await this.adapter.getQuote(symbol);
        this._stats.quotes++;
        if (this.onQuote) {
          await this.onQuote(quote, this.adapter);
        }
      } catch {
        // 單商品失敗不中斷整個循環
      }
    }

    // 3. 寫入學習快照（每 10 循環）
    if (this._stats.cycles % 10 === 0) {
      await this._writeSnapshot();
    }
  }

  /** 取得統計 */
  getStats() {
    return {
      adapter: this.adapter.toJSON(),
      symbols: this.symbols,
      ...this._stats,
      running: this._running,
    };
  }

  /** 寫入快照到 .openclaw/ui/ */
  async _writeSnapshot() {
    const snapshot = {
      schema: `openclaw.paper-loop.${this.adapter.name}.v1`,
      generatedAt: new Date().toISOString(),
      adapter: this.adapter.toJSON(),
      stats: this._stats,
      positions: await this.adapter.getPositions(),
      symbols: this.symbols,
    };
    try {
      await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
      const fp = path.join(SNAPSHOT_DIR, `paper-loop-${this.adapter.name}-state.json`);
      await fs.writeFile(fp, JSON.stringify(snapshot, null, 2), "utf-8");
    } catch {}
  }
}
