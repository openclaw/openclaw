import type { MarketDefinition } from "../types.js";

export const US_EQUITY: MarketDefinition = {
  type: "us_equity",
  name: "US Equity",
  timezone: "America/New_York",
  sessions: [{ open: { hour: 9, minute: 30 }, close: { hour: 16, minute: 0 } }],
  lotSize: { minLot: 1, buyMustBeMultiple: false, sellMustBeMultiple: false },
  priceLimit: { enabled: false, defaultPct: 0 },
  settlement: { tPlusDays: 0 },
  commissionRates: { maker: 0.0005, taker: 0.0005 },
};
