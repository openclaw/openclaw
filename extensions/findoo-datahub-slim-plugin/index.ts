import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveConfig } from "./src/config.js";
import { DataHubClient } from "./src/datahub-client.js";
import type { MarketType } from "./src/types.js";

/* ---------- helpers ---------- */

const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

function pick(params: Record<string, unknown>, ...keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    if (params[k] != null) out[k] = String(params[k]);
  }
  return out;
}

/* ---------- plugin ---------- */

const findooDatahubSlimPlugin = {
  id: "findoo-datahub-slim-plugin",
  name: "Findoo DataHub Slim",
  description:
    "Lightweight price query — current prices, K-line data, crypto tickers. " +
    "5 tools, zero external dependencies.",
  kind: "financial" as const,

  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api);

    if (!config.apiKey) {
      api.log?.(
        "error",
        "findoo-datahub-slim: API key is required. Set DATAHUB_API_KEY env var or configure in Control UI → Plugins.",
      );
    }

    const client = config.apiKey
      ? new DataHubClient(config.gatewayUrl, config.apiKey, config.requestTimeoutMs)
      : null;

    const NO_KEY =
      "DataHub API key not configured. Set DATAHUB_API_KEY or configure in Control UI → Plugins.";

    // ================================================================
    // Tool 1: fin_price — 万能查价（核心）
    // ================================================================
    api.registerTool(
      {
        name: "fin_price",
        label: "Price Lookup",
        description:
          "Get the current / latest price for any asset — stocks (A/HK/US), crypto, index. " +
          "Returns latest close, volume, and date. The simplest way to answer 'XX 现在什么价格'.",
        parameters: Type.Object({
          symbol: Type.String({
            description:
              "Asset symbol. Crypto: BTC/USDT, ETH/USDT; A-share: 600519.SH; HK: 00700.HK; US: AAPL; Index: 000300.SH",
          }),
          market: Type.Optional(
            Type.Unsafe<"crypto" | "equity">({
              type: "string",
              enum: ["crypto", "equity"],
              description:
                "Market type. Auto-detected if omitted: symbols with .SH/.SZ/.HK or pure letters → equity; contains '/' → crypto.",
            }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            if (!client) return json({ error: NO_KEY });
            const symbol = String(params.symbol);
            const market = (params.market as MarketType) ?? guessMarket(symbol);
            const ticker = await client.getTicker(symbol, market);
            return json({
              symbol: ticker.symbol,
              market: ticker.market,
              price: ticker.last,
              volume24h: ticker.volume24h,
              timestamp: new Date(ticker.timestamp).toISOString(),
            });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_price"] },
    );

    // ================================================================
    // Tool 2: fin_kline — K 线 / OHLCV
    // ================================================================
    api.registerTool(
      {
        name: "fin_kline",
        label: "K-Line / OHLCV",
        description:
          "Fetch historical OHLCV (candlestick) data for any asset. " +
          "Use for price history, charting, and trend analysis.",
        parameters: Type.Object({
          symbol: Type.String({
            description: "Asset symbol (BTC/USDT, 600519.SH, AAPL, etc.)",
          }),
          market: Type.Optional(
            Type.Unsafe<"crypto" | "equity">({
              type: "string",
              enum: ["crypto", "equity"],
              description: "Market type (auto-detected if omitted)",
            }),
          ),
          limit: Type.Optional(
            Type.Number({ description: "Number of bars to return (default: 30)" }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            if (!client) return json({ error: NO_KEY });
            const symbol = String(params.symbol);
            const market = (params.market as MarketType) ?? guessMarket(symbol);
            const limit = (params.limit as number) ?? 30;
            const ohlcv = await client.getOHLCV({ symbol, market, limit });
            return json({
              symbol,
              market,
              count: ohlcv.length,
              bars: ohlcv.map((b) => ({
                date: new Date(b.timestamp).toISOString().slice(0, 10),
                open: b.open,
                high: b.high,
                low: b.low,
                close: b.close,
                volume: b.volume,
              })),
            });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_kline"] },
    );

    // ================================================================
    // Tool 3: fin_crypto — 加密市场全量（兼容 Full 版 skill）
    // ================================================================
    api.registerTool(
      {
        name: "fin_crypto",
        label: "Crypto & DeFi",
        description:
          "Crypto market data (ticker/orderbook/trades/funding_rate) via CEX, " +
          "DeFi (protocols/TVL/yields/stablecoins/fees/dex_volumes) via DefiLlama, " +
          "market metrics (coin/market/info/categories/trending/global_stats) via CoinGecko. " +
          "price/historical for crypto OHLCV, search for symbol lookup.",
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
          start_date: Type.Optional(Type.String({ description: "Start date (YYYY-MM-DD)" })),
          end_date: Type.Optional(Type.String({ description: "End date (YYYY-MM-DD)" })),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 20)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            if (!client) return json({ error: NO_KEY });
            const endpoint = String(params.endpoint ?? "coin/market");
            const qp = pick(params, "symbol", "start_date", "end_date", "limit");
            if (!qp.limit) qp.limit = "20";
            // Endpoint-specific param mapping
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

    // ================================================================
    // Tool 4: fin_compare — 多资产价格对比
    // ================================================================
    api.registerTool(
      {
        name: "fin_compare",
        label: "Price Compare",
        description:
          "Compare prices of 2-5 assets side by side. Returns latest price and recent change for each. " +
          "Use for cross-asset comparison questions like 'BTC vs ETH vs 黄金'.",
        parameters: Type.Object({
          symbols: Type.String({
            description: "Comma-separated symbols (2-5). Example: BTC/USDT,ETH/USDT,600519.SH",
          }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            if (!client) return json({ error: NO_KEY });
            const raw = String(params.symbols);
            const symbols = raw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
              .slice(0, 5);
            if (symbols.length < 2)
              return json({ error: "Need at least 2 symbols, comma-separated" });

            const results = await Promise.allSettled(
              symbols.map(async (sym) => {
                const market = guessMarket(sym);
                const ticker = await client!.getTicker(sym, market);
                // Also get 7-day history for change calculation
                const bars = await client!.getOHLCV({ symbol: sym, market, limit: 7 });
                const weekAgo = bars.length > 0 ? bars[0]!.close : ticker.last;
                const weekChange = weekAgo > 0 ? ((ticker.last - weekAgo) / weekAgo) * 100 : 0;
                return {
                  symbol: sym,
                  market,
                  price: ticker.last,
                  weekChange: Math.round(weekChange * 100) / 100,
                };
              }),
            );

            return json({
              comparison: results.map((r, i) =>
                r.status === "fulfilled"
                  ? r.value
                  : { symbol: symbols[i], error: (r.reason as Error).message },
              ),
            });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_compare"] },
    );

    // ================================================================
    // Tool 5: fin_slim_search — 代码/名称搜索
    // ================================================================
    api.registerTool(
      {
        name: "fin_slim_search",
        label: "Symbol Search",
        description:
          "Search for stock/crypto symbols by name or keyword. " +
          "Use when user mentions a company/coin name but not the exact symbol.",
        parameters: Type.Object({
          query: Type.String({ description: "Search keyword (e.g. '茅台', 'bitcoin', 'Tesla')" }),
          market: Type.Optional(
            Type.Unsafe<"crypto" | "equity">({
              type: "string",
              enum: ["crypto", "equity"],
              description: "Limit search to market type",
            }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            if (!client) return json({ error: NO_KEY });
            const q = String(params.query);
            const market = params.market as string | undefined;

            const results: unknown[] = [];

            if (!market || market === "crypto") {
              try {
                const crypto = await client!.crypto("search", { query: q, limit: "5" });
                results.push(...crypto.map((r) => ({ ...(r as object), market: "crypto" })));
              } catch {
                /* ignore */
              }
            }

            if (!market || market === "equity") {
              try {
                const equity = await client!.equity("search", { query: q, limit: "5" });
                results.push(...equity.map((r) => ({ ...(r as object), market: "equity" })));
              } catch {
                /* ignore */
              }
            }

            return json({ query: q, count: results.length, results });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { names: ["fin_slim_search"] },
    );
  },
};

/* ---------- market detection ---------- */

function guessMarket(symbol: string): MarketType {
  if (symbol.includes("/")) return "crypto";
  const u = symbol.toUpperCase();
  if (u.endsWith(".SH") || u.endsWith(".SZ") || u.endsWith(".BJ") || u.endsWith(".HK"))
    return "equity";
  if (/^\d{5,6}/.test(u)) return "equity";
  if (/^[A-Z]{1,5}$/.test(u)) return "equity"; // AAPL, TSLA
  return "crypto"; // fallback
}

export default findooDatahubSlimPlugin;
