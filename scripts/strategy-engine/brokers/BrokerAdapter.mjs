/**
 * BrokerAdapter.mjs — 通用券商 Adapter 基底類別
 * 所有券商（群益、OKX、元大、IB、Binance...）都實作此介面
 * StrategyEngine / PaperTradingLoop / RiskController 只認這個介面
 *
 * 新增券商只需：
 *   1. 繼承 BrokerAdapter
 *   2. 實作所有 abstract 方法
 *   3. 在 config/instrument-registry.json 註冊商品
 *   4. 在 brokers/index.mjs 加入 factory
 */

// 統一下單信號格式
// @typedef {Object} OrderSignal
// @property {string} symbol      - 商品代碼
// @property {"buy"|"sell"} side  - 方向
// @property {number} qty         - 數量
// @property {"market"|"limit"|"stop"} type - 下單類型
// @property {number} [price]     - 限價/停損價
// @property {string} [strategy]  - 來源策略名稱
// @property {boolean} [dryRun]   - 是否為模擬（預設 true）

export class BrokerAdapter {
  /**
   * @param {Object} opts
   * @param {string} opts.name        - adapter 名稱（如 "capital", "okx"）
   * @param {string} opts.displayName - 顯示名稱（如 "群益 CapitalHftService"）
   * @param {string} opts.mode        - "paper" | "demo" | "live"
   * @param {string[]} opts.markets   - 支援的市場（如 ["domestic_futures", "overseas_futures"]）
   */
  constructor(opts = {}) {
    this.name = opts.name ?? "unknown";
    this.displayName = opts.displayName ?? this.name;
    this.mode = opts.mode ?? "paper";
    this.markets = opts.markets ?? [];
    this._healthy = false;
    this._lastHealthCheck = 0;
    this._healthTtlMs = opts.healthTtlMs ?? 30_000;
    // Live 模式核准設定（由呼叫者從 capital-live-trading-approval.json 載入）
    this._liveApproval = opts.liveApproval ?? null;
  }

  // ══════════════════════════════════════════════════════════════════
  // 報價（必須實作）
  // ══════════════════════════════════════════════════════════════════

  /**
   * 取得單一商品最新報價
   * @param {string} symbol
   * @returns {Promise<{price, bid, ask, volume, time, symbol, source}>}
   */
  async getQuote(_symbol) {
    throw new Error(`${this.name}.getQuote() 未實作`);
  }

  /**
   * 取得 K 棒資料
   * @param {string} symbol
   * @param {Object} opts - { interval: "1m"|"5m"|"1h"|"1d", limit: number }
   * @returns {Promise<Array<{time, open, high, low, close, volume}>>}
   */
  async getBars(_symbol, _opts = {}) {
    throw new Error(`${this.name}.getBars() 未實作`);
  }

  /**
   * 列出所有可用商品
   * @returns {Promise<Array<{symbol, name, type, exchange}>>}
   */
  async listInstruments() {
    throw new Error(`${this.name}.listInstruments() 未實作`);
  }

  // ══════════════════════════════════════════════════════════════════
  // 下單（必須實作，paper/demo 模式回傳模擬結果）
  // ══════════════════════════════════════════════════════════════════

  /**
   * 送出訂單
   * @param {OrderSignal} signal
   * @returns {Promise<{orderId, status, filledPrice, filledQty, message}>}
   */
  async submitOrder(_signal) {
    throw new Error(`${this.name}.submitOrder() 未實作`);
  }

  /**
   * 取消訂單
   * @param {string} orderId
   * @returns {Promise<{ok, message}>}
   */
  async cancelOrder(_orderId) {
    throw new Error(`${this.name}.cancelOrder() 未實作`);
  }

  // ══════════════════════════════════════════════════════════════════
  // 部位與帳戶（必須實作）
  // ══════════════════════════════════════════════════════════════════

  /**
   * 取得當前部位
   * @returns {Promise<Array<{symbol, side, qty, avgPrice, unrealizedPnl}>>}
   */
  async getPositions() {
    throw new Error(`${this.name}.getPositions() 未實作`);
  }

  /**
   * 取得帳戶摘要
   * @returns {Promise<{equity, margin, available, currency}>}
   */
  async getAccountSummary() {
    throw new Error(`${this.name}.getAccountSummary() 未實作`);
  }

  // ══════════════════════════════════════════════════════════════════
  // 健康檢查（可覆寫）
  // ══════════════════════════════════════════════════════════════════

  /**
   * 檢查 adapter 是否可用
   * @returns {Promise<boolean>}
   */
  async healthCheck() {
    return false;
  }

  /** 帶快取的健康檢查 */
  async isHealthy() {
    if (Date.now() - this._lastHealthCheck < this._healthTtlMs) {
      return this._healthy;
    }
    try {
      this._healthy = await this.healthCheck();
    } catch {
      this._healthy = false;
    }
    this._lastHealthCheck = Date.now();
    return this._healthy;
  }

  // ══════════════════════════════════════════════════════════════════
  // 安全守門（共用邏輯，子類別不需覆寫）
  // ══════════════════════════════════════════════════════════════════

  /** 是否允許送出真實訂單 */
  get isLive() {
    return this.mode === "live";
  }

  /** 是否為紙上/模擬模式 */
  get isPaper() {
    return this.mode === "paper" || this.mode === "demo";
  }

  /** 安全攔截：下單前必須通過基本驗證 + live 閘門 */
  validateOrderSafety(signal) {
    if (!signal || typeof signal !== "object") {
      return { ok: false, mode: this.mode, message: "訂單訊號格式錯誤" };
    }
    const symbol = String(signal.symbol ?? "").trim();
    const side = String(signal.side ?? "")
      .trim()
      .toLowerCase();
    const qty = Number(signal.qty ?? 1);
    if (!symbol) {
      return { ok: false, mode: this.mode, message: "symbol 必填" };
    }
    if (!["buy", "sell"].includes(side)) {
      return { ok: false, mode: this.mode, message: "side 必須是 buy 或 sell" };
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      return { ok: false, mode: this.mode, message: "qty 必須是正數" };
    }
    // 非 live 模式 → paper 模擬
    if (!this.isLive) {
      return { ok: true, mode: "paper", message: "紙上模式，不送真實訂單" };
    }
    // Live 模式 → 檢查 liveApproval 設定
    if (this.isLive) {
      // 必須由建構時傳入 liveApproval 設定
      const approval = this._liveApproval;
      if (!approval) {
        return { ok: false, mode: "live", message: "live 模式未載入 approval 設定" };
      }
      if (!approval.allowLiveTrading) {
        return { ok: false, mode: "live", message: "allowLiveTrading=false，需人工確認後開啟" };
      }
      if (!approval.writeBrokerOrders) {
        return { ok: false, mode: "live", message: "writeBrokerOrders=false，需人工確認" };
      }
      // 通過所有閘門
      return { ok: true, mode: "live", message: "live 模式已核准，允許送出真實訂單" };
    }
    return { ok: true, mode: this.mode };
  }

  /** 輸出 adapter 狀態摘要 */
  toJSON() {
    return {
      name: this.name,
      displayName: this.displayName,
      mode: this.mode,
      markets: this.markets,
      healthy: this._healthy,
      lastHealthCheck: this._lastHealthCheck ? new Date(this._lastHealthCheck).toISOString() : null,
    };
  }
}
