// RiskGuard.mjs — HFT 風險控制模組
export class RiskGuard {
  constructor(config = {}) {
    this.maxLongQty = config.maxLongQty ?? 3;
    this.maxShortQty = config.maxShortQty ?? 3;
    this.maxNetQty = config.maxNetQty ?? 3;
    this.maxDailyLoss = config.maxDailyLoss ?? -50000;
    this.maxDailyProfit = config.maxDailyProfit ?? Infinity;
    this.maxOrdersPerSec = config.maxOrdersPerSec ?? 10;
    this.maxOrdersPerMin = config.maxOrdersPerMin ?? 120;
    this.maxSpreadPct = config.maxSpreadPct ?? 0.005;
    this._positions = {};
    this._dailyPnl = 0;
    this._orderTimes = [];
    this._killed = false;
    this._blockedCount = 0;
    this._auditEvents = [];
    this._auditLimit = Number.isFinite(config.auditLimit) ? Math.max(1, config.auditLimit) : 500;
    this._auditSink = typeof config.auditSink === "function" ? config.auditSink : null;
    this._resetTimer = setTimeout(() => this._dailyReset(), this._msToMidnight());
  }
  check(signal) {
    if (this._killed) return { ok: false, reason: "Kill Switch active" };
    const checks = [
      () => this._checkOrderRate(),
      () => this._checkDailyPnl(),
      () => this._checkPosition(signal),
    ];
    for (const fn of checks) {
      const r = fn();
      if (!r.ok) {
        this._blockedCount++;
        this._log({ type: "BLOCKED", signal: signal?.strategy, reason: r.reason });
        return r;
      }
    }
    this._recordOrder();
    return { ok: true };
  }
  onFill(instrument, direction, qty, price) {
    if (!this._positions[instrument])
      this._positions[instrument] = { long: 0, short: 0, avgCost: 0 };
    const pos = this._positions[instrument];
    if (direction === "buy") {
      pos.avgCost = (pos.avgCost * pos.long + price * qty) / (pos.long + qty);
      pos.long += qty;
    } else if (direction === "sell") {
      pos.short += qty;
      if (pos.long > 0) {
        this._dailyPnl += (price - pos.avgCost) * Math.min(qty, pos.long);
        pos.long = Math.max(0, pos.long - qty);
      }
    } else if (direction === "close_long") {
      this._dailyPnl += (price - pos.avgCost) * Math.min(qty, pos.long);
      pos.long = Math.max(0, pos.long - qty);
    } else if (direction === "close_short") {
      pos.short = Math.max(0, pos.short - qty);
    }
  }
  getPosition(instrument) {
    return this._positions[instrument] ?? { long: 0, short: 0, avgCost: 0 };
  }
  get dailyPnl() {
    return this._dailyPnl;
  }
  get isKilled() {
    return this._killed;
  }
  get blockedCount() {
    return this._blockedCount;
  }
  get auditEvents() {
    return [...this._auditEvents];
  }
  killSwitch(reason = "manual") {
    this._killed = true;
    this._log({ type: "KILL_SWITCH", reason });
    console.error("[RiskGuard] KILL: " + reason);
  }
  resume() {
    this._killed = false;
    this._log({ type: "RESUME" });
  }
  _checkOrderRate() {
    const now = Date.now();
    this._orderTimes = this._orderTimes.filter((t) => now - t < 60000);
    if (this._orderTimes.filter((t) => now - t < 1000).length >= this.maxOrdersPerSec)
      return { ok: false, reason: "order/sec limit" };
    if (this._orderTimes.length >= this.maxOrdersPerMin)
      return { ok: false, reason: "order/min limit" };
    return { ok: true };
  }
  _checkDailyPnl() {
    if (this._dailyPnl <= this.maxDailyLoss) {
      this.killSwitch("daily loss " + this._dailyPnl.toFixed(2));
      return { ok: false, reason: "daily loss limit" };
    }
    if (this._dailyPnl >= this.maxDailyProfit) return { ok: false, reason: "daily profit lock" };
    return { ok: true };
  }
  _checkPosition(signal) {
    if (!signal) return { ok: true };
    const pos = this.getPosition(signal.instrument ?? "");
    if (
      (signal.direction === "buy" || signal.direction === "close_short") &&
      pos.long >= this.maxLongQty
    )
      return { ok: false, reason: "long limit" };
    if (
      (signal.direction === "sell" || signal.direction === "close_long") &&
      pos.short >= this.maxShortQty
    )
      return { ok: false, reason: "short limit" };
    return { ok: true };
  }
  _recordOrder() {
    this._orderTimes.push(Date.now());
  }
  _dailyReset() {
    this._dailyPnl = 0;
    this._orderTimes = [];
    this._killed = false;
    if (this._resetTimer) clearTimeout(this._resetTimer);
    this._resetTimer = setTimeout(() => this._dailyReset(), this._msToMidnight());
  }
  _msToMidnight() {
    const n = new Date();
    const m = new Date(n);
    m.setHours(24, 0, 0, 0);
    return m - n;
  }
  _log(entry) {
    const ev = { ...entry, time: new Date().toISOString() };
    this._auditEvents.push(ev);
    if (this._auditEvents.length > this._auditLimit) this._auditEvents.shift();
    try {
      this._auditSink?.(ev);
    } catch {}
  }
  destroy() {
    clearTimeout(this._resetTimer);
    this._resetTimer = null;
  }
}
