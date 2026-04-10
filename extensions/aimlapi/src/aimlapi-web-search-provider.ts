import { Type } from "@sinclair/typebox";
import {
  buildSearchCacheKey,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readProviderEnvValue,
  readStringArrayParam,
  readStringParam,
  resolveSearchCacheTtlMs,
  resolveSearchTimeoutSeconds,
  resolveProviderWebSearchPluginConfig,
  setProviderWebSearchPluginConfigValue,
  setScopedCredentialValue,
  type SearchConfigRecord,
  type OpenClawConfig,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";

const DEFAULT_AIMLAPI_BASE_URL = "https://api.aimlapi.com/v1";
const DEFAULT_AIMLAPI_MODEL = "perplexity/sonar-pro";

type AimlapiConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

type AimlapiSearchResponse = {
  choices?: Array<{
    message?: {
      content?: string;
      annotations?: Array<{
        type?: string;
        url?: string;
        url_citation?: {
          url?: string;
        };
      }>;
    };
  }>;
  citations?: string[];
  search_results?: Array<{
    title?: string;
    url?: string;
    date?: string;
    last_updated?: string;
  }>;
};

function resolveAimlapiConfig(
  config?: OpenClawConfig,
  searchConfig?: SearchConfigRecord,
): AimlapiConfig {
  const pluginConfig = resolveProviderWebSearchPluginConfig(config, "aimlapi");
  const scoped = (searchConfig as Record<string, unknown> | undefined)?.aimlapi;
  const legacyConfig =
    scoped && typeof scoped === "object" && !Array.isArray(scoped)
      ? (scoped as AimlapiConfig)
      : undefined;
  if (!pluginConfig && !legacyConfig) {
    return {};
  }
  return {
    ...legacyConfig,
    ...(pluginConfig as AimlapiConfig | undefined),
  };
}

function resolveAimlapiApiKey(aimlapi?: AimlapiConfig): string | undefined {
  return (
    readConfiguredSecretString(
      aimlapi?.apiKey,
      "plugins.entries.aimlapi.config.webSearch.apiKey",
    ) ?? readProviderEnvValue(["AIMLAPI_API_KEY"])
  );
}

function resolveConfiguredAimlapiCredentialValue(config?: OpenClawConfig): unknown {
  const pluginCredential = resolveProviderWebSearchPluginConfig(config, "aimlapi")?.apiKey;
  if (pluginCredential !== undefined) {
    return pluginCredential;
  }
  const legacyConfig = config?.tools?.web?.search?.aimlapi;
  return legacyConfig && typeof legacyConfig === "object" && !Array.isArray(legacyConfig)
    ? (legacyConfig as Record<string, unknown>).apiKey
    : undefined;
}

function hasReusableAimlapiProviderAuthMetadata(config: OpenClawConfig): boolean {
  return Object.entries(config.auth?.profiles ?? {}).some(
    ([profileId, profile]) =>
      profileId === "aimlapi:default" ||
      profileId.startsWith("aimlapi:") ||
      (typeof profile === "object" && profile !== null && profile.provider === "aimlapi"),
  );
}

async function hasReusableAimlapiProviderAuth(config: OpenClawConfig): Promise<boolean> {
  if (!hasReusableAimlapiProviderAuthMetadata(config)) {
    return false;
  }

  try {
    const resolved = await resolveApiKeyForProvider({
      provider: "aimlapi",
      cfg: config,
    });
    const apiKey = resolved?.apiKey?.trim();
    if (!apiKey) {
      return false;
    }

    const response = await fetch("https://api.aimlapi.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: "",
      signal: AbortSignal.timeout(10_000),
    });

    return response.ok || response.status === 400;
  } catch {
    return false;
  }
}

function resolveAimlapiBaseUrl(aimlapi?: AimlapiConfig): string {
  const baseUrl = typeof aimlapi?.baseUrl === "string" ? aimlapi.baseUrl.trim() : "";
  return baseUrl || DEFAULT_AIMLAPI_BASE_URL;
}

function resolveAimlapiModel(aimlapi?: AimlapiConfig): string {
  const model = typeof aimlapi?.model === "string" ? aimlapi.model.trim() : "";
  return model || DEFAULT_AIMLAPI_MODEL;
}

function extractAimlapiCitations(data: AimlapiSearchResponse): string[] {
  const citations: string[] = [];
  for (const value of data.citations ?? []) {
    const trimmed = value?.trim();
    if (trimmed) {
      citations.push(trimmed);
    }
  }
  if (citations.length > 0) {
    return [...new Set(citations)];
  }

  for (const choice of data.choices ?? []) {
    for (const annotation of choice.message?.annotations ?? []) {
      if (annotation.type !== "url_citation") {
        continue;
      }
      const url = annotation.url_citation?.url ?? annotation.url;
      const trimmed = typeof url === "string" ? url.trim() : "";
      if (trimmed) {
        citations.push(trimmed);
      }
    }
  }

  return [...new Set(citations)];
}

function normalizeAimlapiDateFilter(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const match = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/.exec(trimmed);
  if (!match?.groups) {
    return trimmed;
  }

  const month = Number.parseInt(match.groups.month, 10);
  const day = Number.parseInt(match.groups.day, 10);
  const year = Number.parseInt(match.groups.year, 10);
  if (
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(year) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return trimmed;
  }

  return `${month}/${day}/${year}`;
}

async function runAimlapiSearch(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
  freshness?: string;
  dateAfter?: string;
  dateBefore?: string;
  domainFilter?: string[];
}): Promise<{
  content: string;
  citations: string[];
  searchResults: Array<Record<string, unknown>>;
}> {
  const endpoint = `${params.baseUrl.replace(/\/$/, "")}/chat/completions`;
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
          model: params.model,
          messages: [{ role: "user", content: params.query }],
          web_search_options: {
            ...(params.freshness ? { search_recency_filter: params.freshness } : {}),
            ...(params.dateAfter
              ? { search_after_date_filter: normalizeAimlapiDateFilter(params.dateAfter) }
              : {}),
            ...(params.dateBefore
              ? { search_before_date_filter: normalizeAimlapiDateFilter(params.dateBefore) }
              : {}),
            ...(params.domainFilter?.length ? { search_domain_filter: params.domainFilter } : {}),
          },
        }),
      },
    },
    async (res) => {
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`AI/ML API error (${res.status}): ${detail || res.statusText}`);
      }

      const data = (await res.json()) as AimlapiSearchResponse;
      return {
        content: data.choices?.[0]?.message?.content?.trim() || "No response",
        citations: extractAimlapiCitations(data),
        searchResults: (data.search_results ?? []).map((result) => ({
          title: result.title ?? "",
          url: result.url ?? "",
          date: result.date ?? result.last_updated ?? undefined,
        })),
      };
    },
  );
}

function createAimlapiSchema() {
  return Type.Object({
    query: Type.String({ description: "Search query string." }),
    freshness: Type.Optional(
      Type.String({
        description: "Filter by time: 'day' (24h), 'week', 'month', or 'year'.",
      }),
    ),
    date_after: Type.Optional(
      Type.String({
        description: "Only results published after this date (YYYY-MM-DD).",
      }),
    ),
    date_before: Type.Optional(
      Type.String({
        description: "Only results published before this date (YYYY-MM-DD).",
      }),
    ),
    domain_filter: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Domain allowlist/denylist. Use either all positive entries or all entries prefixed with '-'.",
      }),
    ),
  });
}

function createAimlapiToolDefinition(
  config?: OpenClawConfig,
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search the web using AI/ML API. Best with Perplexity Sonar-compatible models and returns AI-synthesized answers with citations.",
    parameters: createAimlapiSchema(),
    execute: async (args) => {
      const aimlapiConfig = resolveAimlapiConfig(config, searchConfig);
      const configuredApiKey = resolveAimlapiApiKey(aimlapiConfig);
      const auth = configuredApiKey
        ? undefined
        : await resolveApiKeyForProvider({
            provider: "aimlapi",
            cfg: config,
          });
      const apiKey = configuredApiKey ?? auth?.apiKey;
      if (!apiKey) {
        return {
          error: "missing_aimlapi_api_key",
          message:
            "web_search (aimlapi) needs an AI/ML API key. Set AIMLAPI_API_KEY in the Gateway environment, configure plugins.entries.aimlapi.config.webSearch.apiKey, or sign in to AI/ML API as a model provider.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      const params = args;
      const query = readStringParam(params, "query", { required: true });
      const freshness = readStringParam(params, "freshness");
      const dateAfter = readStringParam(params, "date_after");
      const dateBefore = readStringParam(params, "date_before");
      const domainFilter = readStringArrayParam(params, "domain_filter");

      if (freshness && (dateAfter || dateBefore)) {
        return {
          error: "conflicting_time_filters",
          message:
            "freshness and date_after/date_before cannot be used together. Use either freshness or an explicit date range.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      if (domainFilter && domainFilter.length > 0) {
        const hasDenylist = domainFilter.some((domain) => domain.startsWith("-"));
        const hasAllowlist = domainFilter.some((domain) => !domain.startsWith("-"));
        if (hasAllowlist && hasDenylist) {
          return {
            error: "invalid_domain_filter",
            message:
              "domain_filter cannot mix allowlist and denylist entries. Use either all positive entries or all entries prefixed with '-'.",
            docs: "https://docs.openclaw.ai/tools/web",
          };
        }
      }

      const model = resolveAimlapiModel(aimlapiConfig);
      const baseUrl = resolveAimlapiBaseUrl(aimlapiConfig);
      const cacheKey = buildSearchCacheKey([
        "aimlapi",
        query,
        model,
        baseUrl,
        freshness,
        dateAfter,
        dateBefore,
        domainFilter?.join(","),
      ]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const start = Date.now();
      const result = await runAimlapiSearch({
        query,
        apiKey,
        baseUrl,
        model,
        timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
        freshness: freshness || undefined,
        dateAfter: dateAfter || undefined,
        dateBefore: dateBefore || undefined,
        domainFilter: domainFilter?.length ? domainFilter : undefined,
      });
      const payload = {
        query,
        provider: "aimlapi",
        model,
        tookMs: Date.now() - start,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "aimlapi",
          wrapped: true,
        },
        content: wrapWebContent(result.content),
        citations: result.citations,
        searchResults: result.searchResults,
      };
      writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
      return payload;
    },
  };
}

export function createAimlapiWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "aimlapi",
    label: "AI/ML API Search",
    hint: "AIMLAPI web search via Perplexity Sonar-compatible models",
    envVars: ["AIMLAPI_API_KEY"],
    placeholder: "aiml-...",
    signupUrl: "https://aimlapi.com",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 15,
    onboardingScopes: ["text-inference"],
    credentialPath: "plugins.entries.aimlapi.config.webSearch.apiKey",
    inactiveSecretPaths: [
      "plugins.entries.aimlapi.config.webSearch.apiKey",
      "tools.web.search.aimlapi.apiKey",
    ],
    getCredentialValue: (searchConfig) => {
      const aimlapi = searchConfig?.aimlapi;
      return aimlapi && typeof aimlapi === "object" && !Array.isArray(aimlapi)
        ? (aimlapi as Record<string, unknown>).apiKey
        : undefined;
    },
    setCredentialValue: (searchConfigTarget, value) => {
      setScopedCredentialValue(searchConfigTarget, "aimlapi", value);
    },
    getConfiguredCredentialValue: (config) => resolveConfiguredAimlapiCredentialValue(config),
    hasReusableProviderAuthMetadata: ({ config }) => hasReusableAimlapiProviderAuthMetadata(config),
    hasReusableProviderAuth: async ({ config }) => await hasReusableAimlapiProviderAuth(config),
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "aimlapi", "apiKey", value);
    },
    createTool: (ctx) =>
      createAimlapiToolDefinition(ctx.config, ctx.searchConfig as SearchConfigRecord | undefined),
  };
}

export const __testing = {
  resolveAimlapiConfig,
  resolveAimlapiApiKey,
  resolveConfiguredAimlapiCredentialValue,
  hasReusableAimlapiProviderAuthMetadata,
  hasReusableAimlapiProviderAuth,
  resolveAimlapiBaseUrl,
  resolveAimlapiModel,
  extractAimlapiCitations,
} as const;
