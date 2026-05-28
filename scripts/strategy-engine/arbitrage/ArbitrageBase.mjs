function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function mean(values) {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values) {
  if (values.length < 2) {
    return 0;
  }
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function regressionSlope(pairs) {
  if (pairs.length < 2) {
    return 0;
  }
  const xMean = mean(pairs.map(([x]) => x));
  const yMean = mean(pairs.map(([, y]) => y));
  let numerator = 0;
  let denominator = 0;
  for (const [x, y] of pairs) {
    numerator += (x - xMean) * (y - yMean);
    denominator += (x - xMean) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

function normalizeLeg(input = {}) {
  return {
    instrument: String(input.instrument ?? ""),
    broker: String(input.broker ?? ""),
    maxQty: Math.max(0, finiteNumber(input.maxQty, 1)),
    bars: [],
  };
}

function normalizeBar(bar = {}) {
  return {
    ...bar,
    close: finiteNumber(bar.close),
  };
}

export class ArbitrageBase {
  constructor(config = {}) {
    this.name = String(config.name ?? "arbitrage");
    this.params = { ...config.params };
    this.autoExecute = config.auto === true && config.allowAutoExecute === true;
    this.legA = normalizeLeg(config.legA);
    this.legB = normalizeLeg(config.legB);
    this.maxBars = Math.max(1, Math.trunc(finiteNumber(config.maxBars, 500)));
    this.now = typeof config.now === "function" ? config.now : () => new Date();
    this.signals = [];
    this.position = 0;
    this.enabled = config.enabled !== false;
  }

  onBarA(bar) {
    this.pushBar("A", bar);
    return this.evaluate();
  }

  onBarB(bar) {
    this.pushBar("B", bar);
    return this.evaluate();
  }

  pushBar(leg, bar) {
    const target = leg === "A" ? this.legA : this.legB;
    target.bars.push(normalizeBar(bar));
    while (target.bars.length > this.maxBars) {
      target.bars.shift();
    }
    return target.bars.length;
  }

  evaluate() {
    return null;
  }

  zScore(series) {
    const values = series.map((value) => finiteNumber(value)).filter(Number.isFinite);
    if (values.length < 3) {
      return 0;
    }
    const deviation = standardDeviation(values);
    if (deviation === 0) {
      return 0;
    }
    return (values.at(-1) - mean(values)) / deviation;
  }

  hedgeRatio(xValues, yValues) {
    const count = Math.min(xValues.length, yValues.length);
    if (count < 5) {
      return 1;
    }
    const pairs = Array.from({ length: count }, (_, index) => [
      finiteNumber(xValues[index]),
      finiteNumber(yValues[index]),
    ]);
    const slope = regressionSlope(pairs);
    return slope === 0 ? 1 : slope;
  }

  halfLife(spread) {
    const values = spread.map((value) => finiteNumber(value)).filter(Number.isFinite);
    if (values.length < 10) {
      return Infinity;
    }
    const lagged = values.slice(0, -1);
    const delta = values.slice(1).map((value, index) => value - values[index]);
    const slope = regressionSlope(lagged.map((value, index) => [value, delta[index]]));
    return slope >= 0 ? Infinity : Math.log(2) / -slope;
  }

  signal(direction, reason, legADirection, legBDirection) {
    const signal = {
      time: this.now().toISOString(),
      type: "spread",
      strategy: this.name,
      direction: String(direction ?? ""),
      reason: String(reason ?? ""),
      autoExecute: this.autoExecute,
      legA: {
        instrument: this.legA.instrument,
        broker: this.legA.broker,
        direction: String(legADirection ?? ""),
        qty: this.legA.maxQty,
      },
      legB: {
        instrument: this.legB.instrument,
        broker: this.legB.broker,
        direction: String(legBDirection ?? ""),
        qty: this.legB.maxQty,
      },
    };
    this.signals.push(signal);
    return signal;
  }

  popSignals() {
    const queued = [...this.signals];
    this.signals = [];
    return queued;
  }

  isOpen() {
    return this.position !== 0;
  }

  closesA() {
    return this.legA.bars.map((bar) => bar.close);
  }

  closesB() {
    return this.legB.bars.map((bar) => bar.close);
  }

  barCountA() {
    return this.legA.bars.length;
  }

  barCountB() {
    return this.legB.bars.length;
  }
}
