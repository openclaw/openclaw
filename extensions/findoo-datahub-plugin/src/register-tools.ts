import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { DataHubClient } from "./datahub-client.js";
import { buildParams, dateRangeParams, json, registerCategoryTool } from "./tool-helpers.js";
import type { MarketType } from "./types.js";

type DataProvider = {
  getOHLCV: (p: {
    symbol: string;
    market: MarketType;
    timeframe: string;
    since?: number;
    limit?: number;
  }) => Promise<import("./types.js").OHLCV[]>;
  detectRegime: (p: {
    symbol: string;
    market: MarketType;
    timeframe: string;
  }) => Promise<import("./types.js").MarketRegime>;
  getSupportedMarkets: () => import("./types.js").MarketInfo[];
};

export function registerAllTools(
  api: OpenClawPluginApi,
  client: DataHubClient,
  dataProvider: DataProvider,
  datahubApiUrl: string,
) {
  // ============================================================
  // Tool 1: fin_stock — Individual equity data (A/HK/US)
  // ============================================================
  registerCategoryTool(api, client, {
    name: "fin_stock",
    label: "Stock Data (A/HK/US)",
    description:
      "Fetch A-share, HK, or US equity data -- quotes, historical prices, financials (income/balance/cash/ratios/metrics + VIP variants), ownership (top10/shareholder_trade/repurchase/pledge), money flow. Notes: estimates/consensus is yfinance-only (US/HK, rate-limited, NOT for A-share -- use fundamental/earnings_forecast instead). fundamental/stock_factor returns pre-computed MACD/KDJ/RSI/BOLL/CCI.",
    category: "equity",
    defaultEndpoint: "price/historical",
    clientMethod: (c, ep, qp) => c.equity(ep, qp),
    parameters: Type.Object({
      symbol: Type.String({
        description: "Stock code. A-shares: 600519.SH; HK: 00700.HK; US: AAPL",
      }),
      endpoint: Type.Unsafe<string>({
        type: "string",
        enum: [
          "price/historical",
          "price/quote",
          "profile",
          "search",
          "screener",
          // fundamentals
          "fundamental/income",
          "fundamental/balance",
          "fundamental/cash",
          "fundamental/ratios",
          "fundamental/metrics",
          "fundamental/dividends",
          "fundamental/adj_factor",
          "fundamental/earnings_forecast",
          "fundamental/financial_audit",
          "fundamental/financial_express",
          "fundamental/forecast_vip",
          "fundamental/revenue_per_segment",
          "fundamental/management",
          // ownership & structure
          "ownership/top10_holders",
          "ownership/top10_float_holders",
          "ownership/major_holders",
          "ownership/shareholder_trade",
          "ownership/repurchase",
          "ownership/share_float",
          "ownership/holder_number",
          "ownership/share_statistics",
          "pledge/stat",
          "pledge/detail",
          // money flow (individual stock level)
          "moneyflow/individual",
          // concept
          "concept/concept_detail",
          "concept/concept_list",
          // estimates (yfinance only)
          "estimates/consensus",
          // VIP / tushare-only
          "fundamental/backup_daily",
          "fundamental/balance_vip",
          "fundamental/cashflow_vip",
          "fundamental/dividend_detail",
          "fundamental/historical_splits",
          "fundamental/income_vip",
          "fundamental/revenue_segment_vip",
          "fundamental/stock_factor",
          // HK subset
          "hk/income",
          "hk/balancesheet",
          "hk/cashflow",
          "hk/fina_indicator",
          "hk/basic",
          "hk/hold",
          "hk/adj_factor",
          "hk/trade_cal",
          // US subset
          "us/income",
          "us/balancesheet",
          "us/cashflow",
          "us/fina_indicator",
          "us/basic",
          "us/adj_factor",
          "us/trade_cal",
        ],
        description: "DataHub equity endpoint path",
      }),
      ...dateRangeParams,
      provider: Type.Optional(
        Type.String({ description: "Data provider override (tushare, yfinance, massive)" }),
      ),
    }),
  });

  // ============================================================
  // Tool 2: fin_index — Index / ETF / Fund
  // ============================================================
  registerCategoryTool(api, client, {
    name: "fin_index",
    label: "Index / ETF / Fund",
    description:
      "Query index data -- constituents, daily valuations (PE/PB via daily_basic), thematic/concept indices (ths_index/ths_daily/ths_member), classification, global indices. Use constituents (not members) for index composition.",
    category: "index",
    defaultEndpoint: "price/historical",
    clientMethod: (c, ep, qp) => c.index(ep, qp),
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
          "available",
          "info",
          "classify",
          "global_index",
          "thematic/ths_index",
          "thematic/ths_daily",
          "thematic/ths_member",
        ],
        description: "DataHub index endpoint path",
      }),
      ...dateRangeParams,
    }),
  });

  // ============================================================
  // Tool 3: fin_macro — Economy / Rates / FX
  // ============================================================
  api.registerTool(
    {
      name: "fin_macro",
      label: "Macro / Rates / FX",
      description:
        "China macro (GDP/CPI/PPI/PMI/M2/social financing), interest rates (Shibor/LPR/Libor/Hibor), CN/US treasury yields, FX rates (currency/*), WorldBank data (worldbank/*), economic calendar, fixedincome rate aliases, company news. Notes: LIBOR terminated 2023 (data stops 2020-06).",
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
            "shibor_quote",
            "libor",
            "hibor",
            "treasury_cn",
            "treasury_us",
            "index_global",
            "wz_index",
            "calendar",
            "currency/price/historical",
            "currency/search",
            "currency/snapshots",
            "worldbank/country",
            "worldbank/gdp",
            "worldbank/population",
            "worldbank/inflation",
            "worldbank/indicator",
            "fixedincome/rate/shibor",
            "fixedincome/rate/shibor_lpr",
            "fixedincome/rate/libor",
            "fixedincome/rate/hibor",
            "news/company",
          ],
          description: "DataHub economy/currency/news endpoint path",
        }),
        symbol: Type.Optional(
          Type.String({ description: "Currency pair or stock symbol for news" }),
        ),
        country: Type.Optional(Type.String({ description: "Country code for WorldBank" })),
        ...dateRangeParams,
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const endpoint = String(params.endpoint ?? "cpi");
          const qp = buildParams(params);
          let results: unknown[];
          let category: string;
          if (endpoint.startsWith("currency/")) {
            results = await client.currency(endpoint.replace("currency/", ""), qp);
            category = "currency";
          } else if (endpoint.startsWith("fixedincome/")) {
            results = await client.query(endpoint, qp);
            category = "fixedincome";
          } else if (endpoint.startsWith("news/")) {
            results = await client.query(endpoint, qp);
            category = "news";
          } else {
            results = await client.economy(endpoint, qp);
            category = "economy";
          }
          return json({
            success: true,
            endpoint: `${category}/${endpoint.replace(/^(currency|fixedincome|news)\//, "")}`,
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

  // ============================================================
  // Tool 4: fin_derivatives — Futures / Options / CB
  // ============================================================
  registerCategoryTool(api, client, {
    name: "fin_derivatives",
    label: "Futures / Options / CB",
    description:
      "Futures (daily OHLCV, holdings/OI, settlement, warehouse receipts, contract mapping, term structure curve), options (basic info, daily, chains with Greeks/IV), convertible bonds (basic, daily). Use futures/curve for contango/backwardation analysis.",
    category: "derivatives",
    defaultEndpoint: "futures/historical",
    clientMethod: (c, ep, qp) => c.derivatives(ep, qp),
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
          "futures/curve",
          "options/basic",
          "options/daily",
          "options/chains",
          "convertible/basic",
          "convertible/daily",
        ],
        description: "DataHub derivatives endpoint path",
      }),
      trade_date: Type.Optional(Type.String({ description: "Trade date, e.g. 2025-02-28" })),
      ...dateRangeParams,
    }),
  });

  // ============================================================
  // Tool 5: fin_crypto — Crypto & DeFi
  // ============================================================
  api.registerTool(
    {
      name: "fin_crypto",
      label: "Crypto & DeFi",
      description:
        "Crypto market data (ticker/orderbook/trades/funding_rate) via CEX, DeFi (protocols/TVL/yields/stablecoins/fees/dex_volumes/bridges/chains) via DefiLlama, market metrics (coin/market/info/categories/trending/global_stats) via CoinGecko. price/historical for crypto OHLCV, search for symbol lookup.",
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
            "defi/bridges",
            "defi/coin_prices",
            "price/historical",
            "search",
          ],
          description: "DataHub crypto endpoint path",
        }),
        symbol: Type.Optional(
          Type.String({ description: "Coin ID, trading pair, or protocol slug" }),
        ),
        ...dateRangeParams,
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const endpoint = String(params.endpoint ?? "coin/market");
          const qp = buildParams(params);
          // Endpoint-specific param mapping for crypto APIs
          if (qp.symbol) {
            const coinIdEndpoints = ["coin/historical", "coin/info"];
            if (coinIdEndpoints.includes(endpoint)) {
              qp.coin_id = qp.symbol;
              delete qp.symbol;
            } else if (endpoint === "defi/protocol_tvl") {
              qp.protocol = qp.symbol;
              delete qp.symbol;
            } else if (endpoint === "defi/coin_prices") {
              qp.coins = qp.symbol;
              delete qp.symbol;
            }
          }
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

  // ============================================================
  // Tool 6: fin_market — Market Radar (market-wide, not individual stock)
  // ============================================================
  api.registerTool(
    {
      name: "fin_market",
      label: "Market Radar",
      description:
        "A-share market-wide monitoring -- dragon-tiger list (top_list/top_inst), limit-up/down stats (limit_list), block trades, sector money flow (moneyflow/industry), margin (summary/detail/trading), Stock Connect northbound (hsgt_flow/hsgt_top10) and southbound (ggt_daily/ggt_monthly), market snapshots, discovery (gainers/losers/active/new_share), trade calendar. Notes: flow/hsgt_top10 requires 'date' param (NOT trade_date). flow/hs_const requires 'hs_type' param (SH or SZ). market/stock_limit requires 'symbol'. market_snapshots returns 12000+ records.",
      parameters: Type.Object({
        endpoint: Type.Unsafe<string>({
          type: "string",
          enum: [
            "market/top_list",
            "market/top_inst",
            "market/limit_list",
            "market/suspend",
            "market/trade_calendar",
            "market/stock_limit",
            "moneyflow/individual",
            "moneyflow/industry",
            "moneyflow/block_trade",
            "margin/summary",
            "margin/detail",
            "margin/trading",
            "flow/hsgt_flow",
            "flow/hsgt_top10",
            "flow/ggt_daily",
            "flow/ggt_monthly",
            "flow/hs_const",
            "market_snapshots",
            "discovery/gainers",
            "discovery/losers",
            "discovery/active",
            "discovery/new_share",
          ],
          description: "DataHub equity endpoint for market data",
        }),
        trade_date: Type.Optional(Type.String({ description: "Trade date, e.g. 2025-02-28" })),
        date: Type.Optional(
          Type.String({
            description:
              "Date param for hsgt_top10 (uses 'date' not 'trade_date'), e.g. 2025-02-28",
          }),
        ),
        symbol: Type.Optional(Type.String({ description: "Symbol for specific queries" })),
        hs_type: Type.Optional(
          Type.String({
            description: "Stock Connect type for hs_const: SH or SZ",
          }),
        ),
        ...dateRangeParams,
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const endpoint = String(params.endpoint ?? "market/top_list");
          const qp = buildParams(params);
          // Auto-alias: trade_date -> date for endpoints that use 'date' param
          const dateEndpoints = [
            "market/top_list",
            "market/top_inst",
            "market/limit_list",
            "flow/hsgt_top10",
          ];
          if (qp.trade_date && !qp.date && dateEndpoints.includes(endpoint)) {
            qp.date = qp.trade_date;
            delete qp.trade_date;
          }
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

  // ============================================================
  // Tool 7: fin_query — Raw DataHub Query (fallback)
  // ============================================================
  api.registerTool(
    {
      name: "fin_query",
      label: "Raw DataHub Query",
      description:
        "Direct passthrough to any of 172 DataHub endpoints by path. Use when other tools don't cover the specific data. Accepts arbitrary query params. Example paths: equity/fundamental/income, crypto/defi/protocols, economy/cpi.",
      parameters: Type.Object({
        path: Type.String({
          description:
            "Full endpoint path after /api/v1/, e.g. equity/fundamental/income, crypto/defi/protocols",
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

  // ============================================================
  // Tool 8: fin_data_ohlcv — OHLCV with caching
  // ============================================================
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

  // ============================================================
  // Tool 9: fin_data_regime — Market Regime Detection
  // ============================================================
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

  // ============================================================
  // Tool 10: fin_ta — Technical Analysis Indicators
  // ============================================================
  api.registerTool(
    {
      name: "fin_ta",
      label: "Technical Analysis",
      description:
        "Calculate technical indicators (SMA, EMA, RSI, MACD, Bollinger Bands) for any symbol. DataHub fetches OHLCV and computes server-side.",
      parameters: Type.Object({
        symbol: Type.String({
          description:
            "Stock/crypto symbol. A: 600519.SH; HK: 00700.HK; US: AAPL; Crypto: BTC-USDT",
        }),
        indicator: Type.Unsafe<string>({
          type: "string",
          enum: ["sma", "ema", "rsi", "macd", "bbands"],
          description: "Technical indicator to calculate",
        }),
        period: Type.Optional(
          Type.Number({
            description: "Indicator period (default: 20 for SMA/EMA/BBANDS, 14 for RSI)",
          }),
        ),
        limit: Type.Optional(
          Type.Number({ description: "Number of OHLCV bars to fetch (default: 200)" }),
        ),
        fast: Type.Optional(Type.Number({ description: "MACD fast period (default: 12)" })),
        slow: Type.Optional(Type.Number({ description: "MACD slow period (default: 26)" })),
        signal: Type.Optional(Type.Number({ description: "MACD signal period (default: 9)" })),
        std: Type.Optional(Type.Number({ description: "Bollinger Bands std dev (default: 2.0)" })),
        provider: Type.Optional(
          Type.String({ description: "Data provider override (auto-detected if omitted)" }),
        ),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const indicator = String(params.indicator ?? "sma");
          const qp: Record<string, string> = {};
          if (params.symbol) qp.symbol = String(params.symbol);
          if (params.period) qp.period = String(params.period);
          if (params.limit) qp.limit = String(params.limit);
          if (params.fast) qp.fast = String(params.fast);
          if (params.slow) qp.slow = String(params.slow);
          if (params.signal) qp.signal = String(params.signal);
          if (params.std) qp.std = String(params.std);
          if (params.provider) qp.provider = String(params.provider);
          const results = await client.ta(indicator, qp);
          return json({
            success: true,
            endpoint: `ta/${indicator}`,
            count: results.length,
            results,
          });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { names: ["fin_ta"] },
  );

  // ============================================================
  // Tool 11: fin_etf — ETF & Fund Data
  // ============================================================
  registerCategoryTool(api, client, {
    name: "fin_etf",
    label: "ETF & Fund",
    description:
      "ETF and fund data -- NAV history, fund info (type/size/fees), historical prices, portfolio holdings (top 10, quarterly), manager track record, dividends, share changes, adjusted NAV, search. Use fund/manager with a known fund code to find manager info.",
    category: "etf",
    defaultEndpoint: "info",
    clientMethod: (c, ep, qp) => c.etf(ep, qp),
    parameters: Type.Object({
      symbol: Type.Optional(
        Type.String({ description: "ETF/Fund code. ETF: 510050.SH; Fund: 110011" }),
      ),
      manager: Type.Optional(
        Type.String({ description: "Fund manager name for search (e.g. Zhang Kun)" }),
      ),
      endpoint: Type.Unsafe<string>({
        type: "string",
        enum: [
          "nav",
          "info",
          "historical",
          "fund/portfolio",
          "fund/manager",
          "fund/dividends",
          "fund/share",
          "fund/adj_nav",
          "search",
        ],
        description: "DataHub ETF/fund endpoint path",
      }),
      ...dateRangeParams,
    }),
  });

  // ============================================================
  // Tool 12: fin_data_markets — Supported Markets
  // ============================================================
  api.registerTool(
    {
      name: "fin_data_markets",
      label: "Supported Markets",
      description: "List all supported market types and data categories",
      parameters: Type.Object({}),
      async execute() {
        return json({
          datahub: datahubApiUrl,
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
}
