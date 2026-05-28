// MarketMakingStrategy.mjs — 做市商策略
// 移植自 BitMEX / Hummingbot Pure Market Making 策略
// 開源：https://github.com/hummingbot/hummingbot/tree/master/hummingbot/strategy/pure_market_making
//
// 邏輯：
//   1. 在 midPrice 兩側掛出 bid/ask（報價）
//   2. 依庫存偏斜（inventory skew）調整報價中心
//   3. 波動率過高時自動加寬價差
//   4. 成交後立即重新報價
export class MarketMakingStrategy {
  constructor(config) {
    this.name = config.name;
    this.instrument = config.instrument;
    this.broker = config.broker;
    this.params = config.params ?? {};
    this.autoExecute = config.auto ?? false;

    // 基礎報價參數
    this.baseSpreadPct = this.params.baseSpreadPct ?? 0.001; // 基礎價差 0.1%
    this.orderQty = this.params.orderQty ?? 1;
    this.maxInventory = this.params.maxInventory ?? 5; // 最大庫存口數
    // 庫存偏斜係數（庫存多 → 調低買價）
    this.inventorySkew = this.params.inventorySkew ?? 0.5;
    // 波動率放大係數
    this.volMultiplier = this.params.volMultiplier ?? 2.0;
    // 最小報價間隔（ms）
    this.requoteMs = this.params.requoteMs ?? 500;

    this._inventory = 0; // 淨庫存（正=多，負=空）
    this._lastQuoteAt = 0;
    this._signals = [];
    this._activeOrders = { bid: null, ask: null };
    this._enabled = true;
  }

  onTick(tick, analyzer) {
    if (!analyzer) {
      return;
    }
    const now = Date.now();
    if (now - this._lastQuoteAt < this.requoteMs) {
      return;
    }

    const mid = analyzer.midPrice();
    const spread = analyzer.spread();
    const vol = analyzer.toxicity(20); // 訂單流毒性代理波動率

    if (mid <= 0) {
      return;
    }

    // 動態調整價差（波動率高時加寬）
    const dynamicSpread = Math.max(
      spread,
      mid * this.baseSpreadPct * (1 + this.volMultiplier * vol),
    );
    const halfSpread = dynamicSpread / 2;

    // 庫存偏斜：庫存多 → 買價下調，賣價下調（鼓勵賣出）
    const skewAdj = (this._inventory * this.inventorySkew * halfSpread) / this.maxInventory;

    const bidPrice = mid - halfSpread - skewAdj;
    const askPrice = mid + halfSpread - skewAdj;

    // 取消舊報價
    if (this._activeOrders.bid) {
      this._signals.push({
        ...this._makeSignal("cancel", bidPrice, "bid"),
        orderId: this._activeOrders.bid,
      });
    }
    if (this._activeOrders.ask) {
      this._signals.push({
        ...this._makeSignal("cancel", askPrice, "ask"),
        orderId: this._activeOrders.ask,
      });
    }

    // 庫存未超限才掛新單
    if (this._inventory < this.maxInventory) {
      const bidSig = this._makeSignal("limit_buy", bidPrice, "bid");
      this._signals.push(bidSig);
      this._activeOrders.bid = bidSig.clientId;
    }
    if (-this._inventory < this.maxInventory) {
      const askSig = this._makeSignal("limit_sell", askPrice, "ask");
      this._signals.push(askSig);
      this._activeOrders.ask = askSig.clientId;
    }

    this._lastQuoteAt = now;
  }

  onFill(side, price, qty) {
    if (side === "buy") {
      this._inventory += qty;
    }
    if (side === "sell") {
      this._inventory -= qty;
    }
  }

  _makeSignal(action, price, side) {
    return {
      time: new Date().toISOString(),
      strategy: this.name,
      instrument: this.instrument,
      broker: this.broker,
      action,
      side,
      price: +price.toFixed(4),
      qty: this.orderQty,
      clientId: `MM_${side}_${Date.now()}`,
      autoExecute: this.autoExecute,
      reason: `做市商 ${side}@${price.toFixed(2)} 庫存=${this._inventory}`,
    };
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
