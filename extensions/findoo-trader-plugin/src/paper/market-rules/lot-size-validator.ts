import { MARKET_REGISTRY } from "./markets/index.js";
import type { ExtendedMarketType } from "./types.js";

export interface LotSizeCheckResult {
  valid: boolean;
  reason?: string;
}

export function validateLotSize(
  market: ExtendedMarketType,
  side: "buy" | "sell",
  quantity: number,
): LotSizeCheckResult {
  const def = MARKET_REGISTRY[market];
  if (!def) return { valid: true };

  const rule = def.lotSize;
  if (rule.minLot === 0) return { valid: true };

  const mustBeMultiple = side === "buy" ? rule.buyMustBeMultiple : rule.sellMustBeMultiple;
  if (!mustBeMultiple) return { valid: true };

  if (quantity % rule.minLot !== 0) {
    return {
      valid: false,
      reason: `${market} ${side} quantity must be a multiple of ${rule.minLot}, got ${quantity}`,
    };
  }

  return { valid: true };
}
