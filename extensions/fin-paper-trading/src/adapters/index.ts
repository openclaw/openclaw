/**
 * Market adapter factory and re-exports.
 *
 * Each adapter bridges a specific broker/exchange API to provide
 * a unified interface for price queries, order submission, and
 * account state retrieval across US equity, HK equity, and CN A-share markets.
 */
import type { MarketAdapter } from "./types.js";
import { AlpacaAdapter } from "./alpaca-adapter.js";
import { FutuAdapter } from "./futu-adapter.js";
import { OpenCtpAdapter } from "./openctp-adapter.js";

export type {
  MarketAdapter,
  PriceQuote,
  AdapterOrderRequest,
  AdapterOrderResult,
  AdapterAccountState,
  AdapterPosition,
} from "./types.js";

export { AlpacaAdapter } from "./alpaca-adapter.js";
export { FutuAdapter } from "./futu-adapter.js";
export { OpenCtpAdapter } from "./openctp-adapter.js";

/** Create a market adapter by market + adapter name combination. */
export function createAdapter(market: string, adapterName: string): MarketAdapter {
  switch (`${market}:${adapterName}`) {
    case "us-equity:alpaca":
      return new AlpacaAdapter();
    case "hk-equity:futu":
      return new FutuAdapter();
    case "cn-a-share:openctp":
      return new OpenCtpAdapter();
    default:
      throw new Error(
        `Unknown adapter: ${market}/${adapterName}. ` +
          `Supported: us-equity/alpaca, hk-equity/futu, cn-a-share/openctp`,
      );
  }
}
