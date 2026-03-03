/**
 * Constant slippage model for paper trading fill simulation.
 *
 * Canonical implementation lives in @openfinclaw/fin-shared-types.
 * Re-exported here for backward compatibility within fin-paper-trading.
 */

export type { FillResult } from "../../shared/types.js";
export { applyConstantSlippage } from "../../shared/fill-simulation.js";
