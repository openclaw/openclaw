/**
 * Commission models for different asset classes.
 * Returns the commission amount and effective rate for a given notional value.
 */

export interface CommissionResult {
  commission: number;
  effectiveRate: number;
}

/** Default commission rates by market and side. */
const RATES: Record<string, { maker: number; taker: number; stampDuty?: number }> = {
  crypto: { maker: 0.0008, taker: 0.001 },
  equity: { maker: 0.0005, taker: 0.0005 },
  commodity: { maker: 0.0006, taker: 0.0006 },
  us_equity: { maker: 0.0005, taker: 0.0005 },
  hk_equity: { maker: 0.0005, taker: 0.0005, stampDuty: 0.001 },
  cn_a_share: { maker: 0.0003, taker: 0.0003, stampDuty: 0.001 },
};

/**
 * Calculate commission for a trade.
 * @param notional  Total trade value (price * quantity).
 * @param market    Asset class or extended market type.
 * @param options   Optional: maker/taker side (defaults to taker), trade side for stamp duty.
 */
export function calculateCommission(
  notional: number,
  market: string,
  options?: { makerTaker?: "maker" | "taker"; side?: "buy" | "sell" },
): CommissionResult {
  if (notional === 0) {
    return { commission: 0, effectiveRate: 0 };
  }

  const makerTaker = options?.makerTaker ?? "taker";
  const rates = RATES[market] ?? RATES.equity!;
  const rate = makerTaker === "maker" ? rates.maker : rates.taker;
  let commission = notional * rate;

  // Stamp duty applies only on sell side
  if (rates.stampDuty && options?.side === "sell") {
    commission += notional * rates.stampDuty;
  }

  const effectiveRate = notional > 0 ? commission / notional : 0;

  return { commission, effectiveRate };
}
