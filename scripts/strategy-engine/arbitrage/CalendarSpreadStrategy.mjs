import { ArbitrageBase } from "./ArbitrageBase.mjs";

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export class CalendarSpreadStrategy extends ArbitrageBase {
  constructor(config = {}) {
    super(config);
    this.lookback = Math.max(3, Math.trunc(finiteNumber(this.params.lookback, 20)));
    this.entryZ = Math.max(0, finiteNumber(this.params.entryZ, 1.5));
    this.exitZ = Math.max(0, finiteNumber(this.params.exitZ, 0.3));
    this.minBars = Math.max(
      this.lookback + 1,
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
    const count = Math.min(closesA.length, closesB.length);
    const spreads = Array.from({ length: count }, (_, index) => {
      const a = closesA[closesA.length - count + index];
      const b = closesB[closesB.length - count + index];
      return a - b;
    });

    const window = spreads.slice(-this.lookback);
    const z = this.zScore(window);
    const currentSpread = spreads.at(-1) ?? 0;
    const nearPrice = closesA.at(-1) ?? 0;
    const farPrice = closesB.at(-1) ?? 0;
    const reason = [
      `spread=${currentSpread.toFixed(2)}`,
      `z=${z.toFixed(2)}`,
      `near=${nearPrice.toFixed(2)}`,
      `far=${farPrice.toFixed(2)}`,
    ].join(" ");

    if (this.isOpen() && Math.abs(z) < this.exitZ) {
      const signal =
        this.position === 1
          ? this.signal("close_spread", `calendar close ${reason}`, "buy", "sell")
          : this.signal("close_spread", `calendar close ${reason}`, "sell", "buy");
      this.position = 0;
      return signal;
    }

    if (this.isOpen()) {
      return null;
    }

    if (z > this.entryZ) {
      this.position = 1;
      return this.signal("open_spread", `calendar spread high ${reason}`, "sell", "buy");
    }

    if (z < -this.entryZ) {
      this.position = -1;
      return this.signal("open_spread", `calendar spread low ${reason}`, "buy", "sell");
    }

    return null;
  }
}
