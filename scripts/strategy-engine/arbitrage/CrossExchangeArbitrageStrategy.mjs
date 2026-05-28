function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeExchangeId(value, fallback) {
  const id = String(value ?? fallback).trim();
  return id || fallback;
}

function normalizeQuote(input = {}) {
  const bid = finiteNumber(input.bid, Number.NaN);
  const ask = finiteNumber(input.ask, Number.NaN);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
    return null;
  }
  return { bid, ask };
}

export class CrossExchangeArbitrageStrategy {
  constructor(config = {}) {
    this.name = String(config.name ?? "cross-exchange-arbitrage");
    this.params = { ...config.params };
    this.enabled = config.enabled !== false;
    this.autoExecute = config.auto === true && config.allowAutoExecute === true;
    this.symbol = String(this.params.symbol ?? config.symbol ?? "BTC-USDT");
    this.exchangeA = normalizeExchangeId(
      config.exchangeA?.id ?? this.params.exchangeA?.id,
      "exchangeA",
    );
    this.exchangeB = normalizeExchangeId(
      config.exchangeB?.id ?? this.params.exchangeB?.id,
      "exchangeB",
    );
    this.qty = Math.max(0, finiteNumber(this.params.qty, 0.01));
    this.feePct = Math.max(0, finiteNumber(this.params.feePct, 0.001));
    this.minSpreadPct = Math.max(0, finiteNumber(this.params.minSpreadPct, 0.003));
    this.cooldownMs = Math.max(0, finiteNumber(this.params.cooldownSec, 30) * 1000);
    this.now = typeof config.now === "function" ? config.now : () => new Date();
    this.signals = [];
    this.lastSignalAt = Number.NEGATIVE_INFINITY;
  }

  scan(snapshot = {}) {
    return this.evaluate(snapshot);
  }

  evaluate(snapshot = {}) {
    if (!this.enabled) {
      return null;
    }
    const now = this.now();
    const nowMs = now.getTime();
    if (nowMs - this.lastSignalAt < this.cooldownMs) {
      return null;
    }

    const quoteA = normalizeQuote(snapshot.exchangeA ?? snapshot.tickA ?? snapshot.a);
    const quoteB = normalizeQuote(snapshot.exchangeB ?? snapshot.tickB ?? snapshot.b);
    if (!quoteA || !quoteB) {
      return null;
    }

    const spreadAB = (quoteB.bid - quoteA.ask) / quoteA.ask - this.feePct * 2;
    const spreadBA = (quoteA.bid - quoteB.ask) / quoteB.ask - this.feePct * 2;

    if (spreadAB > this.minSpreadPct) {
      return this.pushSignal({
        now,
        spreadType: "AB",
        spreadPct: spreadAB,
        buyExchange: this.exchangeA,
        sellExchange: this.exchangeB,
        buyPrice: quoteA.ask,
        sellPrice: quoteB.bid,
        legADirection: "buy",
        legBDirection: "sell",
      });
    }

    if (spreadBA > this.minSpreadPct) {
      return this.pushSignal({
        now,
        spreadType: "BA",
        spreadPct: spreadBA,
        buyExchange: this.exchangeB,
        sellExchange: this.exchangeA,
        buyPrice: quoteB.ask,
        sellPrice: quoteA.bid,
        legADirection: "sell",
        legBDirection: "buy",
      });
    }

    return null;
  }

  pushSignal(details) {
    this.lastSignalAt = details.now.getTime();
    const signal = {
      time: details.now.toISOString(),
      type: "spread",
      strategy: this.name,
      direction: "open_spread",
      reason: [
        `cross_exchange=${details.spreadType}`,
        `buy=${details.buyExchange}@${details.buyPrice}`,
        `sell=${details.sellExchange}@${details.sellPrice}`,
        `spreadPct=${(details.spreadPct * 100).toFixed(3)}%`,
      ].join(" "),
      autoExecute: this.autoExecute,
      spreadPct: details.spreadPct,
      legA: {
        instrument: this.symbol,
        broker: this.exchangeA,
        direction: details.legADirection,
        price: details.legADirection === "buy" ? details.buyPrice : details.sellPrice,
        qty: this.qty,
      },
      legB: {
        instrument: this.symbol,
        broker: this.exchangeB,
        direction: details.legBDirection,
        price: details.legBDirection === "buy" ? details.buyPrice : details.sellPrice,
        qty: this.qty,
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
}
