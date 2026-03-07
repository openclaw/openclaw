import type { MarketDefinition } from "../types.js";

export const HK_EQUITY: MarketDefinition = {
  type: "hk_equity",
  name: "HK Equity",
  timezone: "Asia/Hong_Kong",
  sessions: [
    { open: { hour: 9, minute: 30 }, close: { hour: 12, minute: 0 } },
    { open: { hour: 13, minute: 0 }, close: { hour: 16, minute: 0 } },
  ],
  lotSize: { minLot: 100, buyMustBeMultiple: true, sellMustBeMultiple: false },
  priceLimit: { enabled: false, defaultPct: 0 },
  settlement: { tPlusDays: 0 },
  commissionRates: { maker: 0.0005, taker: 0.0005, stampDuty: 0.001 },
};
