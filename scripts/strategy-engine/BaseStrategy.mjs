export class BaseStrategy {
  constructor(config = {}) {
    this.name = config.name || "unnamed-strategy";
    this.instrument = config.instrument || "";
    this.broker = config.broker || "capital";
    this.params = config.params || {};
    this.requestedAutoExecute = config.auto === true;
    this.autoExecute = false;
    this.maxQty = Number.isFinite(Number(config.maxQty)) ? Number(config.maxQty) : 1;
    this._priceHistory = [];
    this._signals = [];
    this._lastSignal = null;
    this._position = 0;
    this._entryPrice = 0;
    this._highSinceEntry = 0;
    this._lowSinceEntry = Infinity;
    this._enabled = true;
  }

  onBar() {}

  /**
   * 每個 tick 即時檢查停損/停利/移動停損
   * 子類可 override 加入 tick 級進場邏輯
   */
  onTick(event) {
    if (this._position === 0 || !this._entryPrice) return;
    const price = event?.price ?? 0;
    if (price <= 0) return;

    // 更新最高/最低追蹤（用於 trailing stop）
    if (this._position > 0) {
      this._highSinceEntry = Math.max(this._highSinceEntry ?? price, price);
    } else {
      this._lowSinceEntry = Math.min(this._lowSinceEntry ?? price, price);
    }

    const pnlPct =
      this._position > 0
        ? ((price - this._entryPrice) / this._entryPrice) * 100
        : ((this._entryPrice - price) / this._entryPrice) * 100;

    // 即時停損
    const sl = this.params.stopLoss ?? this.stopLoss ?? 2.0;
    if (pnlPct <= -sl) {
      const dir = this._position > 0 ? "close_long" : "close_short";
      this.signal(dir, `Tick停損 ${pnlPct.toFixed(2)}%`, this.maxQty);
      this._resetPosition();
      return;
    }

    // 即時停利
    const tp = this.params.takeProfit ?? this.takeProfit ?? 4.0;
    if (pnlPct >= tp) {
      const dir = this._position > 0 ? "close_long" : "close_short";
      this.signal(dir, `Tick停利 ${pnlPct.toFixed(2)}%`, this.maxQty);
      this._resetPosition();
      return;
    }

    // Trailing stop（獲利超過 trailActivate% 後啟用，回撤 trailStop% 出場）
    const trailActivate = this.params.trailActivate ?? 2.0;
    const trailStop = this.params.trailStop ?? 1.0;
    if (pnlPct >= trailActivate) {
      let drawdown = 0;
      if (this._position > 0) {
        drawdown = ((this._highSinceEntry - price) / this._highSinceEntry) * 100;
      } else {
        drawdown = ((price - this._lowSinceEntry) / this._lowSinceEntry) * 100;
      }
      if (drawdown >= trailStop) {
        const dir = this._position > 0 ? "close_long" : "close_short";
        this.signal(dir, `移動停損 回撤${drawdown.toFixed(2)}%`, this.maxQty);
        this._resetPosition();
        return;
      }
    }
  }

  _resetPosition() {
    this._position = 0;
    this._entryPrice = 0;
    this._highSinceEntry = 0;
    this._lowSinceEntry = Infinity;
  }

  onFill(fill) {
    const qty = Number(fill?.qty ?? 0);
    if (fill?.direction === "buy") {
      this._position += qty;
    } else if (fill?.direction === "sell") {
      this._position -= qty;
    }
  }

  addBar(bar) {
    this._priceHistory.push(bar);
    if (this._priceHistory.length > 500) {
      this._priceHistory.shift();
    }
  }

  closes() {
    return this._priceHistory.map((bar) => bar.close);
  }

  highs() {
    return this._priceHistory.map((bar) => bar.high);
  }

  lows() {
    return this._priceHistory.map((bar) => bar.low);
  }

  volumes() {
    return this._priceHistory.map((bar) => bar.volume ?? 0);
  }

  signal(direction, reason, qty) {
    const signal = {
      schema: "openclaw.capital.strategy-intent.v1",
      time: new Date().toISOString(),
      direction,
      reason,
      qty: qty ?? this.maxQty,
      instrument: this.instrument,
      broker: this.broker,
      strategy: this.name,
      autoExecute: false,
      requestedAutoExecute: this.requestedAutoExecute,
      paperOnly: true,
      allowLiveTrading: false,
      writeBrokerOrders: false,
    };
    this._signals.push(signal);
    this._lastSignal = signal;
    return signal;
  }

  popSignals() {
    const signals = [...this._signals];
    this._signals = [];
    return signals;
  }

  barCount() {
    return this._priceHistory.length;
  }

  lastBar() {
    return this._priceHistory[this._priceHistory.length - 1];
  }

  isLong() {
    return this._position > 0;
  }

  isShort() {
    return this._position < 0;
  }

  isFlat() {
    return this._position === 0;
  }

  lastN(n, values) {
    return values.slice(-n);
  }

  enable() {
    this._enabled = true;
  }

  disable() {
    this._enabled = false;
  }

  get enabled() {
    return this._enabled;
  }

  updateParams(newParams = {}, newConfig = {}) {
    const changed = [];
    for (const [key, value] of Object.entries(newParams)) {
      if (JSON.stringify(this.params[key]) !== JSON.stringify(value)) {
        changed.push({ key, old: this.params[key], new: value });
        this.params[key] = value;
      }
    }
    if (newConfig.maxQty != null && Number.isFinite(Number(newConfig.maxQty))) {
      this.maxQty = Number(newConfig.maxQty);
    }
    if (newConfig.auto != null) {
      this.requestedAutoExecute = newConfig.auto === true;
      this.autoExecute = false;
    }
    return changed;
  }

  toString() {
    return `[${this.name}@${this.instrument}]`;
  }
}
