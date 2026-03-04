/**
 * Factory for creating UnifiedExchangeAdapter instances from ExchangeConfig.
 * Routes to the correct adapter based on exchange type:
 *   - CCXT (binance, okx, bybit, hyperliquid) for crypto
 *   - Alpaca for US equity
 *   - Futu for HK equity
 */
import type { ExchangeRegistry } from "../exchange-registry.js";
import type { ExchangeConfig } from "../types.js";
import { isCryptoExchange } from "../types.js";
import type { UnifiedExchangeAdapter } from "./adapter-interface.js";
import { AlpacaAdapter } from "./alpaca-adapter.js";
import { CcxtAdapter } from "./ccxt-adapter.js";
import { FutuAdapter } from "./futu-adapter.js";

/**
 * Create an adapter for the given exchange configuration.
 * @param exchangeId - The user-assigned exchange identifier (e.g. "binance-test")
 * @param config - Exchange configuration from openclaw.yaml
 * @param registry - ExchangeRegistry for CCXT instance management
 */
export function createAdapter(
  exchangeId: string,
  config: ExchangeConfig,
  registry: ExchangeRegistry,
): UnifiedExchangeAdapter {
  if (isCryptoExchange(config.exchange)) {
    return new CcxtAdapter(exchangeId, config.testnet ?? false, registry);
  }

  if (config.exchange === "alpaca") {
    if (!config.apiKey || !config.secret) {
      throw new Error(`Alpaca adapter requires apiKey and secret. Configure them in financial.exchanges.${exchangeId}.`);
    }
    return new AlpacaAdapter(
      exchangeId,
      config.paper ?? config.testnet ?? true, // default to paper mode
      config.apiKey,
      config.secret,
    );
  }

  if (config.exchange === "futu") {
    return new FutuAdapter(
      exchangeId,
      config.testnet ?? false,
      config.host,
      config.port,
    );
  }

  throw new Error(
    `Unsupported exchange type: "${config.exchange}". ` +
      `Supported: binance, okx, bybit, hyperliquid (crypto), alpaca (US equity), futu (HK equity).`,
  );
}
