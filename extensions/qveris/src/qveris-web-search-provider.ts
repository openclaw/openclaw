import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
  buildSearchCacheKey,
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_SEARCH_COUNT,
  DEFAULT_TIMEOUT_SECONDS,
  enablePluginInConfig,
  getScopedCredentialValue,
  MAX_SEARCH_COUNT,
  readCachedSearchPayload,
  readNumberParam,
  readStringParam,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveWebSearchProviderCredential,
  setScopedCredentialValue,
  setProviderWebSearchPluginConfigValue,
  resolveProviderWebSearchPluginConfig,
  type WebSearchProviderPlugin,
  withTrustedWebSearchEndpoint,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";

const DEFAULT_QVERIS_SEARCH_TOOL_ID = "xiaosu.smartsearch.search.retrieve.v2.6c50f296_domestic";

type QverisRegion = "global" | "cn";

const QVERIS_REGION_DOMAINS: Record<QverisRegion, string> = {
  global: "qveris.ai",
  cn: "qveris.cn",
};

type QverisExecutionResponse = {
  execution_id: string;
  result: {
    data: unknown;
  };
  success: boolean;
  error_message: string | null;
  elapsed_time_ms: number;
};

function resolveQverisRegion(config?: OpenClawConfig): QverisRegion {
  const qverisConfig = config?.tools?.qveris as Record<string, unknown> | undefined;
  return qverisConfig?.region === "cn" ? "cn" : "global";
}

function resolveQverisBaseUrl(
  searchConfig?: Record<string, unknown>,
  config?: OpenClawConfig,
): string {
  const scoped = searchConfig?.qveris as Record<string, unknown> | undefined;
  const fromSearchConfig = typeof scoped?.baseUrl === "string" ? scoped.baseUrl.trim() : "";
  if (fromSearchConfig) {
    return fromSearchConfig;
  }

  const globalQveris = config?.tools?.qveris as Record<string, unknown> | undefined;
  const fromGlobalConfig =
    typeof globalQveris?.baseUrl === "string" ? globalQveris.baseUrl.trim() : "";
  if (fromGlobalConfig) {
    return fromGlobalConfig;
  }

  const region = resolveQverisRegion(config);
  return `https://${QVERIS_REGION_DOMAINS[region]}/api/v1`;
}

function resolveQverisToolId(searchConfig?: Record<string, unknown>): string {
  const scoped = searchConfig?.qveris as Record<string, unknown> | undefined;
  const toolId = typeof scoped?.toolId === "string" ? scoped.toolId.trim() : "";
  return toolId || DEFAULT_QVERIS_SEARCH_TOOL_ID;
}

function resolveQverisApiKey(
  searchConfig?: Record<string, unknown>,
  config?: OpenClawConfig,
): string | undefined {
  // 1. Check scoped search config: tools.web.search.qveris.apiKey
  const fromPlugin = resolveWebSearchProviderCredential({
    credentialValue: getScopedCredentialValue(searchConfig, "qveris"),
    path: "tools.web.search.qveris.apiKey",
    envVars: [],
  });
  if (fromPlugin) {
    return fromPlugin;
  }

  // 2. Check plugin config: plugins.entries.qveris.config.webSearch.apiKey
  const pluginConfig = resolveProviderWebSearchPluginConfig(config, "qveris");
  if (pluginConfig?.apiKey) {
    const fromPluginEntry = resolveWebSearchProviderCredential({
      credentialValue: pluginConfig.apiKey,
      path: "plugins.entries.qveris.config.webSearch.apiKey",
      envVars: [],
    });
    if (fromPluginEntry) {
      return fromPluginEntry;
    }
  }

  // 3. Fallback to global qveris config: tools.qveris.apiKey
  const globalQveris = config?.tools?.qveris as Record<string, unknown> | undefined;
  if (globalQveris?.apiKey) {
    const fromGlobal = resolveWebSearchProviderCredential({
      credentialValue: globalQveris.apiKey,
      path: "tools.qveris.apiKey",
      envVars: [],
    });
    if (fromGlobal) {
      return fromGlobal;
    }
  }

  // 4. Env var fallback
  return resolveWebSearchProviderCredential({
    credentialValue: undefined,
    path: "tools.web.search.qveris.apiKey",
    envVars: ["QVERIS_API_KEY"],
  });
}

async function runQverisSearch(params: {
  query: string;
  toolId: string;
  apiKey: string;
  baseUrl: string;
  timeoutSeconds: number;
  sessionId?: string;
}): Promise<{ data: unknown; elapsedMs: number }> {
  const endpoint = `${params.baseUrl.replace(/\/$/, "")}/tools/execute?tool_id=${encodeURIComponent(params.toolId)}`;

  return withTrustedWebSearchEndpoint(
    {
      url: endpoint,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey}`,
        },
        body: JSON.stringify({
          parameters: {
            q: params.query,
          },
          max_response_size: 20480,
          ...(params.sessionId ? { session_id: params.sessionId } : {}),
        }),
      },
    },
    async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`QVeris API error (${res.status}): ${text || res.statusText}`);
      }

      const data = (await res.json()) as QverisExecutionResponse;
      if (!data.success) {
        throw new Error(`QVeris search failed: ${data.error_message ?? "Unknown error"}`);
      }

      return {
        data: data.result?.data,
        elapsedMs: data.elapsed_time_ms,
      };
    },
  );
}

export function createQverisWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "qveris",
    label: "QVeris",
    hint: "Requires QVeris API key · QVeris smart search",
    credentialLabel: "QVeris API key",
    envVars: ["QVERIS_API_KEY"],
    placeholder: "qv-...",
    signupUrl: "https://qveris.ai/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 25,
    credentialPath: "plugins.entries.qveris.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.qveris.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig?: Record<string, unknown>) =>
      getScopedCredentialValue(searchConfig, "qveris"),
    setCredentialValue: (searchConfigTarget: Record<string, unknown>, value: unknown) =>
      setScopedCredentialValue(searchConfigTarget, "qveris", value),
    getConfiguredCredentialValue: (config?: OpenClawConfig) => {
      // Also check global tools.qveris.apiKey as a fallback
      const pluginVal = resolveProviderWebSearchPluginConfig(config, "qveris")?.apiKey;
      if (pluginVal) {
        return pluginVal;
      }
      const globalQveris = config?.tools?.qveris as Record<string, unknown> | undefined;
      return globalQveris?.apiKey;
    },
    setConfiguredCredentialValue: (configTarget: OpenClawConfig, value: unknown) => {
      setProviderWebSearchPluginConfigValue(configTarget, "qveris", "apiKey", value);
    },
    applySelectionConfig: (config: OpenClawConfig) => enablePluginInConfig(config, "qveris").config,
    createTool: (ctx) => ({
      description:
        "Search the web using QVeris smart search API. Returns relevant search results from third-party data sources.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query string." }),
        count: Type.Optional(
          Type.Number({
            description: `Number of results to return (1-${MAX_SEARCH_COUNT}).`,
            minimum: 1,
            maximum: MAX_SEARCH_COUNT,
          }),
        ),
      }),
      execute: async (args: Record<string, unknown>) => {
        const apiKey = resolveQverisApiKey(ctx.searchConfig, ctx.config);
        if (!apiKey) {
          return {
            error: "missing_qveris_api_key",
            message:
              "web_search (qveris) needs an API key. Set QVERIS_API_KEY in the Gateway environment, or configure tools.qveris.apiKey or tools.web.search.qveris.apiKey.",
            docs: "https://docs.openclaw.ai/tools/web",
          };
        }

        const query = readStringParam(args, "query", { required: true });
        const count = readNumberParam(args, "count", { integer: true });
        const baseUrl = resolveQverisBaseUrl(ctx.searchConfig, ctx.config);
        const toolId = resolveQverisToolId(ctx.searchConfig);
        const timeoutSeconds = resolveSearchTimeoutSeconds(
          ctx.searchConfig as Record<string, unknown> | undefined,
        );
        const cacheTtlMs = resolveSearchCacheTtlMs(
          ctx.searchConfig as Record<string, unknown> | undefined,
        );

        const cacheKey = buildSearchCacheKey([
          "qveris",
          toolId,
          baseUrl,
          query,
          count ?? DEFAULT_SEARCH_COUNT,
        ]);
        const cached = readCachedSearchPayload(cacheKey);
        if (cached) {
          return cached;
        }

        const { data, elapsedMs } = await runQverisSearch({
          query,
          toolId,
          apiKey,
          baseUrl,
          timeoutSeconds,
          sessionId: (ctx.runtimeMetadata as Record<string, unknown> | undefined)
            ?.agentSessionKey as string | undefined,
        });

        const payload: Record<string, unknown> = {
          query,
          provider: "qveris",
          toolId,
          tookMs: elapsedMs,
          data,
        };
        writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
        return payload;
      },
    }),
  };
}

export const __testing = {
  resolveQverisApiKey,
  resolveQverisBaseUrl,
  resolveQverisToolId,
  runQverisSearch,
  QVERIS_REGION_DOMAINS,
};
