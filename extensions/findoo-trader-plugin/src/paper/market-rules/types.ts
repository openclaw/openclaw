/** Extended market type used within paper-trading for multi-market rules. */
export type ExtendedMarketType = "crypto" | "us_equity" | "hk_equity" | "cn_a_share";

export interface TradingSession {
  open: { hour: number; minute: number };
  close: { hour: number; minute: number };
}

export interface MarketDefinition {
  type: ExtendedMarketType;
  name: string;
  timezone: string;
  sessions: TradingSession[];
  lotSize: LotSizeRule;
  priceLimit: PriceLimitRule;
  settlement: SettlementRule;
  commissionRates: { maker: number; taker: number; stampDuty?: number };
}

export interface LotSizeRule {
  /** Minimum order quantity step. 0 = no restriction. */
  minLot: number;
  /** Whether buy orders must be multiples of minLot. */
  buyMustBeMultiple: boolean;
  /** Whether sell orders must be multiples of minLot. */
  sellMustBeMultiple: boolean;
}

export interface PriceLimitRule {
  enabled: boolean;
  /** Default price limit percentage (e.g. 10 = ±10%). */
  defaultPct: number;
  /** Category-specific overrides. */
  categories?: Array<{
    name: string;
    match: (symbol: string) => boolean;
    pct: number;
  }>;
}

export interface SettlementRule {
  /** T+N settlement. 0 = same-day settlement (crypto/US). */
  tPlusDays: number;
}
