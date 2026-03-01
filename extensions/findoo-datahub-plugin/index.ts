import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import { createCryptoAdapter } from "./src/adapters/crypto-adapter.js";
import type { CcxtExchange } from "./src/adapters/crypto-adapter.js";
import { createYahooAdapter } from "./src/adapters/yahoo-adapter.js";
import type { YahooFinanceClient } from "./src/adapters/yahoo-adapter.js";
import { DataHubClient } from "./src/datahub-client.js";
import { OHLCVCache } from "./src/ohlcv-cache.js";
import { RegimeDetector } from "./src/regime-detector.js";
import {
  DERIV_MAP,
  INDEX_MAP,
  MACRO_MAP,
  MARKET_MAP,
  buildTushareParams,
  detectMarket,
  resolveStockApi,
} from "./src/tushare-maps.js";
import type { MarketType } from "./src/types.js";
import { UnifiedDataProvider } from "./src/unified-provider.js";

/* ---------- helpers ---------- */

const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

const DEFAULT_TUSHARE_PROXY_URL = "http://43.134.187.48:7088";
const DEFAULT_DATAHUB_URL = "http://43.134.61.136:8088";
const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
const DEFILLAMA_BASE = "https://api.llama.fi";

type PluginConfig = {
  mode: "auto" | "free" | "full";
  datahubApiUrl: string;
  datahubApiKey?: string;
  tushareProxyUrl: string;
  tushareApiKey?: string;
  coingeckoApiKey?: string;
  coinglassApiKey?: string;
  requestTimeoutMs: number;
};

type ExchangeRegistry = {
  getInstance: (id: string) => Promise<unknown>;
  listExchanges: () => Array<{ id: string; exchange: string; testnet: boolean }>;
};

function readEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function resolveConfig(api: OpenClawPluginApi): PluginConfig {
  const raw = api.pluginConfig as Record<string, unknown> | undefined;

  const datahubApiKey =
    (typeof raw?.datahubApiKey === "string" ? raw.datahubApiKey : undefined) ??
    readEnv(["DATAHUB_API_KEY", "OPENFINCLAW_DATAHUB_API_KEY"]);

  const datahubApiUrl =
    (typeof raw?.datahubApiUrl === "string" ? raw.datahubApiUrl : undefined) ??
    readEnv(["DATAHUB_API_URL", "OPENFINCLAW_DATAHUB_API_URL"]) ??
    DEFAULT_DATAHUB_URL;

  const tushareApiKey =
    (typeof raw?.tushareApiKey === "string" ? raw.tushareApiKey : undefined) ??
    readEnv(["TUSHARE_PROXY_API_KEY", "FIN_DATA_HUB_API_KEY"]);

  const tushareProxyUrl =
    (typeof raw?.tushareProxyUrl === "string" ? raw.tushareProxyUrl : undefined) ??
    readEnv(["TUSHARE_PROXY_URL", "FIN_DATA_HUB_ENDPOINT"]) ??
    DEFAULT_TUSHARE_PROXY_URL;

  const coingeckoApiKey =
    (typeof raw?.coingeckoApiKey === "string" ? raw.coingeckoApiKey : undefined) ??
    readEnv(["COINGECKO_API_KEY"]);

  const coinglassApiKey =
    (typeof raw?.coinglassApiKey === "string" ? raw.coinglassApiKey : undefined) ??
    readEnv(["COINGLASS_API_KEY"]);

  const modeRaw =
    (typeof raw?.mode === "string" ? raw.mode : undefined) ?? readEnv(["OPENFINCLAW_DATAHUB_MODE"]);
  const mode = modeRaw === "free" ? "free" : modeRaw === "full" ? "full" : "auto";

  const timeoutRaw = raw?.requestTimeoutMs ?? readEnv(["OPENFINCLAW_DATAHUB_TIMEOUT_MS"]);
  const timeout = Number(timeoutRaw);

  return {
    mode,
    datahubApiUrl: datahubApiUrl.replace(/\/+$/, ""),
    datahubApiKey,
    tushareProxyUrl: tushareProxyUrl.replace(/\/+$/, ""),
    tushareApiKey,
    coingeckoApiKey,
    coinglassApiKey,
    requestTimeoutMs: Number.isFinite(timeout) && timeout >= 1000 ? Math.floor(timeout) : 30_000,
  };
}

/* ---------- Tushare proxy call (legacy fallback) ---------- */

async function tusharePost(
  config: PluginConfig,
  apiName: string,
  params: Record<string, unknown>,
  fields?: string,
): Promise<{ success: boolean; data: unknown[] }> {
  if (!config.tushareApiKey) {
    return {
      success: true,
      data: [
        {
          _stub: true,
          api_name: apiName,
          params,
          message:
            "No Tushare API key. Set TUSHARE_PROXY_API_KEY or DATAHUB_API_KEY for real data.",
        },
      ],
    };
  }

  const url = `${config.tushareProxyUrl}/api/tushare`;
  const body: Record<string, unknown> = { api_name: apiName, params };
  if (fields) body.fields = fields;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  headers["X-Api-Key"] = config.tushareApiKey;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });

  const text = await response.text();
  let payload: { success?: boolean; data?: unknown[]; error?: string };
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Tushare proxy returned non-JSON (${response.status}): ${text.slice(0, 200)}`);
  }

  if (!response.ok) {
    throw new Error(
      `Tushare proxy error (${response.status}): ${payload.error ?? text.slice(0, 200)}`,
    );
  }
  if (!payload.success) {
    throw new Error(`Tushare query failed: ${payload.error ?? "unknown error"}`);
  }

  return { success: true, data: payload.data ?? [] };
}

/* ---------- CoinGecko + DefiLlama helpers ---------- */

async function coingeckoGet(
  config: PluginConfig,
  path: string,
  params?: Record<string, string>,
): Promise<unknown> {
  const url = new URL(`${COINGECKO_BASE}${path}`);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const headers: Record<string, string> = {};
  if (config.coingeckoApiKey) headers["x-cg-demo-api-key"] = config.coingeckoApiKey;

  const resp = await fetch(url.toString(), {
    headers,
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`CoinGecko error (${resp.status}): ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function defillamaGet(config: PluginConfig, path: string): Promise<unknown> {
  const resp = await fetch(`${DEFILLAMA_BASE}${path}`, {
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`DefiLlama error (${resp.status}): ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/** Route crypto query_type to the right API */
async function executeCryptoQuery(
  config: PluginConfig,
  queryType: string,
  params: Record<string, unknown>,
): Promise<{ source: string; data: unknown }> {
  const symbol = String(params.symbol ?? "").trim();
  const limit = params.limit ? String(params.limit) : undefined;

  switch (queryType) {
    case "coin_global":
      return { source: "coingecko", data: await coingeckoGet(config, "/global") };

    case "coin_market":
      return {
        source: "coingecko",
        data: await coingeckoGet(config, "/coins/markets", {
          vs_currency: "usd",
          order: "market_cap_desc",
          per_page: limit ?? "50",
          sparkline: "false",
        }),
      };

    case "coin_trending":
      return { source: "coingecko", data: await coingeckoGet(config, "/search/trending") };

    case "coin_categories":
      return { source: "coingecko", data: await coingeckoGet(config, "/coins/categories") };

    case "coin_info": {
      const coinId = symbol.toLowerCase() || "bitcoin";
      return {
        source: "coingecko",
        data: await coingeckoGet(config, `/coins/${coinId}`, {
          localization: "false",
          tickers: "false",
          community_data: "false",
          developer_data: "false",
        }),
      };
    }

    case "coin_historical": {
      const coinId = symbol.toLowerCase() || "bitcoin";
      const days = limit ?? "30";
      return {
        source: "coingecko",
        data: await coingeckoGet(config, `/coins/${coinId}/market_chart`, {
          vs_currency: "usd",
          days,
        }),
      };
    }

    case "search": {
      const query = symbol || "bitcoin";
      return { source: "coingecko", data: await coingeckoGet(config, "/search", { query }) };
    }

    case "defi_protocols":
      return { source: "defillama", data: await defillamaGet(config, "/protocols") };

    case "defi_tvl":
      if (symbol) {
        return { source: "defillama", data: await defillamaGet(config, `/tvl/${symbol}`) };
      }
      return { source: "defillama", data: await defillamaGet(config, "/protocols") };

    case "defi_chains":
      return { source: "defillama", data: await defillamaGet(config, "/v2/chains") };

    case "defi_yields":
      return { source: "defillama", data: await defillamaGet(config, "/pools") };

    case "defi_stablecoins":
      return { source: "defillama", data: await defillamaGet(config, "/stablecoins") };

    case "defi_fees":
      return { source: "defillama", data: await defillamaGet(config, "/overview/fees") };

    case "defi_dex_volumes":
      return { source: "defillama", data: await defillamaGet(config, "/overview/dexs") };

    case "defi_coin_prices": {
      const coins = symbol || "coingecko:bitcoin,coingecko:ethereum";
      return {
        source: "defillama",
        data: await defillamaGet(config, `/prices/current/${coins}`),
      };
    }

    default:
      throw new Error(`Unknown crypto query_type: ${queryType}`);
  }
}

/* ---------- plugin ---------- */

const findooDatahubPlugin = {
  id: "findoo-datahub-plugin",
  name: "Findoo DataHub",
  description:
    "Unified financial data source — free mode (CCXT/CoinGecko/DefiLlama/Yahoo) + full mode (172 DataHub endpoints). " +
    "Set DATAHUB_API_KEY for full access.",
  kind: "financial" as const,

  async register(api: OpenClawPluginApi) {
    const config = resolveConfig(api);

    // --- Build DataHub client (full mode) ---
    let datahubClient: DataHubClient | null = null;
    if (config.mode !== "free" && config.datahubApiKey) {
      datahubClient = new DataHubClient(
        config.datahubApiUrl,
        config.datahubApiKey,
        config.requestTimeoutMs,
      );
    }

    // --- Build free-tier adapters ---
    const dbPath = api.resolvePath("state/findoo-ohlcv-cache.sqlite");
    const cache = new OHLCVCache(dbPath);
    const regimeDetector = new RegimeDetector();

    // Crypto adapter (CCXT via fin-core exchange registry)
    const runtime = api.runtime as unknown as { services?: Map<string, unknown> };
    const getExchangeInstance = async (id?: string): Promise<CcxtExchange> => {
      const registry = runtime.services?.get?.("fin-exchange-registry") as
        | ExchangeRegistry
        | undefined;
      if (!registry) {
        throw new Error("fin-core plugin not loaded — exchange registry unavailable");
      }
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

    // Yahoo Finance adapter (free equity fallback)
    let yahooAdapter = undefined;
    if (config.mode !== "full") {
      try {
        const yf = await import("yahoo-finance2");
        const yahooClient = (yf.default ?? yf) as unknown as YahooFinanceClient;
        yahooAdapter = createYahooAdapter(cache, yahooClient);
      } catch {
        // yahoo-finance2 not installed; equity stays disabled in free mode
      }
    }

    // --- Build unified provider ---
    const provider = new UnifiedDataProvider(
      datahubClient,
      cryptoAdapter,
      regimeDetector,
      cache,
      yahooAdapter,
    );

    // --- Register services ---
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

    // ============================================================
    // AI Tools (10 total)
    // ============================================================

    // === Tool 1: fin_stock — A-share / HK / US equity data ===
    api.registerTool(
      {
        name: "fin_stock",
        label: "Stock Data (A/HK/US)",
        description:
          "Fetch A-share, HK stock, or US equity data — quotes, historical prices, income statements, balance sheets, cashflow, financial ratios, money flow, holders, dividends, news, pledge, margin, block trades.",
        parameters: Type.Object({
          symbol: Type.String({
            description: "Stock code. A-shares: 600519.SH; HK: 00700.HK; US: AAPL",
          }),
          query_type: Type.Unsafe<string>({
            type: "string",
            enum: [
              "quote",
              "historical",
              "income",
              "balance",
              "cashflow",
              "ratios",
              "moneyflow",
              "holders",
              "dividends",
              "news",
              "pledge",
              "margin",
              "block_trade",
              "factor",
            ],
            description: "Type of data to query",
          }),
          start_date: Type.Optional(Type.String({ description: "Start date, e.g. 2025-01-01" })),
          end_date: Type.Optional(Type.String({ description: "End date, e.g. 2025-12-31" })),
          limit: Type.Optional(Type.Number({ description: "Max records to return" })),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const symbol = String(params.symbol ?? "").trim();
            const queryType = String(params.query_type ?? "").trim();
            if (!symbol || !queryType) throw new Error("symbol and query_type are required");
            const market = detectMarket(symbol);
            const apiName = resolveStockApi(queryType, market);
            const tsParams = buildTushareParams(params);
            const result = await tusharePost(config, apiName, tsParams);
            return json({ success: true, market, api_name: apiName, result });
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
          "Query index constituents, index valuations, ETF historical prices/NAV, fund manager/portfolio, fund share, THS concept sector classification.",
        parameters: Type.Object({
          symbol: Type.String({
            description: "Index/ETF/fund code. Index: 000300.SH; ETF: 510050.SH",
          }),
          query_type: Type.Unsafe<string>({
            type: "string",
            enum: [
              "index_historical",
              "index_constituents",
              "index_valuation",
              "etf_historical",
              "etf_nav",
              "fund_manager",
              "fund_portfolio",
              "fund_share",
              "ths_index",
              "ths_daily",
              "ths_member",
              "sector_classify",
            ],
            description: "Type of data to query",
          }),
          start_date: Type.Optional(Type.String()),
          end_date: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Number()),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const queryType = String(params.query_type ?? "").trim();
            if (!queryType) throw new Error("query_type is required");
            const apiName = INDEX_MAP[queryType] ?? queryType;
            const tsParams = buildTushareParams(params);
            const result = await tusharePost(config, apiName, tsParams);
            return json({ success: true, api_name: apiName, result });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_index"] },
    );

    // === Tool 3: fin_macro — Macro / Rates / FX ===
    api.registerTool(
      {
        name: "fin_macro",
        label: "Macro / Rates / FX",
        description:
          "China macro (GDP/CPI/PPI/PMI/M2/money supply/social financing), interest rates (Shibor/LPR/Libor/Hibor), treasury yields (CN + US), FX daily, Wenzhou index, economic calendar. World Bank data via wb_* indicators.",
        parameters: Type.Object({
          indicator: Type.String({
            description:
              "Indicator: gdp, cpi, ppi, pmi, m2, shibor, lpr, libor, hibor, treasury_cn, treasury_us, fx, wz_index",
          }),
          country: Type.Optional(Type.String({ description: "Country code for World Bank" })),
          symbol: Type.Optional(Type.String({ description: "Currency pair for FX, e.g. USDCNH" })),
          start_date: Type.Optional(Type.String()),
          end_date: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Number()),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const indicator = String(params.indicator ?? "").trim();
            if (!indicator) throw new Error("indicator is required");
            const apiName = MACRO_MAP[indicator] ?? indicator;
            const tsParams = buildTushareParams(params);
            const result = await tusharePost(config, apiName, tsParams);
            return json({ success: true, api_name: apiName, result });
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
          "Futures (daily, holdings, settlement, warehouse, mapping), options (basic, daily, chains), convertible bonds (CB).",
        parameters: Type.Object({
          symbol: Type.String({ description: "Contract code, e.g. IF2501.CFX, 113xxx.SH (CB)" }),
          query_type: Type.Unsafe<string>({
            type: "string",
            enum: [
              "futures_historical",
              "futures_info",
              "futures_holding",
              "futures_settle",
              "futures_warehouse",
              "futures_mapping",
              "option_basic",
              "option_daily",
              "option_chains",
              "cb_basic",
              "cb_daily",
            ],
            description: "Type of derivatives data",
          }),
          trade_date: Type.Optional(Type.String({ description: "Trade date, e.g. 20250228" })),
          start_date: Type.Optional(Type.String()),
          end_date: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Number()),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const queryType = String(params.query_type ?? "").trim();
            if (!queryType) throw new Error("query_type is required");
            const apiName = DERIV_MAP[queryType] ?? queryType;
            const tsParams = buildTushareParams(params);
            const result = await tusharePost(config, apiName, tsParams);
            return json({ success: true, api_name: apiName, result });
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
          "Crypto market data via CoinGecko: market cap rankings, trending coins, global stats, coin info/categories, historical prices. " +
          "DeFi via DefiLlama: TVL protocols, yields, chains, stablecoins, fees, DEX volumes, coin prices. " +
          "CEX K-lines/OHLCV use fin_data_ohlcv tool instead.",
        parameters: Type.Object({
          query_type: Type.Unsafe<string>({
            type: "string",
            enum: [
              "search",
              "coin_market",
              "coin_historical",
              "coin_info",
              "coin_categories",
              "coin_trending",
              "coin_global",
              "defi_protocols",
              "defi_tvl",
              "defi_chains",
              "defi_yields",
              "defi_stablecoins",
              "defi_fees",
              "defi_dex_volumes",
              "defi_coin_prices",
            ],
            description: "Type of crypto/DeFi data",
          }),
          symbol: Type.Optional(Type.String({ description: "Coin ID or slug" })),
          limit: Type.Optional(Type.Number()),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const queryType = String(params.query_type ?? "").trim();
            if (!queryType) throw new Error("query_type is required");
            const result = await executeCryptoQuery(config, queryType, params);
            return json({
              success: true,
              query_type: queryType,
              source: result.source,
              result: result.data,
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
          "Market monitoring — dragon-tiger list (top movers), limit-up/down stats, block trades, sector/industry money flow, margin trading, Stock Connect (HSGT) north/south flow, global index snapshot, IPO calendar, suspend, trade calendar.",
        parameters: Type.Object({
          query_type: Type.Unsafe<string>({
            type: "string",
            enum: [
              "top_list",
              "top_inst",
              "limit_list",
              "block_trade",
              "moneyflow_industry",
              "concept_list",
              "concept_detail",
              "margin",
              "margin_detail",
              "hsgt_flow",
              "hsgt_top10",
              "index_global",
              "market_snapshot",
              "calendar_ipo",
              "suspend",
              "trade_calendar",
            ],
            description: "Type of market data",
          }),
          trade_date: Type.Optional(Type.String({ description: "Trade date, e.g. 20250228" })),
          symbol: Type.Optional(Type.String({ description: "Symbol for specific queries" })),
          start_date: Type.Optional(Type.String()),
          end_date: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Number()),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const queryType = String(params.query_type ?? "").trim();
            if (!queryType) throw new Error("query_type is required");
            const apiName = MARKET_MAP[queryType] ?? queryType;
            const tsParams = buildTushareParams(params);
            const result = await tusharePost(config, apiName, tsParams);
            return json({ success: true, api_name: apiName, result });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_market"] },
    );

    // === Tool 7: fin_query — Raw Tushare Query (fallback) ===
    api.registerTool(
      {
        name: "fin_query",
        label: "Raw Tushare Query",
        description:
          "Raw Tushare API fallback — direct passthrough to any of 162+ Tushare endpoints by api_name. Use when other tools don't cover the specific data.",
        parameters: Type.Object({
          api_name: Type.String({
            description: "Tushare API name, e.g. daily, hk_daily, cn_gdp, fut_daily",
          }),
          params: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: "Query parameters as key-value pairs, e.g. {ts_code: '600519.SH'}",
            }),
          ),
          fields: Type.Optional(
            Type.String({ description: "Comma-separated field list to return" }),
          ),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          try {
            const apiName = String(params.api_name ?? "").trim();
            if (!apiName) throw new Error("api_name is required");
            const tsParams = (params.params ?? {}) as Record<string, unknown>;
            const fields = params.fields ? String(params.fields) : undefined;
            const result = await tusharePost(config, apiName, tsParams, fields);
            return json({ success: true, api_name: apiName, result });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_query"] },
    );

    // === Tool 8: fin_data_ohlcv — OHLCV via unified provider ===
    api.registerTool(
      {
        name: "fin_data_ohlcv",
        label: "OHLCV Data",
        description:
          "Fetch OHLCV candle data with local caching. Routes automatically: DataHub (full mode) or CCXT/Yahoo (free mode).",
        parameters: Type.Object({
          symbol: Type.String({
            description: "Trading pair symbol (e.g. BTC/USDT, AAPL, 600519.SH)",
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

    // === Tool 9: fin_data_regime — Market Regime Detection ===
    api.registerTool(
      {
        name: "fin_data_regime",
        label: "Market Regime",
        description:
          "Detect the current market regime (bull/bear/sideways/volatile/crisis) for a symbol using SMA/ATR analysis.",
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

    // === Tool 10: fin_data_markets — Supported Markets ===
    api.registerTool(
      {
        name: "fin_data_markets",
        label: "Supported Markets",
        description: "List supported market types and their availability",
        parameters: Type.Object({}),
        async execute() {
          const markets = provider.getSupportedMarkets();
          const mode = datahubClient ? "full" : "free";
          return json({ mode, markets });
        },
      },
      { names: ["fin_data_markets"] },
    );
  },
};

export default findooDatahubPlugin;
