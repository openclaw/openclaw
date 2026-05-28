function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeSymbol(value) {
  const symbol = String(value ?? "").trim();
  return symbol || null;
}

function normalizeFundingEntry(entry = {}, fundingIntervalHours = 8) {
  const symbol = normalizeSymbol(entry.symbol ?? entry.instId ?? entry.instrument);
  const fundingRate = finiteNumber(entry.fundingRate, Number.NaN);
  if (!symbol || !Number.isFinite(fundingRate)) {
    return null;
  }

  const paymentsPerYear = (24 / Math.max(1, finiteNumber(fundingIntervalHours, 8))) * 365;
  const annualizedRate = Number.isFinite(Number(entry.annualizedRate))
    ? Number(entry.annualizedRate)
    : fundingRate * paymentsPerYear;

  return {
    symbol,
    fundingRate,
    annualizedRate,
    nextFundingTime: entry.nextFundingTime ?? null,
  };
}

function normalizeSnapshot(snapshot, fundingIntervalHours) {
  const entries = Array.isArray(snapshot)
    ? snapshot
    : Array.isArray(snapshot?.rates)
      ? snapshot.rates
      : Object.values(snapshot ?? {});
  return entries
    .map((entry) => normalizeFundingEntry(entry, fundingIntervalHours))
    .filter(Boolean)
    .toSorted((a, b) => Math.abs(b.annualizedRate) - Math.abs(a.annualizedRate));
}

export class FundingRateArbitrage {
  constructor(config = {}) {
    this.name = String(config.name ?? "funding-rate-arbitrage");
    this.params = { ...config.params };
    this.enabled = config.enabled !== false;
    this.autoExecute = config.auto === true && config.allowAutoExecute === true;
    this.minAnnualizedRate = Math.max(
      0,
      finiteNumber(this.params.minAnnualizedRate ?? config.minRateThreshold, 0.3),
    );
    this.exitAnnualizedRate = Math.max(
      0,
      finiteNumber(this.params.exitAnnualizedRate ?? config.exitRateThreshold, 0.05),
    );
    this.notionalUsd = Math.max(
      0,
      finiteNumber(this.params.notionalUsd ?? config.notionalUsd, 1000),
    );
    this.maxPositions = Math.max(
      1,
      Math.trunc(finiteNumber(this.params.maxPositions ?? config.maxPositions, 3)),
    );
    this.fundingIntervalHours = Math.max(
      1,
      finiteNumber(this.params.fundingIntervalHours ?? config.fundingIntervalHours, 8),
    );
    this.now = typeof config.now === "function" ? config.now : () => new Date();
    this.positions = new Map();
    this.signals = [];
  }

  scan(snapshot = []) {
    return this.evaluate(snapshot);
  }

  evaluate(snapshot = []) {
    if (!this.enabled) {
      return [];
    }
    const emitted = [];
    const rates = normalizeSnapshot(snapshot, this.fundingIntervalHours);

    for (const rate of rates) {
      const currentPosition = this.positions.get(rate.symbol);
      if (
        !currentPosition &&
        Math.abs(rate.annualizedRate) >= this.minAnnualizedRate &&
        this.positions.size < this.maxPositions
      ) {
        emitted.push(this.open(rate));
      } else if (currentPosition && Math.abs(rate.annualizedRate) <= this.exitAnnualizedRate) {
        emitted.push(this.close(rate));
      } else if (currentPosition) {
        currentPosition.lastFundingRate = rate.fundingRate;
        currentPosition.lastAnnualizedRate = rate.annualizedRate;
        currentPosition.lastSeenAt = this.now().toISOString();
      }
    }

    return emitted;
  }

  open(rate) {
    const now = this.now().toISOString();
    const side = rate.fundingRate >= 0 ? "long_spot_short_perp" : "short_spot_long_perp";
    const signal = this.makeSignal({
      time: now,
      direction: "open",
      side,
      rate,
      estimatedFundingUsd: this.notionalUsd * Math.abs(rate.fundingRate),
    });
    this.positions.set(rate.symbol, {
      side,
      entryFundingRate: rate.fundingRate,
      entryAnnualizedRate: rate.annualizedRate,
      entryTime: now,
      lastFundingRate: rate.fundingRate,
      lastAnnualizedRate: rate.annualizedRate,
    });
    this.signals.push(signal);
    return signal;
  }

  close(rate) {
    const now = this.now().toISOString();
    const previous = this.positions.get(rate.symbol);
    this.positions.delete(rate.symbol);
    const signal = this.makeSignal({
      time: now,
      direction: "close",
      side: previous?.side ?? "flat",
      rate,
      estimatedFundingUsd: 0,
    });
    this.signals.push(signal);
    return signal;
  }

  makeSignal({ time, direction, side, rate, estimatedFundingUsd }) {
    const positiveFunding = rate.fundingRate >= 0;
    const spotDirection = positiveFunding ? "buy" : "sell";
    const perpDirection = positiveFunding ? "sell" : "buy";
    return {
      time,
      type: "funding_rate_arbitrage",
      strategy: this.name,
      direction,
      side,
      symbol: rate.symbol,
      fundingRate: rate.fundingRate,
      annualizedRate: rate.annualizedRate,
      nextFundingTime: rate.nextFundingTime,
      notionalUsd: this.notionalUsd,
      estimatedFundingUsd,
      autoExecute: this.autoExecute,
      reason: [
        `fundingRate=${(rate.fundingRate * 100).toFixed(4)}%`,
        `annualized=${(rate.annualizedRate * 100).toFixed(2)}%`,
        `side=${side}`,
      ].join(" "),
      spotLeg: {
        instrument: rate.symbol.replace(/-?SWAP$/u, ""),
        direction: spotDirection,
        notionalUsd: this.notionalUsd,
      },
      perpLeg: {
        instrument: rate.symbol,
        direction: perpDirection,
        notionalUsd: this.notionalUsd,
      },
    };
  }

  popSignals() {
    const queued = [...this.signals];
    this.signals = [];
    return queued;
  }

  getPositions() {
    return Object.fromEntries(this.positions);
  }
}

export function normalizeFundingRates(snapshot = [], fundingIntervalHours = 8) {
  return normalizeSnapshot(snapshot, fundingIntervalHours);
}
