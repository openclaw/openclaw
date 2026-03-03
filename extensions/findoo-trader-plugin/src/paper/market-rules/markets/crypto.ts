import type { MarketDefinition } from "../types.js";

export const CRYPTO: MarketDefinition = {
  type: "crypto",
  name: "Crypto",
  timezone: "UTC",
  sessions: [], // 24/7
  lotSize: { minLot: 0, buyMustBeMultiple: false, sellMustBeMultiple: false },
  priceLimit: { enabled: false, defaultPct: 0 },
  settlement: { tPlusDays: 0 },
  commissionRates: { maker: 0.0008, taker: 0.001 },
};
