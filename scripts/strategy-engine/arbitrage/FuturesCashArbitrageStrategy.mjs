import { ArbitrageBase } from "./ArbitrageBase.mjs";

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export class FuturesCashArbitrageStrategy extends ArbitrageBase {
  constructor(config = {}) {
    super(config);
    this.lookback = Math.max(3, Math.trunc(finiteNumber(this.params.lookback, 30)));
    this.entryZ = Math.max(0, finiteNumber(this.params.entryZ, 2));
    this.exitZ = Math.max(0, finiteNumber(this.params.exitZ, 0.5));
    this.stopZ = Math.max(this.entryZ, finiteNumber(this.params.stopZ, 3.5));
    this.riskFree = finiteNumber(this.params.riskFree, 0.05);
    this.daysToExpiry = Math.max(0, finiteNumber(this.params.daysToExpiry, 0));
    this.fundingRate = finiteNumber(this.params.fundingRate, 0.0001);
    this.minBars = Math.max(
      this.lookback + 1,
      Math.trunc(finiteNumber(this.params.minBars, this.lookback + 5)),
    );
  }

  theoreticalBasis(spotPrice) {
    const spot = finiteNumber(spotPrice);
    if (this.daysToExpiry > 0) {
      const yearsToExpiry = this.daysToExpiry / 365;
      return spot * (Math.exp(this.riskFree * yearsToExpiry) - 1);
    }
    return spot * this.fundingRate * 3;
  }

  evaluate() {
    if (!this.enabled) {
      return null;
    }
    if (this.barCountA() < this.minBars || this.barCountB() < this.minBars) {
      return null;
    }

    const futuresPrices = this.closesA();
    const spotPrices = this.closesB();
    const count = Math.min(futuresPrices.length, spotPrices.length);
    const basisDeviations = Array.from({ length: count }, (_, index) => {
      const future = futuresPrices[futuresPrices.length - count + index];
      const spot = spotPrices[spotPrices.length - count + index];
      return future - spot - this.theoreticalBasis(spot);
    });

    const window = basisDeviations.slice(-this.lookback);
    const z = this.zScore(window);
    const futuresPrice = futuresPrices.at(-1) ?? 0;
    const spotPrice = spotPrices.at(-1) ?? 0;
    const actualBasis = futuresPrice - spotPrice;
    const theoreticalBasis = this.theoreticalBasis(spotPrice);
    const deviation = actualBasis - theoreticalBasis;
    const deviationPct = spotPrice === 0 ? 0 : (deviation / spotPrice) * 100;
    const reason = [
      `futures=${futuresPrice.toFixed(2)}`,
      `spot=${spotPrice.toFixed(2)}`,
      `basis=${actualBasis.toFixed(2)}`,
      `theoretical=${theoreticalBasis.toFixed(2)}`,
      `deviationPct=${deviationPct.toFixed(3)}%`,
      `z=${z.toFixed(2)}`,
    ].join(" ");

    if (this.isOpen() && Math.abs(z) > this.stopZ) {
      const signal =
        this.position === 1
          ? this.signal("close_spread", `futures cash stop ${reason}`, "buy", "sell")
          : this.signal("close_spread", `futures cash stop ${reason}`, "sell", "buy");
      this.position = 0;
      return signal;
    }

    if (this.isOpen() && Math.abs(z) < this.exitZ) {
      const signal =
        this.position === 1
          ? this.signal("close_spread", `futures cash close ${reason}`, "buy", "sell")
          : this.signal("close_spread", `futures cash close ${reason}`, "sell", "buy");
      this.position = 0;
      return signal;
    }

    if (this.isOpen()) {
      return null;
    }

    if (z > this.entryZ) {
      this.position = 1;
      return this.signal("open_spread", `futures rich ${reason}`, "sell", "buy");
    }

    if (z < -this.entryZ) {
      this.position = -1;
      return this.signal("open_spread", `futures cheap ${reason}`, "buy", "sell");
    }

    return null;
  }
}
