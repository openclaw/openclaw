import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveConfig } from "./src/config.js";
import { DataHubClient } from "./src/datahub-client.js";
import { OHLCVCache } from "./src/ohlcv-cache.js";
import { RegimeDetector } from "./src/regime-detector.js";
import type { MarketType } from "./src/types.js";

/* ---------- helpers ---------- */

const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

/** Build query params from user-facing tool params. */
function buildParams(params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  if (params.symbol) out.symbol = String(params.symbol);
  if (params.start_date) out.start_date = String(params.start_date);
  if (params.end_date) out.end_date = String(params.end_date);
  if (params.trade_date) out.trade_date = String(params.trade_date);
  if (params.limit) out.limit = String(params.limit);
  if (params.provider) out.provider = String(params.provider);
  if (params.country) out.country = String(params.country);
  if (params.indicator) out.indicator = String(params.indicator);
  return out;
}

/* ---------- plugin ---------- */

const findooDatahubPlugin = {
  id: "findoo-datahub-plugin",
  name: "Findoo DataHub",
  description:
    "Unified financial data source powered by OpenBB DataHub — " +
    "172 endpoints covering equity (A/HK/US), crypto, macro, derivatives, index, ETF.",
  kind: "financial" as const,

  async register(api: OpenClawPluginApi) {
    const config = resolveConfig(api);

    // --- DataHub client ---
    const client = new DataHubClient(
      config.datahubApiUrl,
      config.datahubUsername,
      config.datahubPassword,
      config.requestTimeoutMs,
    );

    // --- Local cache + regime detector ---
    const dbPath = api.resolvePath("state/findoo-ohlcv-cache.sqlite");
    const cache = new OHLCVCache(dbPath);
    const regimeDetector = new RegimeDetector();

    // --- Data provider service (exposed to other extensions) ---
    const dataProvider = {
      async getOHLCV(params: {
        symbol: string;
        market: MarketType;
        timeframe: string;
        since?: number;
        limit?: number;
      }) {
        // Check cache first
        const range = cache.getRange(params.symbol, params.market, params.timeframe);
        if (range && params.since != null && params.limit != null) {
          const cached = cache.query(params.symbol, params.market, params.timeframe, params.since);
          if (cached.length >= params.limit) return cached.slice(0, params.limit);
        }

        const rows = await client.getOHLCV(params);
        if (rows.length > 0) {
          cache.upsertBatch(params.symbol, params.market, params.timeframe, rows);
        }

        if (range || rows.length > 0) {
          const all = cache.query(params.symbol, params.market, params.timeframe, params.since);
          return params.limit ? all.slice(0, params.limit) : all;
        }
        return rows;
      },

      async getTicker(symbol: string, market: MarketType) {
        return client.getTicker(symbol, market);
      },

      async detectRegime(params: { symbol: string; market: MarketType; timeframe: string }) {
        const ohlcv = await dataProvider.getOHLCV({
          symbol: params.symbol,
          market: params.market,
          timeframe: params.timeframe,
          limit: 300,
        });
        return regimeDetector.detect(ohlcv);
      },

      getSupportedMarkets() {
        return [
          { market: "crypto" as const, symbols: [], available: true },
          { market: "equity" as const, symbols: [], available: true },
          { market: "commodity" as const, symbols: [], available: true },
        ];
      },
    };

    // --- Register services ---
    api.registerService({
      id: "fin-data-provider",
      start: () => {},
      instance: dataProvider,
    } as Parameters<typeof api.registerService>[0]);

    api.registerService({
      id: "fin-regime-detector",
      start: () => {},
      instance: regimeDetector,
    } as Parameters<typeof api.registerService>[0]);

    // ============================================================
    // AI Tools (10 total)
    // ============================================================

    // === Tool 1: fin_stock — Equity data ===
    api.registerTool(
      {
        name: "fin_stock",
        label: "Stock Data (A/HK/US)",
        description:
          "Fetch A-share, HK, or US equity data — quotes, historical prices, income, balance sheet, cashflow, ratios, money flow, holders, dividends, news.",
        parameters: Type.Object({
          symbol: Type.String({
            description: "Stock code. A-shares: 600519.SH; HK: 00700.HK; US: AAPL",
          }),
          endpoint: Type.Unsafe<string>({
            type: "string",
            enum: [
              "price/historical",
              "fundamental/income",
              "fundamental/balance",
              "fundamental/cash",
              "fundamental/ratios",
              "fundamental/metrics",
              "fundamental/dividends",
              "ownership/top10_holders",
              "moneyflow/individual",
              "market/top_list",
              "discovery/gainers",
              "discovery/losers",
            ],
            description: "DataHub equity endpoint path",
          }),
          start_date: Type.Optional(Type.String({ description: "Start date, e.g. 2025-01-01" })),
          end_date: Type.Optional(Type.String({ description: "End date, e.g. 2025-12-31" })),
          limit: Type.Optional(Type.Number({ description: "Max records to return" })),
          provider: Type.Optional(
            Type.String({ description: "Data provider override (tushare, yfinance, polygon)" }),
          ),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const endpoint = String(params.endpoint ?? "price/historical");
            const qp = buildParams(params);
            const results = await client.equity(endpoint, qp);
            return json({
              success: true,
              endpoint: `equity/${endpoint}`,
              count: results.length,
              results,
            });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_stock"] },
    );

    // === Tool 2: fin_index — Index / ETF / Fund ===
    api.registerTool(
      {
        name: "fin_index",
        label: "Index / ETF / Fund",
        description:
          "Query index constituents, valuations, ETF prices/NAV, fund manager/portfolio.",
        parameters: Type.Object({
          symbol: Type.Optional(
            Type.String({ description: "Index/ETF/fund code. Index: 000300.SH; ETF: 510050.SH" }),
          ),
          endpoint: Type.Unsafe<string>({
            type: "string",
            enum: [
              "price/historical",
              "constituents",
              "daily_basic",
              "thematic/ths_index",
              "thematic/ths_daily",
              "thematic/ths_member",
            ],
            description: "DataHub index endpoint path",
          }),
          start_date: Type.Optional(Type.String()),
          end_date: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Number()),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const endpoint = String(params.endpoint ?? "price/historical");
            const qp = buildParams(params);
            const results = await client.index(endpoint, qp);
            return json({
              success: true,
              endpoint: `index/${endpoint}`,
              count: results.length,
              results,
            });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_index"] },
    );

    // === Tool 3: fin_macro — Economy / Rates / FX ===
    api.registerTool(
      {
        name: "fin_macro",
        label: "Macro / Rates / FX",
        description:
          "China macro (GDP/CPI/PPI/PMI/M2), interest rates (Shibor/LPR/Libor/Hibor), treasury yields, FX, WorldBank data.",
        parameters: Type.Object({
          endpoint: Type.Unsafe<string>({
            type: "string",
            enum: [
              "gdp/real",
              "cpi",
              "ppi",
              "pmi",
              "money_supply",
              "social_financing",
              "shibor",
              "shibor_lpr",
              "libor",
              "hibor",
              "treasury_cn",
              "treasury_us",
              "index_global",
              "calendar",
              "worldbank/gdp",
              "worldbank/population",
              "worldbank/inflation",
              "worldbank/indicator",
            ],
            description: "DataHub economy endpoint path",
          }),
          symbol: Type.Optional(Type.String({ description: "Currency pair or indicator code" })),
          country: Type.Optional(Type.String({ description: "Country code for WorldBank" })),
          start_date: Type.Optional(Type.String()),
          end_date: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Number()),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const endpoint = String(params.endpoint ?? "cpi");
            const qp = buildParams(params);
            const results = await client.economy(endpoint, qp);
            return json({
              success: true,
              endpoint: `economy/${endpoint}`,
              count: results.length,
              results,
            });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_macro"] },
    );

    // === Tool 4: fin_derivatives — Futures / Options / CB ===
    api.registerTool(
      {
        name: "fin_derivatives",
        label: "Futures / Options / CB",
        description:
          "Futures (daily, holdings, settlement, warehouse, mapping), options (basic, daily, chains), convertible bonds.",
        parameters: Type.Object({
          symbol: Type.Optional(
            Type.String({ description: "Contract code, e.g. IF2501.CFX, 113xxx.SH (CB)" }),
          ),
          endpoint: Type.Unsafe<string>({
            type: "string",
            enum: [
              "futures/historical",
              "futures/info",
              "futures/holding",
              "futures/settle",
              "futures/warehouse",
              "futures/mapping",
              "options/basic",
              "options/daily",
              "options/chains",
              "convertible/basic",
              "convertible/daily",
            ],
            description: "DataHub derivatives endpoint path",
          }),
          trade_date: Type.Optional(Type.String({ description: "Trade date, e.g. 2025-02-28" })),
          start_date: Type.Optional(Type.String()),
          end_date: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Number()),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const endpoint = String(params.endpoint ?? "futures/historical");
            const qp = buildParams(params);
            const results = await client.derivatives(endpoint, qp);
            return json({
              success: true,
              endpoint: `derivatives/${endpoint}`,
              count: results.length,
              results,
            });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_derivatives"] },
    );

    // === Tool 5: fin_crypto — Crypto & DeFi ===
    api.registerTool(
      {
        name: "fin_crypto",
        label: "Crypto & DeFi",
        description:
          "Crypto market data (tickers, orderbook, funding rates) via CEX, DeFi (TVL, yields, stablecoins, fees, DEX volumes) via DefiLlama, market cap rankings via CoinGecko.",
        parameters: Type.Object({
          endpoint: Type.Unsafe<string>({
            type: "string",
            enum: [
              "market/ticker",
              "market/tickers",
              "market/orderbook",
              "market/trades",
              "market/funding_rate",
              "coin/market",
              "coin/historical",
              "coin/info",
              "coin/categories",
              "coin/trending",
              "coin/global_stats",
              "defi/protocols",
              "defi/tvl_historical",
              "defi/protocol_tvl",
              "defi/chains",
              "defi/yields",
              "defi/stablecoins",
              "defi/fees",
              "defi/dex_volumes",
              "defi/coin_prices",
            ],
            description: "DataHub crypto endpoint path",
          }),
          symbol: Type.Optional(
            Type.String({ description: "Coin ID, trading pair, or protocol slug" }),
          ),
          limit: Type.Optional(Type.Number()),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const endpoint = String(params.endpoint ?? "coin/market");
            const qp = buildParams(params);
            const results = await client.crypto(endpoint, qp);
            return json({
              success: true,
              endpoint: `crypto/${endpoint}`,
              count: results.length,
              results,
            });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_crypto"] },
    );

    // === Tool 6: fin_market — Market Radar ===
    api.registerTool(
      {
        name: "fin_market",
        label: "Market Radar",
        description:
          "Market monitoring — dragon-tiger list, limit-up/down stats, block trades, sector money flow, margin, Stock Connect flows, global index, IPO calendar.",
        parameters: Type.Object({
          endpoint: Type.Unsafe<string>({
            type: "string",
            enum: [
              "market/top_list",
              "market/top_inst",
              "market/limit_list",
              "market/suspend",
              "market/trade_calendar",
              "moneyflow/individual",
              "moneyflow/industry",
              "moneyflow/block_trade",
              "margin/summary",
              "margin/detail",
              "flow/hsgt_flow",
              "flow/hsgt_top10",
              "discovery/gainers",
              "discovery/losers",
              "discovery/active",
              "discovery/new_share",
            ],
            description: "DataHub equity endpoint for market data",
          }),
          trade_date: Type.Optional(Type.String({ description: "Trade date, e.g. 2025-02-28" })),
          symbol: Type.Optional(Type.String({ description: "Symbol for specific queries" })),
          start_date: Type.Optional(Type.String()),
          end_date: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Number()),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const endpoint = String(params.endpoint ?? "market/top_list");
            const qp = buildParams(params);
            const results = await client.equity(endpoint, qp);
            return json({
              success: true,
              endpoint: `equity/${endpoint}`,
              count: results.length,
              results,
            });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_market"] },
    );

    // === Tool 7: fin_query — Raw DataHub Query (fallback) ===
    api.registerTool(
      {
        name: "fin_query",
        label: "Raw DataHub Query",
        description:
          "Direct passthrough to any of 172 DataHub endpoints by path. Use when other tools don't cover the specific data.",
        parameters: Type.Object({
          path: Type.String({
            description:
              "Full endpoint path after /api/v1/, e.g. equity/fundamental/income, crypto/defi/protocols, economy/cpi",
          }),
          params: Type.Optional(
            Type.Record(Type.String(), Type.String(), {
              description: "Query parameters as key-value pairs",
            }),
          ),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const path = String(params.path ?? "").trim();
            if (!path) throw new Error("path is required");
            const qp = (params.params ?? {}) as Record<string, string>;
            const results = await client.query(path, qp);
            return json({ success: true, endpoint: path, count: results.length, results });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_query"] },
    );

    // === Tool 8: fin_data_ohlcv — OHLCV with caching ===
    api.registerTool(
      {
        name: "fin_data_ohlcv",
        label: "OHLCV Data",
        description: "Fetch OHLCV candle data with local SQLite caching via DataHub.",
        parameters: Type.Object({
          symbol: Type.String({
            description: "Trading pair (e.g. BTC/USDT, AAPL, 600519.SH)",
          }),
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

            const ohlcv = await dataProvider.getOHLCV({ symbol, market, timeframe, since, limit });

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

    // === Tool 9: fin_data_regime — Market Regime Detection ===
    api.registerTool(
      {
        name: "fin_data_regime",
        label: "Market Regime",
        description:
          "Detect market regime (bull/bear/sideways/volatile/crisis) using SMA/ATR analysis on DataHub OHLCV data.",
        parameters: Type.Object({
          symbol: Type.String({ description: "Trading pair (e.g. BTC/USDT, 600519.SH)" }),
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
              description: "Candle timeframe (default: 4h)",
            }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const symbol = params.symbol as string;
            const market = (params.market as MarketType | undefined) ?? "crypto";
            const timeframe = (params.timeframe as string | undefined) ?? "4h";
            const regime = await dataProvider.detectRegime({ symbol, market, timeframe });
            return json({ symbol, market, timeframe, regime });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_data_regime"] },
    );

    // === Tool 10: fin_data_markets — Supported Markets ===
    api.registerTool(
      {
        name: "fin_data_markets",
        label: "Supported Markets",
        description: "List all supported market types and data categories",
        parameters: Type.Object({}),
        async execute() {
          return json({
            datahub: config.datahubApiUrl,
            markets: dataProvider.getSupportedMarkets(),
            categories: [
              "equity",
              "crypto",
              "economy",
              "derivatives",
              "index",
              "etf",
              "currency",
              "coverage",
            ],
            endpoints: 172,
          });
        },
      },
      { names: ["fin_data_markets"] },
    );
  },
};

export default findooDatahubPlugin;
