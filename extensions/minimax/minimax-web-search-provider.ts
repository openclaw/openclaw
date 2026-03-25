import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  formatCliCommand,
  MAX_SEARCH_COUNT,
  mergeScopedSearchConfig,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readNumberParam,
  readProviderEnvValue,
  readStringParam,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  setScopedCredentialValue,
  getScopedCredentialValue,
  setProviderWebSearchPluginConfigValue,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";

const DEFAULT_MINIMAX_API_HOST_GLOBAL = "https://api.minimax.io";
const DEFAULT_MINIMAX_API_HOST_CN = "https://api.minimaxi.com";
const SEARCH_PATH = "/v1/coding_plan/search";

type MinimaxSearchConfig = {
  apiKey?: string;
  baseUrl?: string;
};

type MinimaxOrganicResult = {
  title?: string;
  link?: string;
  snippet?: string;
  date?: string;
};

type MinimaxSearchResponse = {
  organic?: MinimaxOrganicResult[];
  related_searches?: Array<{ query?: string }>;
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  };
};

function resolveMinimaxSearchConfig(searchConfig?: SearchConfigRecord): MinimaxSearchConfig {
  const minimax = searchConfig?.minimax;
  return minimax && typeof minimax === "object" && !Array.isArray(minimax)
    ? (minimax as MinimaxSearchConfig)
    : {};
}

function resolveMinimaxSearchApiKeySync(
  minimaxConfig?: MinimaxSearchConfig,
  openclawConfig?: OpenClawConfig,
): string | undefined {
  // 1. Dedicated web-search config
  const dedicated = readConfiguredSecretString(
    minimaxConfig?.apiKey,
    "tools.web.search.minimax.apiKey",
  );
  if (dedicated) {
    return dedicated;
  }

  // 2. MINIMAX_API_KEY / MINIMAX_OAUTH_TOKEN env vars
  const fromEnv = readProviderEnvValue(["MINIMAX_API_KEY", "MINIMAX_OAUTH_TOKEN"]);
  if (fromEnv) {
    return fromEnv;
  }

  // 3. Text model provider's configured apiKey (for users who stored it in config, not env)
  const providerApiKey = resolveProviderConfiguredApiKey(openclawConfig);
  if (providerApiKey) {
    return providerApiKey;
  }

  return undefined;
}

/**
 * Full async credential resolution that also checks the auth profile store
 * (OAuth tokens from device code flow). Falls back through both minimax and
 * minimax-portal providers.
 */
async function resolveMinimaxSearchApiKeyAsync(
  minimaxConfig?: MinimaxSearchConfig,
  openclawConfig?: OpenClawConfig,
): Promise<string | undefined> {
  const syncKey = resolveMinimaxSearchApiKeySync(minimaxConfig, openclawConfig);
  if (syncKey) {
    return syncKey;
  }

  // Try resolving from the auth profile store (handles OAuth tokens)
  for (const providerId of ["minimax", "minimax-portal"] as const) {
    try {
      const auth = await resolveApiKeyForProvider({
        provider: providerId,
        cfg: openclawConfig,
      });
      if (auth.apiKey) {
        return auth.apiKey;
      }
    } catch {
      // Provider not configured or no credentials found; try next.
    }
  }

  return undefined;
}

function resolveProviderConfiguredApiKey(config: OpenClawConfig | undefined): string | undefined {
  for (const providerId of ["minimax", "minimax-portal"] as const) {
    const provider = config?.models?.providers?.[providerId] as { apiKey?: string } | undefined;
    const apiKey = typeof provider?.apiKey === "string" ? provider.apiKey.trim() : "";
    if (apiKey) {
      return apiKey;
    }
  }
  return undefined;
}

/**
 * Detect the API host (Global vs CN) from the minimax provider's configured
 * baseUrl, the MINIMAX_API_HOST env var, or the web-search-specific override.
 * Mirrors the logic in src/agents/minimax-vlm.ts coerceApiHost().
 */
function resolveMinimaxApiHost(
  minimaxConfig?: MinimaxSearchConfig,
  openclawConfig?: OpenClawConfig,
): string {
  // 1. Explicit web-search-level override
  const explicitBaseUrl =
    typeof minimaxConfig?.baseUrl === "string" ? minimaxConfig.baseUrl.trim() : "";
  if (explicitBaseUrl) {
    return normalizeToOrigin(explicitBaseUrl);
  }

  // 2. MINIMAX_API_HOST env var (same as VLM)
  const envHost = process.env.MINIMAX_API_HOST?.trim();
  if (envHost) {
    return normalizeToOrigin(envHost);
  }

  // 3. Infer from the minimax text model provider's configured baseUrl
  const providerBaseUrl =
    resolveProviderConfiguredBaseUrl(openclawConfig, "minimax") ??
    resolveProviderConfiguredBaseUrl(openclawConfig, "minimax-portal");
  if (providerBaseUrl) {
    return normalizeToOrigin(providerBaseUrl);
  }

  return DEFAULT_MINIMAX_API_HOST_GLOBAL;
}

function resolveProviderConfiguredBaseUrl(
  config: OpenClawConfig | undefined,
  providerId: string,
): string | undefined {
  const provider = config?.models?.providers?.[providerId] as { baseUrl?: string } | undefined;
  const baseUrl = typeof provider?.baseUrl === "string" ? provider.baseUrl.trim() : "";
  return baseUrl || undefined;
}

function normalizeToOrigin(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {}
  try {
    return new URL(`https://${raw}`).origin;
  } catch {
    return DEFAULT_MINIMAX_API_HOST_GLOBAL;
  }
}

async function runMinimaxWebSearch(params: {
  query: string;
  apiKey: string;
  apiHost: string;
  timeoutSeconds: number;
}): Promise<{ results: Array<Record<string, unknown>>; relatedSearches: string[] }> {
  const endpoint = `${params.apiHost}${SEARCH_PATH}`;

  return withTrustedWebSearchEndpoint(
    {
      url: endpoint,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey}`,
          "MM-API-Source": "OpenClaw",
        },
        body: JSON.stringify({ query: params.query }),
      },
    },
    async (res) => {
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`MiniMax Search API error (${res.status}): ${detail || res.statusText}`);
      }

      const data = (await res.json()) as MinimaxSearchResponse;

      // Check base_resp for API-level errors
      const statusCode = data.base_resp?.status_code;
      if (statusCode !== undefined && statusCode !== 0) {
        const statusMsg = data.base_resp?.status_msg ?? "";
        throw new Error(
          `MiniMax Search API error (${statusCode})${statusMsg ? `: ${statusMsg}` : ""}`,
        );
      }

      const organic = Array.isArray(data.organic) ? data.organic : [];
      const results = organic.map((entry) => {
        const title = entry.title ?? "";
        const url = entry.link ?? "";
        const snippet = entry.snippet ?? "";
        return {
          title: title ? wrapWebContent(title, "web_search") : "",
          url,
          description: snippet ? wrapWebContent(snippet, "web_search") : "",
          published: entry.date || undefined,
          siteName: resolveSiteName(url) || undefined,
        };
      });

      const relatedSearches = (data.related_searches ?? [])
        .map((r) => r.query?.trim())
        .filter((q): q is string => Boolean(q));

      return { results, relatedSearches };
    },
  );
}

function createMinimaxSearchSchema() {
  return Type.Object({
    query: Type.String({
      description:
        "Search query string. Aim for 3-5 keywords for best results. For time-sensitive topics, include the current date (e.g. 'latest iPhone 2025').",
    }),
    count: Type.Optional(
      Type.Number({
        description: "Maximum number of results to return (1-10).",
        minimum: 1,
        maximum: MAX_SEARCH_COUNT,
      }),
    ),
  });
}

function createMinimaxSearchToolDefinition(
  searchConfig?: SearchConfigRecord,
  openclawConfig?: OpenClawConfig,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search the web using MiniMax. Returns structured search results with titles, URLs, snippets, and related search suggestions.",
    parameters: createMinimaxSearchSchema(),
    execute: async (args) => {
      const minimaxConfig = resolveMinimaxSearchConfig(searchConfig);
      const apiKey = await resolveMinimaxSearchApiKeyAsync(minimaxConfig, openclawConfig);
      if (!apiKey) {
        return {
          error: "missing_minimax_api_key",
          message: `web_search (minimax) needs a MiniMax API key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set MINIMAX_API_KEY in the Gateway environment.`,
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ??
        searchConfig?.maxResults ??
        undefined;
      const apiHost = resolveMinimaxApiHost(minimaxConfig, openclawConfig);

      const cacheKey = buildSearchCacheKey(["minimax", query, apiHost]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const start = Date.now();
      const { results: allResults, relatedSearches } = await runMinimaxWebSearch({
        query,
        apiKey,
        apiHost,
        timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
      });

      // The API does not accept a count param; truncate client-side.
      const maxCount = resolveSearchCount(count, DEFAULT_SEARCH_COUNT);
      const results = allResults.slice(0, maxCount);

      const payload = {
        query,
        provider: "minimax",
        count: results.length,
        tookMs: Date.now() - start,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "minimax",
          wrapped: true,
        },
        results,
        ...(relatedSearches.length > 0 ? { relatedSearches } : {}),
      };
      writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
      return payload;
    },
  };
}

export function createMinimaxWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "minimax",
    label: "MiniMax Search",
    hint: "Requires MiniMax API key · structured web search results",
    credentialLabel: "MiniMax API key",
    envVars: ["MINIMAX_API_KEY", "MINIMAX_OAUTH_TOKEN"],
    placeholder: "sk-...",
    signupUrl: "https://platform.minimax.io/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 35,
    credentialPath: "plugins.entries.minimax.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.minimax.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "minimax"),
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "minimax", value),
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "minimax")?.apiKey ??
      resolveProviderConfiguredApiKey(config),
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "minimax", "apiKey", value);
    },
    createTool: (ctx) =>
      createMinimaxSearchToolDefinition(
        mergeScopedSearchConfig(
          ctx.searchConfig as SearchConfigRecord | undefined,
          "minimax",
          resolveProviderWebSearchPluginConfig(ctx.config, "minimax"),
        ) as SearchConfigRecord | undefined,
        ctx.config,
      ),
  };
}

export const __testing = {
  resolveMinimaxSearchApiKeySync,
  resolveMinimaxSearchApiKeyAsync,
  resolveMinimaxApiHost,
} as const;
