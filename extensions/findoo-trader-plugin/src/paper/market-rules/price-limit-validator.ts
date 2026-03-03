import { MARKET_REGISTRY } from "./markets/index.js";
import type { ExtendedMarketType } from "./types.js";

export interface PriceLimitCheckResult {
  valid: boolean;
  reason?: string;
  upperLimit?: number;
  lowerLimit?: number;
}

export function checkPriceLimit(
  market: ExtendedMarketType,
  symbol: string,
  fillPrice: number,
  prevClose?: number,
  options?: { isSt?: boolean },
): PriceLimitCheckResult {
  const def = MARKET_REGISTRY[market];
  if (!def || !def.priceLimit.enabled) return { valid: true };
  if (prevClose == null || prevClose <= 0) return { valid: true };

  let limitPct = def.priceLimit.defaultPct;

  // Check ST override first (takes priority for cn_a_share)
  if (options?.isSt && market === "cn_a_share") {
    limitPct = 5;
  } else if (def.priceLimit.categories) {
    for (const cat of def.priceLimit.categories) {
      if (cat.match(symbol)) {
        limitPct = cat.pct;
        break;
      }
    }
  }

  const upperLimit = prevClose * (1 + limitPct / 100);
  const lowerLimit = prevClose * (1 - limitPct / 100);

  if (fillPrice > upperLimit || fillPrice < lowerLimit) {
    return {
      valid: false,
      reason: `Price ${fillPrice} exceeds ${market} price limit (+-${limitPct}%) based on prevClose ${prevClose}. Range: [${lowerLimit.toFixed(2)}, ${upperLimit.toFixed(2)}]`,
      upperLimit,
      lowerLimit,
    };
  }

  return { valid: true, upperLimit, lowerLimit };
}
