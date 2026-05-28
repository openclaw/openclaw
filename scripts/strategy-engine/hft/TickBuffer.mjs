export class TickBuffer {
  constructor(capacity = 2000) {
    this.capacity = Number.isInteger(capacity) && capacity > 0 ? capacity : 2000;
    this._buf = Array.from({ length: this.capacity });
    this._head = 0;
    this._size = 0;
    this._cumVolBuy = 0;
    this._cumVolSell = 0;
    this._cumVwapNum = 0;
    this._cumVwapDen = 0;
  }

  push(tick) {
    const normalized = normalizeTick(tick);
    const old = this._buf[this._head];
    if (old) {
      this._removeFromStats(old);
    }

    this._buf[this._head] = normalized;
    this._head = (this._head + 1) % this.capacity;
    if (this._size < this.capacity) {
      this._size += 1;
    }

    this._addToStats(normalized);
    return normalized;
  }

  get size() {
    return this._size;
  }

  latest() {
    if (this._size === 0) {
      return null;
    }
    return this._buf[(this._head - 1 + this.capacity) % this.capacity];
  }

  last(n = this._size) {
    const count = Math.min(Math.max(0, n || 0), this._size);
    const result = [];
    for (let i = 1; i <= count; i += 1) {
      const index = (this._head - i + this.capacity) % this.capacity;
      result.push(this._buf[index]);
    }
    return result;
  }

  vwap(n = this._size) {
    if (n >= this._size) {
      return this._cumVwapDen > 0 ? this._cumVwapNum / this._cumVwapDen : 0;
    }
    const ticks = this.last(n);
    let numerator = 0;
    let denominator = 0;
    for (const tick of ticks) {
      numerator += tick.price * tick.qty;
      denominator += tick.qty;
    }
    return denominator > 0 ? numerator / denominator : 0;
  }

  volumeRatio(n = this._size) {
    const ticks = this.last(n);
    let buy = 0;
    let sell = 0;
    for (const tick of ticks) {
      if (tick.side === "B") {
        buy += tick.qty;
      } else if (tick.side === "S") {
        sell += tick.qty;
      }
    }
    const total = buy + sell;
    return { buy, sell, ratio: total > 0 ? buy / total : 0.5 };
  }

  upticks(n = 50) {
    const ticks = this.last(n);
    let count = 0;
    for (let i = 1; i < ticks.length; i += 1) {
      if (ticks[i - 1].price > ticks[i].price) {
        count += 1;
      }
    }
    return count;
  }

  downticks(n = 50) {
    const ticks = this.last(n);
    let count = 0;
    for (let i = 1; i < ticks.length; i += 1) {
      if (ticks[i - 1].price < ticks[i].price) {
        count += 1;
      }
    }
    return count;
  }

  stdDev(n = 50) {
    const ticks = this.last(n);
    if (ticks.length < 2) {
      return 0;
    }
    const prices = ticks.map((tick) => tick.price);
    const mean = prices.reduce((sum, price) => sum + price, 0) / prices.length;
    const variance = prices.reduce((sum, price) => sum + (price - mean) ** 2, 0) / prices.length;
    return Math.sqrt(variance);
  }

  arrivalRate(windowMs = 1000, nowMs = Date.now()) {
    const ticks = this.last();
    return ticks.filter((tick) => nowMs - tick.time <= windowMs).length;
  }

  _addToStats(tick) {
    if (tick.side === "B") {
      this._cumVolBuy += tick.qty;
    } else if (tick.side === "S") {
      this._cumVolSell += tick.qty;
    }
    this._cumVwapNum += tick.price * tick.qty;
    this._cumVwapDen += tick.qty;
  }

  _removeFromStats(tick) {
    if (tick.side === "B") {
      this._cumVolBuy -= tick.qty;
    } else if (tick.side === "S") {
      this._cumVolSell -= tick.qty;
    }
    this._cumVwapNum -= tick.price * tick.qty;
    this._cumVwapDen -= tick.qty;
  }
}

function normalizeTick(tick) {
  const price = Number(tick?.price);
  const qty = Number(tick?.qty ?? 0);
  const side = tick?.side === "B" || tick?.side === "S" ? tick.side : "";
  return {
    time: Number.isFinite(Number(tick?.time)) ? Number(tick.time) : Date.now(),
    price: Number.isFinite(price) ? price : 0,
    qty: Number.isFinite(qty) && qty > 0 ? qty : 0,
    side,
    ask: Number.isFinite(Number(tick?.ask)) ? Number(tick.ask) : 0,
    bid: Number.isFinite(Number(tick?.bid)) ? Number(tick.bid) : 0,
  };
}
