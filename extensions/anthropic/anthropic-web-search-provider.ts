import { Type } from "@sinclair/typebox";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readNumberParam,
  readProviderEnvValue,
  readStringParam,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  setProviderWebSearchPluginConfigValue,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";

/**
 * Anthropic native web search provider.
 *
 * Unlike other providers (Brave, Gemini, Perplexity) which make client-side HTTP
 * requests to external search APIs, Anthropic's web search is a **server-side tool**
 * (`web_search_20250305` / `web_search_20260209`). In the canonical flow, it gets
 * passed in the `tools` array of the Anthropic Messages API and Claude executes
 * searches autonomously during generation.
 *
 * This provider bridges the architecture gap by making a direct call to the
 * Anthropic Messages API with the web search tool, extracting the search results
 * and citations from the response, and returning them in OpenClaw's standard
 * format. This allows Anthropic web search to work within the existing
 * client-side provider pipeline.
 *
 * Future work: A more native integration could inject `web_search_20260209`
 * directly into the tools array when the active model is Anthropic, bypassing
 * the client-side interception entirely.
 */

const ANTHROPIC_API_BASE = "https://api.anthropic.com/v1";
const DEFAULT_TOOL_VERSION = "web_search_20250305";
const DEFAULT_MODEL = "claude-sonnet-4-5-20250514";
const API_VERSION = "2023-06-01";

type AnthropicWebSearchConfig = {
  apiKey?: string;
  toolVersion?: string;
  model?: string;
  maxUses?: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
  userLocation?: {
    type?: string;
    city?: string;
    region?: string;
    country?: string;
    timezone?: string;
  };
};

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "web_search_tool_result";
      tool_use_id: string;
      content: Array<{
        type: "web_search_result";
        url: string;
        title?: string;
        encrypted_content?: string;
        page_age?: string;
      }>;
    }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: string; [key: string]: unknown };

type AnthropicMessagesResponse = {
  id?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  error?: {
    type?: string;
    message?: string;
  };
};

function resolveAnthropicConfig(searchConfig?: SearchConfigRecord): AnthropicWebSearchConfig {
  const anthropic = searchConfig?.anthropic;
  return anthropic && typeof anthropic === "object" && !Array.isArray(anthropic)
    ? (anthropic as AnthropicWebSearchConfig)
    : {};
}

function resolveAnthropicApiKey(config?: AnthropicWebSearchConfig): string | undefined {
  return (
    readConfiguredSecretString(config?.apiKey, "tools.web.search.anthropic.apiKey") ??
    readProviderEnvValue(["ANTHROPIC_API_KEY"])
  );
}

function resolveToolVersion(config?: AnthropicWebSearchConfig): string {
  const version = typeof config?.toolVersion === "string" ? config.toolVersion.trim() : "";
  return version || DEFAULT_TOOL_VERSION;
}

function resolveModel(config?: AnthropicWebSearchConfig): string {
  const model = typeof config?.model === "string" ? config.model.trim() : "";
  return model || DEFAULT_MODEL;
}

async function runAnthropicWebSearch(params: {
  query: string;
  apiKey: string;
  toolVersion: string;
  model: string;
  timeoutSeconds: number;
  config?: AnthropicWebSearchConfig;
}): Promise<{ content: string; citations: Array<{ url: string; title?: string }> }> {
  const endpoint = `${ANTHROPIC_API_BASE}/messages`;

  const webSearchTool: Record<string, unknown> = {
    type: params.toolVersion,
    name: "web_search",
    max_uses: params.config?.maxUses ?? 5,
  };

  if (
    params.config?.allowedDomains &&
    Array.isArray(params.config.allowedDomains) &&
    params.config.allowedDomains.length > 0
  ) {
    webSearchTool.allowed_domains = params.config.allowedDomains;
  }

  if (
    params.config?.blockedDomains &&
    Array.isArray(params.config.blockedDomains) &&
    params.config.blockedDomains.length > 0
  ) {
    webSearchTool.blocked_domains = params.config.blockedDomains;
  }

  if (params.config?.userLocation) {
    const loc = params.config.userLocation;
    webSearchTool.user_location = {
      type: loc.type || "approximate",
      ...(loc.city ? { city: loc.city } : {}),
      ...(loc.region ? { region: loc.region } : {}),
      ...(loc.country ? { country: loc.country } : {}),
      ...(loc.timezone ? { timezone: loc.timezone } : {}),
    };
  }

  return withTrustedWebSearchEndpoint(
    {
      url: endpoint,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": params.apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify({
          model: params.model,
          max_tokens: 4096,
          tools: [webSearchTool],
          messages: [
            {
              role: "user",
              content: params.query,
            },
          ],
        }),
      },
    },
    async (res) => {
      if (!res.ok) {
        const detail = (await res.text()) || res.statusText;
        const safeDetail = detail.replace(/sk-ant-[^\s"]+/gi, "sk-ant-***");
        throw new Error(`Anthropic API error (${res.status}): ${safeDetail}`);
      }

      let data: AnthropicMessagesResponse;
      try {
        data = (await res.json()) as AnthropicMessagesResponse;
      } catch (error) {
        throw new Error(`Anthropic API returned invalid JSON: ${String(error)}`, { cause: error });
      }

      if (data.error) {
        throw new Error(
          `Anthropic API error: ${data.error.message || data.error.type || "unknown"}`,
        );
      }

      const textParts: string[] = [];
      const citations: Array<{ url: string; title?: string }> = [];

      for (const block of data.content ?? []) {
        if (block.type === "text" && "text" in block) {
          textParts.push(String((block as { text: string }).text));
        } else if (block.type === "web_search_tool_result" && "content" in block) {
          const results = (block as { content: Array<{ type: string; url?: string; title?: string }> }).content;
          for (const result of results ?? []) {
            if (result.type === "web_search_result" && result.url) {
              citations.push({
                url: result.url,
                title: result.title || undefined,
              });
            }
          }
        }
      }

      const content = textParts.join("\n") || "No response";
      return { content, citations };
    },
  );
}

function createAnthropicWebSearchSchema() {
  return Type.Object({
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: MAX_SEARCH_COUNT,
      }),
    ),
    country: Type.Optional(
      Type.String({
        description:
          "2-letter country code for region-specific results (e.g., 'DE', 'US', 'ALL'). Default: 'US'.",
      }),
    ),
    language: Type.Optional(
      Type.String({
        description: "ISO 639-1 language code for results (e.g., 'en', 'de', 'fr').",
      }),
    ),
    freshness: Type.Optional(
      Type.String({
        description: "Filter by time: 'day' (24h), 'week', 'month', or 'year'.",
      }),
    ),
    date_after: Type.Optional(
      Type.String({ description: "Only results published after this date (YYYY-MM-DD)." }),
    ),
    date_before: Type.Optional(
      Type.String({ description: "Only results published before this date (YYYY-MM-DD)." }),
    ),
  });
}

function createAnthropicWebSearchToolDefinition(
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search the web using Anthropic's native web search. Returns AI-synthesized answers with citations powered by Claude's built-in web search capability.",
    parameters: createAnthropicWebSearchSchema(),
    execute: async (args) => {
      const params = args as Record<string, unknown>;

      // Anthropic's server-side web search does not support these client-side filters
      for (const name of ["freshness", "date_after", "date_before"]) {
        if (readStringParam(params, name)) {
          return {
            error: name.startsWith("date_") ? "unsupported_date_filter" : `unsupported_${name}`,
            message: `${name} filtering is not supported by the anthropic provider. Anthropic's native web search handles freshness automatically.`,
            docs: "https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search",
          };
        }
      }

      const anthropicConfig = resolveAnthropicConfig(searchConfig);
      const apiKey = resolveAnthropicApiKey(anthropicConfig);
      if (!apiKey) {
        return {
          error: "missing_anthropic_api_key",
          message:
            "web_search (anthropic) needs an API key. Set ANTHROPIC_API_KEY in the Gateway environment, or configure tools.web.search.anthropic.apiKey.",
          docs: "https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search",
        };
      }

      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ??
        searchConfig?.maxResults ??
        undefined;
      const toolVersion = resolveToolVersion(anthropicConfig);
      const model = resolveModel(anthropicConfig);

      const cacheKey = buildSearchCacheKey([
        "anthropic",
        query,
        resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        toolVersion,
        model,
      ]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const start = Date.now();
      const result = await runAnthropicWebSearch({
        query,
        apiKey,
        toolVersion,
        model,
        timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
        config: anthropicConfig,
      });

      const payload = {
        query,
        provider: "anthropic",
        model,
        toolVersion,
        tookMs: Date.now() - start,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "anthropic",
          wrapped: true,
        },
        content: wrapWebContent(result.content),
        citations: result.citations,
      };

      writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
      return payload;
    },
  };
}

export function createAnthropicWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "anthropic",
    label: "Anthropic (Native Web Search)",
    hint: "Claude native web search · AI-synthesized",
    envVars: ["ANTHROPIC_API_KEY"],
    placeholder: "sk-ant-...",
    signupUrl: "https://console.anthropic.com/settings/keys",
    docsUrl: "https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search",
    autoDetectOrder: 15,
    credentialPath: "plugins.entries.anthropic.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.anthropic.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) => {
      const anthropic = searchConfig?.anthropic;
      return anthropic && typeof anthropic === "object" && !Array.isArray(anthropic)
        ? (anthropic as Record<string, unknown>).apiKey
        : undefined;
    },
    setCredentialValue: (searchConfigTarget, value) => {
      const scoped = searchConfigTarget.anthropic;
      if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
        searchConfigTarget.anthropic = { apiKey: value };
        return;
      }
      (scoped as Record<string, unknown>).apiKey = value;
    },
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "anthropic")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "anthropic", "apiKey", value);
    },
    createTool: (ctx) =>
      createAnthropicWebSearchToolDefinition(
        (() => {
          const searchConfig = ctx.searchConfig as SearchConfigRecord | undefined;
          const pluginConfig = resolveProviderWebSearchPluginConfig(ctx.config, "anthropic");
          if (!pluginConfig) {
            return searchConfig;
          }
          return {
            ...(searchConfig ?? {}),
            anthropic: {
              ...resolveAnthropicConfig(searchConfig),
              ...pluginConfig,
            },
          } as SearchConfigRecord;
        })(),
      ),
  };
}

export const __testing = {
  resolveAnthropicApiKey,
  resolveToolVersion,
  resolveModel,
} as const;
