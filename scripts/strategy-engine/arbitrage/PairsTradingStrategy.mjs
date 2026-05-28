import { ArbitrageBase } from "./ArbitrageBase.mjs";

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveNumber(value, fallback = 0) {
  const number = finiteNumber(value, fallback);
  return number > 0 ? number : fallback;
}

export class PairsTradingStrategy extends ArbitrageBase {
  constructor(config = {}) {
    super(config);
    this.lookback = Math.max(5, Math.trunc(finiteNumber(this.params.lookback, 60)));
    this.entryZ = Math.max(0, finiteNumber(this.params.entryZ, 2));
    this.exitZ = Math.max(0, finiteNumber(this.params.exitZ, 0.5));
    this.stopZ = Math.max(this.entryZ, finiteNumber(this.params.stopZ, 3.5));
    this.useLog = this.params.useLog !== false;
    this.minHalfLife = Math.max(0, finiteNumber(this.params.minHalfLife, 1));
    this.maxHalfLife = Math.max(this.minHalfLife, finiteNumber(this.params.maxHalfLife, 30));
    this.enforceHalfLife = this.params.enforceHalfLife !== false;
    this.minBars = Math.max(
      this.lookback + 5,
      Math.trunc(finiteNumber(this.params.minBars, this.lookback + 5)),
    );
  }

  evaluate() {
    if (!this.enabled) {
      return null;
    }
    if (this.barCountA() < this.minBars || this.barCountB() < this.minBars) {
      return null;
    }

    const closesA = this.closesA();
    const closesB = this.closesB();
    const count = Math.min(closesA.length, closesB.length, this.lookback * 2);
    if (count < this.lookback + 2) {
      return null;
    }

    const pricesA = closesA.slice(-count).map((value) => positiveNumber(value));
    const pricesB = closesB.slice(-count).map((value) => positiveNumber(value));
    if (pricesA.some((value) => value <= 0) || pricesB.some((value) => value <= 0)) {
      return null;
    }

    const seriesA = this.useLog ? pricesA.map((value) => Math.log(value)) : pricesA;
    const seriesB = this.useLog ? pricesB.map((value) => Math.log(value)) : pricesB;
    const hedgeRatio = this.hedgeRatio(seriesB, seriesA);
    const spread = seriesA.map((value, index) => value - hedgeRatio * seriesB[index]);
    const window = spread.slice(-this.lookback);
    const z = this.zScore(window);
    const halfLife = this.halfLife(window);

    if (this.enforceHalfLife && (halfLife < this.minHalfLife || halfLife > this.maxHalfLife)) {
      return null;
    }

    const lastA = pricesA.at(-1) ?? 0;
    const lastB = pricesB.at(-1) ?? 0;
    const reason = [
      `z=${z.toFixed(2)}`,
      `hr=${hedgeRatio.toFixed(4)}`,
      `hl=${halfLife.toFixed(2)}`,
      `a=${lastA.toFixed(2)}`,
      `b=${lastB.toFixed(2)}`,
    ].join(" ");

    if (this.isOpen() && Math.abs(z) > this.stopZ) {
      const signal =
        this.position === 1
          ? this.signal("close_spread", `pairs stop ${reason}`, "buy", "sell")
          : this.signal("close_spread", `pairs stop ${reason}`, "sell", "buy");
      this.position = 0;
      return signal;
    }

    if (this.isOpen() && Math.abs(z) < this.exitZ) {
      const signal =
        this.position === 1
          ? this.signal("close_spread", `pairs close ${reason}`, "buy", "sell")
          : this.signal("close_spread", `pairs close ${reason}`, "sell", "buy");
      this.position = 0;
      return signal;
    }

    if (this.isOpen()) {
      return null;
    }

    if (z > this.entryZ) {
      this.position = 1;
      return this.signal("open_spread", `pairs short-a-long-b ${reason}`, "sell", "buy");
    }

    if (z < -this.entryZ) {
      this.position = -1;
      return this.signal("open_spread", `pairs long-a-short-b ${reason}`, "buy", "sell");
    }

    return null;
  }
}
