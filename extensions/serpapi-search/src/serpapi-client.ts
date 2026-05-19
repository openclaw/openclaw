import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withTrustedWebSearchEndpoint } from "openclaw/plugin-sdk/provider-web-search";
import {
  DEFAULT_SERPAPI_TIMEOUT_SECONDS,
  SERPAPI_BASE_URL,
  resolveSerpApiKey,
  resolveSerpApiLanguage,
} from "./config.js";

// In-process result cache — aligns with SerpApi's 1-hour server-side cache window.
// ZeroTrace requests bypass the cache (caching would defeat the privacy guarantee).
type CacheEntry = { data: Record<string, unknown>; expiresAt: number };
const RESULT_CACHE = new Map<string, CacheEntry>();
// Slightly under SerpApi's 1-hour server-side window so we refresh before it expires.
const CACHE_TTL_MS = 55 * 60_000;

function buildCacheKey(params: Record<string, string>): string {
  const excluded = new Set(["api_key", "zero_trace"]);
  const entries = Object.entries(params)
    .filter(([k]) => !excluded.has(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => [k, v.trim()]);
  return JSON.stringify(entries);
}

function sweepExpiredCache(): void {
  const now = Date.now();
  for (const [k, v] of RESULT_CACHE) {
    if (v.expiresAt <= now) RESULT_CACHE.delete(k);
  }
}

export type SerpApiCallParams = {
  cfg?: OpenClawConfig;
  engine: string;
  /** Security allowlist — only these keys (plus engine/hl) will be forwarded to SerpApi. */
  allowedParams: readonly string[];
  params: Record<string, string | number | boolean | undefined>;
  timeoutSeconds?: number;
  signal?: AbortSignal;
};

export async function callSerpApi(opts: SerpApiCallParams): Promise<Record<string, unknown>> {
  const apiKey = resolveSerpApiKey(opts.cfg);
  if (!apiKey) {
    throw new Error(
      "serpapi-search needs a SerpApi API key. Set SERPAPI_API_KEY in the Gateway environment, " +
        "or configure plugins.entries.serpapi-search.config.apiKey.",
    );
  }

  const hl = resolveSerpApiLanguage(opts.cfg);
  // Build raw params; config hl is the default, caller params can override.
  const rawParams: Record<string, string> = { engine: opts.engine, hl };
  for (const [k, v] of Object.entries(opts.params)) {
    if (v !== undefined && v !== null && v !== "") {
      rawParams[k] = String(v);
    }
  }

  // Filter to caller-declared allowlist; engine and hl are always forwarded.
  const allowed = new Set(opts.allowedParams);
  const filtered = Object.fromEntries(
    Object.entries(rawParams).filter(([k]) => k === "engine" || k === "hl" || allowed.has(k)),
  );

  const isZeroTrace = rawParams.zero_trace === "true";

  sweepExpiredCache();
  const cacheKey = buildCacheKey(filtered);
  if (!isZeroTrace) {
    const cached = RESULT_CACHE.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }
  }

  const urlParams = new URLSearchParams({ ...filtered, api_key: apiKey });
  const url = `${SERPAPI_BASE_URL}?${urlParams.toString()}`;

  const result = await withTrustedWebSearchEndpoint(
    {
      url,
      timeoutSeconds: opts.timeoutSeconds ?? DEFAULT_SERPAPI_TIMEOUT_SECONDS,
      signal: opts.signal,
      init: {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Client-Source": "openclaw",
        },
      },
    },
    async (response: Response) => {
      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        if (response.status === 401) throw new Error("SerpApi: invalid or missing API key.");
        if (response.status === 429)
          throw new Error("SerpApi: quota exhausted. Narrow the request or try later.");
        if (response.status >= 500)
          throw new Error(`SerpApi: upstream error (${response.status}). Try again shortly.`);
        throw new Error(`SerpApi (${opts.engine}) error (${response.status}): ${text}`);
      }
      const text = await response.text();
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error(`SerpApi (${opts.engine}): malformed JSON response`);
      }
    },
  );

  if (!isZeroTrace) {
    RESULT_CACHE.set(cacheKey, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  return result;
}
