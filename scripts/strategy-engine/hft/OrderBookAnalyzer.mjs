function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeSideLevels(levels) {
  if (!Array.isArray(levels)) {
    return [];
  }

  return levels
    .map((level) => {
      if (!Array.isArray(level) || level.length < 2) {
        return null;
      }

      const price = toFiniteNumber(level[0]);
      const qty = Math.max(0, toFiniteNumber(level[1]));
      return price > 0 && qty > 0 ? [price, qty] : null;
    })
    .filter(Boolean);
}

function normalizeBook(book = {}) {
  return {
    bids: normalizeSideLevels(book.bids),
    asks: normalizeSideLevels(book.asks),
  };
}

export class OrderBookAnalyzer {
  constructor(options = {}) {
    const maxHistory = Number(options.maxHistory);
    this._book = { bids: [], asks: [] };
    this._history = [];
    this._maxHistory = Number.isInteger(maxHistory) && maxHistory > 0 ? maxHistory : 200;
  }

  update(book = {}, nowMs = Date.now()) {
    this._book = normalizeBook(book);
    const entry = {
      time: toFiniteNumber(nowMs),
      mid: this.midPrice(),
      imbalance: this.imbalance(5),
    };

    this._history.push(entry);
    if (this._history.length > this._maxHistory) {
      this._history.shift();
    }

    return entry;
  }

  get bids() {
    return this._book.bids;
  }

  get asks() {
    return this._book.asks;
  }

  get history() {
    return [...this._history];
  }

  bestBid() {
    return this.bids[0]?.[0] ?? 0;
  }

  bestAsk() {
    return this.asks[0]?.[0] ?? 0;
  }

  midPrice() {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    return bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
  }

  spread() {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    return bid > 0 && ask > 0 ? ask - bid : 0;
  }

  spreadPct() {
    const mid = this.midPrice();
    return mid > 0 ? this.spread() / mid : 0;
  }

  imbalance(levels = 5) {
    const limit = Math.max(1, Math.trunc(toFiniteNumber(levels, 5)));
    const bidVol = this.bids.slice(0, limit).reduce((sum, [, qty]) => sum + qty, 0);
    const askVol = this.asks.slice(0, limit).reduce((sum, [, qty]) => sum + qty, 0);
    const total = bidVol + askVol;
    return total > 0 ? (bidVol - askVol) / total : 0;
  }

  weightedMidPrice() {
    const bidPrice = this.bestBid();
    const askPrice = this.bestAsk();
    const bidQty = this.bids[0]?.[1] ?? 0;
    const askQty = this.asks[0]?.[1] ?? 0;
    const totalQty = bidQty + askQty;

    if (bidPrice <= 0 || askPrice <= 0 || totalQty <= 0) {
      return 0;
    }

    return (bidPrice * askQty + askPrice * bidQty) / totalQty;
  }

  marketImpact(side, qty) {
    const requestedQty = Math.max(0, toFiniteNumber(qty));
    if (requestedQty <= 0 || (side !== "buy" && side !== "sell")) {
      return { avgPrice: 0, slippage: 0, unfilled: requestedQty };
    }

    const levels = side === "buy" ? this.asks : this.bids;
    let remaining = requestedQty;
    let totalCost = 0;
    let filled = 0;

    for (const [price, levelQty] of levels) {
      const fill = Math.min(remaining, levelQty);
      totalCost += fill * price;
      filled += fill;
      remaining -= fill;
      if (remaining <= 0) {
        break;
      }
    }

    const avgPrice = filled > 0 ? totalCost / filled : 0;
    const mid = this.midPrice();
    return {
      avgPrice,
      slippage: avgPrice > 0 && mid > 0 ? Math.abs(avgPrice - mid) : 0,
      unfilled: remaining,
    };
  }

  detectLargeOrders(thresholdMultiple = 5, levels = 10) {
    const threshold = Math.max(1, toFiniteNumber(thresholdMultiple, 5));
    const limit = Math.max(1, Math.trunc(toFiniteNumber(levels, 10)));
    const bids = this.bids.slice(0, limit);
    const asks = this.asks.slice(0, limit);
    const combined = [...bids, ...asks];
    const avgQty = combined.reduce((sum, [, qty]) => sum + qty, 0) / (combined.length || 1);

    if (avgQty <= 0) {
      return [];
    }

    return [
      ...bids
        .filter(([, qty]) => qty > avgQty * threshold)
        .map(([price, qty]) => ({ side: "bid", price, qty })),
      ...asks
        .filter(([, qty]) => qty > avgQty * threshold)
        .map(([price, qty]) => ({ side: "ask", price, qty })),
    ];
  }

  toxicity(samples = 20) {
    const count = Math.max(1, Math.trunc(toFiniteNumber(samples, 20)));
    if (this._history.length < count) {
      return 0;
    }

    const recent = this._history.slice(-count).map((entry) => entry.imbalance);
    const mean = recent.reduce((sum, value) => sum + value, 0) / count;
    const variance = recent.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count;
    return Math.sqrt(variance);
  }

  midMomentum(samples = 10) {
    const count = Math.max(1, Math.trunc(toFiniteNumber(samples, 10)));
    if (this._history.length < count) {
      return 0;
    }

    const recent = this._history.slice(-count);
    return recent.at(-1).mid - recent[0].mid;
  }
}
