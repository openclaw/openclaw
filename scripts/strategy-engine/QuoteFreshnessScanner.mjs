/**
 * QuoteFreshnessScanner.mjs — all-scan 層分批輪詢引擎
 *
 * 功能：
 *   - 分批（batchSize=50）掃描全商品池的報價狀態
 *   - 每批間隔 scanIntervalMs 避免 API 過載
 *   - 產出 freshness matrix：requested / subscribed / fresh / stale / blocked
 *   - 不做即時 tick，只做 availability + liquidity 檢查
 *
 * 用途：
 *   - 確認哪些商品有報價權限
 *   - 確認哪些商品目前可交易
 *   - 確認哪些商品流動性足夠加入 strategy-universe
 *   - 產出升級/降級建議
 */
import { EventEmitter } from "node:events";

export class QuoteFreshnessScanner extends EventEmitter {
  constructor(quoteHub, opts = {}) {
    super();
    this._hub = quoteHub;
    this._batchSize = opts.batchSize ?? 50;
    this._intervalMs = opts.intervalMs ?? 60_000;
    this._running = false;
    this._timer = null;
    this._codes = [];
    this._cursor = 0;
    this._results = new Map(); // code → { status, lastPrice, lastAt, staleSince, reason }
    this._scanCount = 0;
  }

  /** 設定掃描清單 */
  setCodes(codes) {
    this._codes = [...codes];
    this._cursor = 0;
  }

  /** 啟動分批掃描 */
  start() {
    if (this._running) {
      return;
    }
    this._running = true;
    this._tick();
    this._timer = setInterval(() => this._tick(), this._intervalMs);
  }

  stop() {
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
    }
    this._timer = null;
  }

  /** 單批掃描 */
  _tick() {
    if (!this._running || this._codes.length === 0) {
      return;
    }

    const batch = [];
    for (let i = 0; i < this._batchSize && this._cursor < this._codes.length; i++) {
      batch.push(this._codes[this._cursor++]);
    }
    // 回捲
    if (this._cursor >= this._codes.length) {
      this._cursor = 0;
      this._scanCount++;
      this.emit("cycle-complete", { cycle: this._scanCount, total: this._codes.length });
    }

    const now = Date.now();
    const batchResults = [];

    for (const code of batch) {
      const quote = this._hub.getQuote(code);
      let status = "no_data";
      let reason = "";

      if (quote) {
        const age = now - (quote.updatedAt ?? 0);
        if (age < 300_000) {
          status = "fresh"; // < 5 分鐘
        } else if (age < 600_000) {
          status = "warm"; // 5-10 分鐘
        } else {
          status = "stale";
          reason = `age=${Math.round(age / 1000)}s`;
        }
      } else {
        status = "no_data";
        reason = "not_in_quotehub";
      }

      const entry = {
        code,
        status,
        lastPrice: quote?.price ?? null,
        lastAt: quote?.updatedAt ?? null,
        reason,
        scannedAt: now,
      };
      this._results.set(code, entry);
      batchResults.push(entry);
    }

    this.emit("batch", { batch: batchResults, cursor: this._cursor, total: this._codes.length });
  }

  /** 取得目前掃描結果摘要 */
  summary() {
    const counts = { fresh: 0, warm: 0, stale: 0, no_data: 0 };
    for (const [, entry] of this._results) {
      counts[entry.status] = (counts[entry.status] ?? 0) + 1;
    }
    return {
      totalCodes: this._codes.length,
      scanned: this._results.size,
      cycles: this._scanCount,
      ...counts,
    };
  }

  /** 取得建議升級到 strategy-universe 的商品（fresh + 有價格） */
  suggestUpgrade(minPrice = 0) {
    const candidates = [];
    for (const [code, entry] of this._results) {
      if (entry.status === "fresh" && entry.lastPrice > minPrice) {
        candidates.push(code);
      }
    }
    return candidates;
  }

  /** 取得應降級的商品（stale 或 no_data） */
  suggestDowngrade() {
    const stale = [];
    for (const [code, entry] of this._results) {
      if (entry.status === "stale" || entry.status === "no_data") {
        stale.push({ code, reason: entry.reason });
      }
    }
    return stale;
  }

  /** 完整 matrix 輸出 */
  matrix() {
    return Object.fromEntries(this._results);
  }
}

export default QuoteFreshnessScanner;
