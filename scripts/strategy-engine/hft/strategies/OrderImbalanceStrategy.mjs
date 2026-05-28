// OrderImbalanceStrategy.mjs — 訂單簿不平衡策略
// 移植自 Citadel / Two Sigma 訂單流策略學術論文實作
// 開源參考：https://github.com/rorysroes/SGX-Full-OrderBook-Tick-Data-Trading-Strategy
//
// 邏輯：
//   OFI (Order Flow Imbalance) = ΔBestBidQty - ΔBestAskQty
//   短期 imbalance > threshold → 預期上漲 → 買
//   短期 imbalance < -threshold → 預期下跌 → 賣
//   持倉時間極短（數秒），嚴格止損
export class OrderImbalanceStrategy {
  constructor(config) {
    this.name = config.name;
    this.instrument = config.instrument;
    this.broker = config.broker;
    this.params = config.params ?? {};
    this.autoExecute = config.auto ?? false;

    this.imbalanceThreshold = this.params.imbalanceThreshold ?? 0.6; // ±0.6
    this.holdMs = this.params.holdMs ?? 5000; // 持倉 5 秒
    this.stopTicks = this.params.stopTicks ?? 2; // 止損 2 tick
    this.orderQty = this.params.orderQty ?? 1;
    this.minSpreadPct = this.params.minSpreadPct ?? 0.0002; // 最小價差（防止做市場）
    this.cooldownMs = this.params.cooldownMs ?? 2000;

    this._position = 0;
    this._entryPrice = 0;
    this._entryTime = 0;
    this._lastTradeAt = 0;
    this._signals = [];
    this._enabled = true;
  }

  onBook(analyzer) {
    const now = Date.now();
    if (now - this._lastTradeAt < this.cooldownMs) {
      return;
    }

    const imb = analyzer.imbalance(3); // 只看前三檔
    const mid = analyzer.midPrice();
    const spread = analyzer.spreadPct();

    if (spread < this.minSpreadPct) {
      return;
    }
    if (mid <= 0) {
      return;
    }

    // 持倉中：檢查出場條件
    if (this._position !== 0) {
      const elapsed = now - this._entryTime;
      const ticks = mid - this._entryPrice;

      // 超時平倉
      if (elapsed >= this.holdMs) {
        this._exit(mid, `訂單不平衡: 持倉超時 ${(elapsed / 1000).toFixed(1)}s`);
        return;
      }
      // 止損
      if (this._position === 1 && ticks < -this.stopTicks) {
        this._exit(mid, `訂單不平衡: 多頭止損 ${ticks.toFixed(2)} ticks`);
        return;
      }
      if (this._position === -1 && ticks > this.stopTicks) {
        this._exit(mid, `訂單不平衡: 空頭止損 ${ticks.toFixed(2)} ticks`);
        return;
      }
      return;
    }

    // 進場
    if (imb > this.imbalanceThreshold) {
      this._enter("buy", mid, `OFI 買方主導 imb=${imb.toFixed(3)}`);
    } else if (imb < -this.imbalanceThreshold) {
      this._enter("sell", mid, `OFI 賣方主導 imb=${imb.toFixed(3)}`);
    }
  }

  _enter(direction, price, reason) {
    this._position = direction === "buy" ? 1 : -1;
    this._entryPrice = price;
    this._entryTime = Date.now();
    this._lastTradeAt = Date.now();
    this._signals.push({
      time: new Date().toISOString(),
      strategy: this.name,
      instrument: this.instrument,
      broker: this.broker,
      direction,
      qty: this.orderQty,
      price,
      reason,
      autoExecute: this.autoExecute,
    });
  }

  _exit(price, reason) {
    const dir = this._position === 1 ? "close_long" : "close_short";
    this._signals.push({
      time: new Date().toISOString(),
      strategy: this.name,
      instrument: this.instrument,
      broker: this.broker,
      direction: dir,
      qty: this.orderQty,
      price,
      reason,
      autoExecute: this.autoExecute,
    });
    this._position = 0;
    this._entryPrice = 0;
    this._lastTradeAt = Date.now();
  }

  popSignals() {
    const s = [...this._signals];
    this._signals = [];
    return s;
  }
  get enabled() {
    return this._enabled;
  }
}
