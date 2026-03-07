import type { ExtendedMarketType, MarketDefinition } from "../types.js";
import { CN_A_SHARE } from "./cn-a-share.js";
import { CRYPTO } from "./crypto.js";
import { HK_EQUITY } from "./hk-equity.js";
import { US_EQUITY } from "./us-equity.js";

export const MARKET_REGISTRY: Record<ExtendedMarketType, MarketDefinition> = {
  crypto: CRYPTO,
  us_equity: US_EQUITY,
  hk_equity: HK_EQUITY,
  cn_a_share: CN_A_SHARE,
};

export function getMarketDefinition(type: ExtendedMarketType): MarketDefinition {
  return MARKET_REGISTRY[type];
}
