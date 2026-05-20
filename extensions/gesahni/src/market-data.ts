import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import type { GesahniConfig } from "./config.js";
import { normalizeSymbol, type ParsedOptionContract } from "./options.js";

export type MarketQuote = {
  symbol: string;
  bid?: number;
  ask?: number;
  mark?: number;
  timestamp?: string;
  source: string;
  delayed?: boolean;
};

export type MarketBar = {
  symbol: string;
  close: number;
  timestamp?: string;
};

export type MarketDataClient = {
  quote(symbol: string): Promise<MarketQuote>;
  optionQuote(contract: ParsedOptionContract): Promise<MarketQuote>;
  bars(symbol: string, options?: { timeframe?: string; limit?: number }): Promise<MarketBar[]>;
  status(): string;
};

type AlpacaQuotePayload = {
  quotes?: Record<string, unknown>;
  quote?: unknown;
};

type AlpacaBarsPayload = {
  bars?: Record<string, unknown>;
};

type BridgeQuotesPayload = {
  items?: unknown[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readQuoteFields(symbol: string, value: unknown, source: string): MarketQuote {
  const record = isRecord(value) ? value : {};
  const bid = asNumber(record.bp) ?? asNumber(record.bid_price) ?? asNumber(record.bidPrice);
  const ask = asNumber(record.ap) ?? asNumber(record.ask_price) ?? asNumber(record.askPrice);
  const mark =
    bid !== undefined && ask !== undefined && ask > 0
      ? (bid + ask) / 2
      : (asNumber(record.p) ?? asNumber(record.price));
  return {
    symbol,
    bid,
    ask,
    mark,
    timestamp: asString(record.t) ?? asString(record.timestamp),
    source,
  };
}

function readBars(symbol: string, value: unknown): MarketBar[] {
  const bars = Array.isArray(value) ? value : [];
  return bars.flatMap((entry) => {
    const record = isRecord(entry) ? entry : {};
    const close = asNumber(record.c) ?? asNumber(record.close);
    if (close === undefined) {
      return [];
    }
    return [
      {
        symbol,
        close,
        timestamp: asString(record.t) ?? asString(record.timestamp),
      },
    ];
  });
}

function resolveAlpacaCredential(
  configured: string | undefined,
  ...envNames: string[]
): string | undefined {
  if (configured) {
    return configured;
  }
  for (const name of envNames) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function createMarketDataClient(config: GesahniConfig): MarketDataClient {
  const alpaca = config.marketData?.alpaca ?? {};
  const keyId = resolveAlpacaCredential(alpaca.keyId, "APCA_API_KEY_ID", "ALPACA_API_KEY_ID");
  const secretKey = resolveAlpacaCredential(
    alpaca.secretKey,
    "APCA_API_SECRET_KEY",
    "ALPACA_API_SECRET_KEY",
  );
  const baseUrl = alpaca.baseUrl ?? "https://data.alpaca.markets";
  const headers =
    keyId && secretKey
      ? {
          "APCA-API-KEY-ID": keyId,
          "APCA-API-SECRET-KEY": secretKey,
        }
      : undefined;

  const bridge = config.bridge ?? {};
  const bridgeBaseUrl = bridge.baseUrl;
  const bridgeReadToken = bridge.readBridgeToken;
  const bridgeUserId = bridge.userId && bridge.userId.startsWith("tg:") ? bridge.userId : undefined;
  const bridgeTimeoutMs = bridge.defaultTimeoutMs ?? 2500;

  async function fetchJson(url: URL): Promise<unknown> {
    if (!headers) {
      throw new Error(
        "Alpaca market data is not configured. Set APCA_API_KEY_ID and APCA_API_SECRET_KEY or plugins.entries.gesahni.config.marketData.alpaca.",
      );
    }
    const { response, release } = await fetchWithSsrFGuard({
      url: url.toString(),
      init: { headers },
      policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
      auditContext: "gesahni.market-data.alpaca",
    });
    try {
      if (!response.ok) {
        throw new Error(`Alpaca market data request failed (${response.status})`);
      }
      return await response.json();
    } finally {
      await release();
    }
  }

  async function fetchBridgeJson(url: URL): Promise<unknown> {
    if (!bridgeBaseUrl || !bridgeReadToken) {
      throw new Error(
        "Gesahni bridge is not configured. Set GESAHNI_BASE_URL and GESAHNI_READ_BRIDGE_TOKEN or plugins.entries.gesahni.config.bridge.",
      );
    }
    if (!bridgeUserId) {
      throw new Error(
        "Gesahni bridge requires a tg: user id today. Set plugins.entries.gesahni.config.bridge.userId or GESAHNI_BRIDGE_USER_ID for Discord testing.",
      );
    }
    const { response, release } = await fetchWithSsrFGuard({
      url: url.toString(),
      init: {
        headers: {
          Authorization: `Bearer ${bridgeReadToken}`,
          "X-User-Id": bridgeUserId,
        },
      },
      policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(bridgeBaseUrl),
      timeoutMs: bridgeTimeoutMs,
      auditContext: "gesahni.market-data.bridge",
    });
    try {
      if (!response.ok) {
        throw new Error(`Gesahni bridge request failed (${response.status})`);
      }
      return await response.json();
    } finally {
      await release();
    }
  }

  function createBridgeQuote(symbol: string, item: unknown): MarketQuote {
    const record = isRecord(item) ? item : {};
    const status = asString(record.status);
    const errorMessage = asString(record.error_message) ?? asString(record.error);
    if (status && status !== "ok") {
      throw new Error(errorMessage ?? `Gesahni bridge returned ${status}`);
    }
    const price = asNumber(record.price) ?? asNumber(record.mark);
    return {
      symbol,
      mark: price,
      timestamp: asString(record.as_of) ?? asString(record.timestamp),
      source: asString(record.source) ?? "Gesahni bridge",
    };
  }

  const bridgeClient: MarketDataClient | undefined =
    bridgeBaseUrl && bridgeReadToken
      ? {
          async quote(symbol) {
            const normalized = normalizeSymbol(symbol);
            const url = new URL("/v1/bridge/options/quotes_batch", bridgeBaseUrl);
            url.searchParams.set("symbols", normalized);
            const payload = (await fetchBridgeJson(url)) as BridgeQuotesPayload;
            const item = payload.items?.find((candidate) => {
              const record = isRecord(candidate) ? candidate : {};
              return asString(record.symbol)?.toUpperCase() === normalized;
            });
            if (!item) {
              throw new Error("Gesahni bridge returned no quote");
            }
            return createBridgeQuote(normalized, item);
          },
          async optionQuote() {
            throw new Error("Gesahni bridge does not expose OCC option quotes yet");
          },
          async bars() {
            throw new Error("Gesahni bridge does not expose chart bars yet");
          },
          status() {
            return bridgeUserId
              ? "Gesahni bridge configured"
              : "Gesahni bridge configured; tg user mapping missing";
          },
        }
      : undefined;

  if (!headers && bridgeClient) {
    return bridgeClient;
  }

  return {
    async quote(symbol) {
      const normalized = normalizeSymbol(symbol);
      const url = new URL("/v2/stocks/quotes/latest", baseUrl);
      url.searchParams.set("symbols", normalized);
      if (alpaca.stockFeed) {
        url.searchParams.set("feed", alpaca.stockFeed);
      }
      const payload = (await fetchJson(url)) as AlpacaQuotePayload;
      const quote = payload.quotes?.[normalized] ?? payload.quote;
      return readQuoteFields(normalized, quote, "Alpaca");
    },
    async optionQuote(contract) {
      const url = new URL("/v1beta1/options/quotes/latest", baseUrl);
      url.searchParams.set("symbols", contract.occSymbol);
      if (alpaca.optionFeed) {
        url.searchParams.set("feed", alpaca.optionFeed);
      }
      const payload = (await fetchJson(url)) as AlpacaQuotePayload;
      const quote = payload.quotes?.[contract.occSymbol] ?? payload.quote;
      return readQuoteFields(contract.occSymbol, quote, "Alpaca");
    },
    async bars(symbol, options) {
      const normalized = normalizeSymbol(symbol);
      const url = new URL("/v2/stocks/bars", baseUrl);
      url.searchParams.set("symbols", normalized);
      url.searchParams.set("timeframe", options?.timeframe ?? "5Min");
      url.searchParams.set("limit", String(options?.limit ?? 20));
      if (alpaca.stockFeed) {
        url.searchParams.set("feed", alpaca.stockFeed);
      }
      const payload = (await fetchJson(url)) as AlpacaBarsPayload;
      return readBars(normalized, payload.bars?.[normalized]);
    },
    status() {
      return headers ? "Alpaca configured" : "Alpaca not configured";
    },
  };
}
