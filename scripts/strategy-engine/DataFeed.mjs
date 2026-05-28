function normalizeKey(instrument, broker) {
  return `${String(broker ?? "")
    .trim()
    .toLowerCase()}:${String(instrument ?? "")
    .trim()
    .toUpperCase()}`;
}

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeTime(time = new Date()) {
  if (time instanceof Date && Number.isFinite(time.getTime())) {
    return time;
  }

  const parsed = new Date(time);
  return Number.isFinite(parsed.getTime()) ? parsed : new Date(0);
}

export class DataFeed {
  constructor(options = {}) {
    const intervalMs = Number(options.barIntervalMs);
    this._barIntervalMs = Number.isInteger(intervalMs) && intervalMs > 0 ? intervalMs : 60_000;
    this._listeners = new Map();
    this._prices = new Map();
    this._barBuilders = new Map();
  }

  subscribe(instrument, broker, callback) {
    if (typeof callback !== "function") {
      throw new TypeError("DataFeed.subscribe callback must be a function");
    }

    const key = normalizeKey(instrument, broker);
    if (!this._listeners.has(key)) {
      this._listeners.set(key, new Set());
    }
    this._listeners.get(key).add(callback);

    return () => {
      const listeners = this._listeners.get(key);
      if (!listeners) {
        return;
      }

      listeners.delete(callback);
      if (listeners.size === 0) {
        this._listeners.delete(key);
      }
    };
  }

  listenerCount(instrument, broker) {
    return this._listeners.get(normalizeKey(instrument, broker))?.size ?? 0;
  }

  getPrice(instrument, broker) {
    return this._prices.get(normalizeKey(instrument, broker)) ?? null;
  }

  pushTick(instrument, broker, price, options = {}) {
    const key = normalizeKey(instrument, broker);
    const tick = {
      type: "tick",
      instrument: String(instrument ?? "")
        .trim()
        .toUpperCase(),
      broker: String(broker ?? "")
        .trim()
        .toLowerCase(),
      price: toFiniteNumber(price),
      volume: Math.max(0, toFiniteNumber(options.volume)),
      time: normalizeTime(options.time),
    };

    this._prices.set(key, tick.price);
    const completedBar = this._updateBar(key, tick);
    this._emit(key, tick);

    if (completedBar) {
      this._emit(key, {
        type: "bar",
        instrument: tick.instrument,
        broker: tick.broker,
        bar: completedBar,
      });
    }

    return tick;
  }

  pushBar(instrument, broker, bar = {}) {
    const key = normalizeKey(instrument, broker);
    const normalized = {
      open: toFiniteNumber(bar.open),
      high: toFiniteNumber(bar.high),
      low: toFiniteNumber(bar.low),
      close: toFiniteNumber(bar.close),
      volume: Math.max(0, toFiniteNumber(bar.volume)),
      time: normalizeTime(bar.time).toISOString(),
    };

    this._prices.set(key, normalized.close);
    this._emit(key, {
      type: "bar",
      instrument: String(instrument ?? "")
        .trim()
        .toUpperCase(),
      broker: String(broker ?? "")
        .trim()
        .toLowerCase(),
      bar: normalized,
    });

    return normalized;
  }

  snapshot() {
    return Object.fromEntries(this._prices.entries());
  }

  _updateBar(key, tick) {
    const current = this._barBuilders.get(key);
    if (!current) {
      this._barBuilders.set(key, {
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: tick.volume,
        startMs: tick.time.getTime(),
      });
      return null;
    }

    if (tick.time.getTime() - current.startMs >= this._barIntervalMs) {
      const completed = {
        open: current.open,
        high: current.high,
        low: current.low,
        close: current.close,
        volume: current.volume,
        time: new Date(current.startMs).toISOString(),
      };
      this._barBuilders.set(key, {
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: tick.volume,
        startMs: tick.time.getTime(),
      });
      return completed;
    }

    current.high = Math.max(current.high, tick.price);
    current.low = Math.min(current.low, tick.price);
    current.close = tick.price;
    current.volume += tick.volume;
    return null;
  }

  _emit(key, event) {
    const listeners = this._listeners.get(key);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      listener(event);
    }
  }
}
