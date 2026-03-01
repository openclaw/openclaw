import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import { createCryptoAdapter } from "./src/adapters/crypto-adapter.js";
import type { CcxtExchange } from "./src/adapters/crypto-adapter.js";
import { createEquityAdapter } from "./src/adapters/equity-adapter.js";
import type { DataHubGateway, EquityAdapter } from "./src/adapters/equity-adapter.js";
import { createYahooAdapter } from "./src/adapters/yahoo-adapter.js";
import type { YahooFinanceClient } from "./src/adapters/yahoo-adapter.js";
import { OHLCVCache } from "./src/ohlcv-cache.js";
import { RegimeDetector } from "./src/regime-detector.js";
import type { MarketType } from "./src/types.js";
import { UnifiedDataProvider } from "./src/unified-provider.js";

type ExchangeRegistry = {
  getInstance: (id: string) => Promise<unknown>;
  listExchanges: () => Array<{ id: string; exchange: string; testnet: boolean }>;
};

const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

function getRegistry(api: OpenClawPluginApi): ExchangeRegistry {
  const runtime = api.runtime as unknown as { services?: Map<string, unknown> };
  const registry = runtime.services?.get?.("fin-exchange-registry") as ExchangeRegistry | undefined;
  if (!registry) {
    throw new Error("fin-core plugin not loaded — exchange registry unavailable");
  }
  return registry;
}

const finDataBusPlugin = {
  id: "fin-data-bus",
  name: "Data Bus",
  description: "Unified multi-market data bus with OHLCV cache and regime detection",
  kind: "financial" as const,

  async register(api: OpenClawPluginApi) {
    const dbPath = api.resolvePath("state/fin-ohlcv-cache.sqlite");
    const cache = new OHLCVCache(dbPath);
    const regimeDetector = new RegimeDetector();

    const getExchangeInstance = async (id?: string): Promise<CcxtExchange> => {
      const registry = getRegistry(api);
      let exchangeId = id;
      if (!exchangeId || exchangeId === "default") {
        const exchanges = registry.listExchanges();
        if (exchanges.length === 0) {
          throw new Error(
            "No exchanges configured. Run: openfinclaw exchange add <name> --exchange binance --api-key <key> --secret <secret>",
          );
        }
        exchangeId = exchanges[0]!.id;
      }
      return (await registry.getInstance(exchangeId)) as CcxtExchange;
    };

    const cryptoAdapter = createCryptoAdapter(cache, getExchangeInstance);

    // Try to get equity data gateway from fin-data-hub plugin
    const runtime = api.runtime as unknown as { services?: Map<string, unknown> };
    const gateway = runtime.services?.get?.("fin-datahub-gateway") as DataHubGateway | undefined;
    let equityAdapter: EquityAdapter | undefined;
    if (gateway) {
      equityAdapter = createEquityAdapter(cache, gateway);
    } else {
      // Fallback: Yahoo Finance as free equity data source
      try {
        const yf = await import("yahoo-finance2");
        const yahooClient = (yf.default ?? yf) as unknown as YahooFinanceClient;
        equityAdapter = createYahooAdapter(cache, yahooClient);
      } catch {
        // yahoo-finance2 not installed; equity stays disabled
      }
    }

    const provider = new UnifiedDataProvider(cryptoAdapter, regimeDetector, equityAdapter);

    // Register services for other plugins to consume
    api.registerService({
      id: "fin-data-provider",
      start: () => {},
      instance: provider,
    } as Parameters<typeof api.registerService>[0]);

    api.registerService({
      id: "fin-regime-detector",
      start: () => {},
      instance: regimeDetector,
    } as Parameters<typeof api.registerService>[0]);

    // --- fin_data_ohlcv ---
    api.registerTool(
      {
        name: "fin_data_ohlcv",
        label: "OHLCV Data",
        description: "Fetch OHLCV candle data with local caching for a symbol",
        parameters: Type.Object({
          symbol: Type.String({ description: "Trading pair symbol (e.g. BTC/USDT)" }),
          market: Type.Optional(
            Type.Unsafe<"crypto" | "equity" | "commodity">({
              type: "string",
              enum: ["crypto", "equity", "commodity"],
              description: "Market type (default: crypto)",
            }),
          ),
          timeframe: Type.Optional(
            Type.Unsafe<"1m" | "5m" | "1h" | "4h" | "1d">({
              type: "string",
              enum: ["1m", "5m", "1h", "4h", "1d"],
              description: "Candle timeframe (default: 1h)",
            }),
          ),
          since: Type.Optional(Type.Number({ description: "Start timestamp in Unix ms" })),
          limit: Type.Optional(Type.Number({ description: "Number of candles to return" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const symbol = params.symbol as string;
            const market = (params.market as MarketType | undefined) ?? "crypto";
            const timeframe = (params.timeframe as string | undefined) ?? "1h";
            const since = params.since as number | undefined;
            const limit = params.limit as number | undefined;

            const ohlcv = await provider.getOHLCV({ symbol, market, timeframe, since, limit });

            return json({
              symbol,
              market,
              timeframe,
              count: ohlcv.length,
              candles: ohlcv.map((bar) => ({
                timestamp: new Date(bar.timestamp).toISOString(),
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                volume: bar.volume,
              })),
            });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_data_ohlcv"] },
    );

    // --- fin_data_regime ---
    api.registerTool(
      {
        name: "fin_data_regime",
        label: "Market Regime",
        description:
          "Detect the current market regime (bull/bear/sideways/volatile/crisis) for a symbol",
        parameters: Type.Object({
          symbol: Type.String({ description: "Trading pair symbol (e.g. BTC/USDT)" }),
          market: Type.Optional(
            Type.Unsafe<"crypto" | "equity" | "commodity">({
              type: "string",
              enum: ["crypto", "equity", "commodity"],
              description: "Market type (default: crypto)",
            }),
          ),
          timeframe: Type.Optional(
            Type.Unsafe<"1m" | "5m" | "1h" | "4h" | "1d">({
              type: "string",
              enum: ["1m", "5m", "1h", "4h", "1d"],
              description: "Candle timeframe for analysis (default: 4h)",
            }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const symbol = params.symbol as string;
            const market = (params.market as MarketType | undefined) ?? "crypto";
            const timeframe = (params.timeframe as string | undefined) ?? "4h";

            const regime = await provider.detectRegime({ symbol, market, timeframe });

            return json({ symbol, market, timeframe, regime });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_data_regime"] },
    );

    // --- fin_data_markets ---
    api.registerTool(
      {
        name: "fin_data_markets",
        label: "Supported Markets",
        description: "List supported market types and their availability",
        parameters: Type.Object({}),
        async execute() {
          const markets = provider.getSupportedMarkets();
          return json({ markets });
        },
      },
      { names: ["fin_data_markets"] },
    );
  },
};

export default finDataBusPlugin;
