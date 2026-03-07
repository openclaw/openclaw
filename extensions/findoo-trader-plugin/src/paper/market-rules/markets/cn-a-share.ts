import type { MarketDefinition } from "../types.js";

export const CN_A_SHARE: MarketDefinition = {
  type: "cn_a_share",
  name: "CN A-Share",
  timezone: "Asia/Shanghai",
  sessions: [
    { open: { hour: 9, minute: 30 }, close: { hour: 11, minute: 30 } },
    { open: { hour: 13, minute: 0 }, close: { hour: 15, minute: 0 } },
  ],
  lotSize: { minLot: 100, buyMustBeMultiple: true, sellMustBeMultiple: false },
  priceLimit: {
    enabled: true,
    defaultPct: 10,
    categories: [
      {
        name: "创业板/科创板",
        match: (symbol: string) => {
          const code = symbol.replace(/\.(SH|SZ)$/, "");
          return (
            code.startsWith("300") ||
            code.startsWith("301") ||
            code.startsWith("688") ||
            code.startsWith("689")
          );
        },
        pct: 20,
      },
    ],
  },
  settlement: { tPlusDays: 1 },
  commissionRates: { maker: 0.0003, taker: 0.0003, stampDuty: 0.001 },
};
