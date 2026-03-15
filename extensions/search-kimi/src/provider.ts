import {
  buildSearchRequestCacheIdentity,
  createLegacySearchProviderMetadata,
  createMissingSearchKeyPayload,
  normalizeCacheKey,
  normalizeSecretInput,
  readCache,
  rejectUnsupportedSearchFilters,
  resolveSearchConfig,
  resolveSearchProviderSectionConfig,
  type OpenClawConfig,
  type SearchProviderExecutionResult,
  type SearchProviderLegacyUiMetadata,
  type SearchProviderPlugin,
  withTrustedWebToolsEndpoint,
  wrapWebContent,
  writeCache,
} from "openclaw/plugin-sdk/web-search";

const DEFAULT_KIMI_BASE_URL = "https://api.moonshot.ai/v1";
const DEFAULT_KIMI_MODEL = "moonshot-v1-128k";
const KIMI_WEB_SEARCH_TOOL = {
  type: "builtin_function",
  function: { name: "$web_search" },
} as const;

const KIMI_SEARCH_CACHE = new Map<string, { value: Record<string, unknown>; expiresAt: number }>();

type WebSearchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { search?: infer Search }
    ? Search
    : undefined
  : undefined;

type KimiConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

type KimiToolCall = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type KimiMessage = {
  role?: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: KimiToolCall[];
};

type KimiSearchResponse = {
  choices?: Array<{
    finish_reason?: string;
    message?: KimiMessage;
  }>;
  search_results?: Array<{
    title?: string;
    url?: string;
    content?: string;
  }>;
};

function resolveKimiConfig(search?: WebSearchConfig): KimiConfig {
  return resolveSearchProviderSectionConfig<KimiConfig>(
    search as Record<string, unknown> | undefined,
    "kimi",
  );
}

function resolveKimiApiKey(kimi?: KimiConfig): string | undefined {
  return (
    normalizeSecretInput(kimi?.apiKey) ||
    normalizeSecretInput(process.env.KIMI_API_KEY) ||
    normalizeSecretInput(process.env.MOONSHOT_API_KEY) ||
    undefined
  );
}

function resolveKimiModel(kimi?: KimiConfig): string {
  const fromConfig =
    kimi && "model" in kimi && typeof kimi.model === "string" ? kimi.model.trim() : "";
  return fromConfig || DEFAULT_KIMI_MODEL;
}

function resolveKimiBaseUrl(kimi?: KimiConfig): string {
  const fromConfig =
    kimi && "baseUrl" in kimi && typeof kimi.baseUrl === "string" ? kimi.baseUrl.trim() : "";
  return fromConfig || DEFAULT_KIMI_BASE_URL;
}

function extractKimiMessageText(message: KimiMessage | undefined): string | undefined {
  const content = message?.content?.trim();
  if (content) return content;
  const reasoning = message?.reasoning_content?.trim();
  return reasoning || undefined;
}

function extractKimiCitations(data: KimiSearchResponse): string[] {
  const citations = (data.search_results ?? [])
    .map((entry) => entry.url?.trim())
    .filter((url): url is string => Boolean(url));
  for (const toolCall of data.choices?.[0]?.message?.tool_calls ?? []) {
    const rawArguments = toolCall.function?.arguments;
    if (!rawArguments) continue;
    try {
      const parsed = JSON.parse(rawArguments) as {
        search_results?: Array<{ url?: string }>;
        url?: string;
      };
      if (typeof parsed.url === "string" && parsed.url.trim()) citations.push(parsed.url.trim());
      for (const result of parsed.search_results ?? []) {
        if (typeof result.url === "string" && result.url.trim()) citations.push(result.url.trim());
      }
    } catch {
      // ignore malformed tool arguments
    }
  }
  return [...new Set(citations)];
}

function buildKimiToolResultContent(data: KimiSearchResponse): string {
  return JSON.stringify({
    search_results: (data.search_results ?? []).map((entry) => ({
      title: entry.title ?? "",
      url: entry.url ?? "",
      content: entry.content ?? "",
    })),
  });
}

async function runKimiSearch(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
}) {
  const baseUrl = params.baseUrl.trim().replace(/\/$/, "");
  const endpoint = `${baseUrl}/chat/completions`;
  const messages: Array<Record<string, unknown>> = [{ role: "user", content: params.query }];
  const collectedCitations = new Set<string>();
  const MAX_ROUNDS = 3;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const nextResult = await withTrustedWebToolsEndpoint(
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
            messages,
            tools: [KIMI_WEB_SEARCH_TOOL],
          }),
        },
      },
      async ({
        response,
      }): Promise<{ done: true; content: string; citations: string[] } | { done: false }> => {
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(`Kimi API error (${response.status}): ${detail || response.statusText}`);
        }
        const data = (await response.json()) as KimiSearchResponse;
        for (const citation of extractKimiCitations(data)) {
          collectedCitations.add(citation);
        }
        const choice = data.choices?.[0];
        const message = choice?.message;
        const text = extractKimiMessageText(message);
        const toolCalls = message?.tool_calls ?? [];
        if (choice?.finish_reason !== "tool_calls" || toolCalls.length === 0) {
          return { done: true, content: text ?? "No response", citations: [...collectedCitations] };
        }
        messages.push({
          role: "assistant",
          content: message?.content ?? "",
          ...(message?.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
          tool_calls: toolCalls,
        });
        const toolContent = buildKimiToolResultContent(data);
        let pushedToolResult = false;
        for (const toolCall of toolCalls) {
          const toolCallId = toolCall.id?.trim();
          if (!toolCallId) continue;
          pushedToolResult = true;
          messages.push({
            role: "tool",
            tool_call_id: toolCallId,
            content: toolContent,
          });
        }
        if (!pushedToolResult) {
          return { done: true, content: text ?? "No response", citations: [...collectedCitations] };
        }
        return { done: false };
      },
    );
    if (nextResult.done) {
      return { content: nextResult.content, citations: nextResult.citations };
    }
  }
  return {
    content: "Search completed but no final answer was produced.",
    citations: [...collectedCitations],
  };
}

export const KIMI_SEARCH_PROVIDER_METADATA: SearchProviderLegacyUiMetadata =
  createLegacySearchProviderMetadata({
    provider: "kimi",
    label: "Kimi (Moonshot)",
    hint: "Moonshot web search",
    envKeys: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
    placeholder: "sk-...",
    signupUrl: "https://platform.moonshot.cn/",
    apiKeyConfigPath: "tools.web.search.kimi.apiKey",
  });

export function createBundledKimiSearchProvider(): SearchProviderPlugin {
  return {
    id: "kimi",
    name: "Kimi by Moonshot",
    description:
      "Search the web using Kimi by Moonshot. Returns AI-synthesized answers with citations from native $web_search.",
    pluginOwnedExecution: true,
    legacyConfig: KIMI_SEARCH_PROVIDER_METADATA,
    isAvailable: (config) =>
      Boolean(
        resolveKimiApiKey(
          resolveKimiConfig(
            resolveSearchConfig<WebSearchConfig>(
              config?.tools?.web?.search as Record<string, unknown>,
            ),
          ),
        ),
      ),
    search: async (request, ctx): Promise<SearchProviderExecutionResult> => {
      const search = resolveSearchConfig<WebSearchConfig>(request.providerConfig);
      const kimiConfig = resolveKimiConfig(search);
      const apiKey = resolveKimiApiKey(kimiConfig);
      if (!apiKey) {
        return createMissingSearchKeyPayload(
          "missing_kimi_api_key",
          "web_search (kimi) needs a Moonshot API key. Set KIMI_API_KEY or MOONSHOT_API_KEY in the Gateway environment, or configure tools.web.search.kimi.apiKey.",
        );
      }
      const unsupportedFilter = rejectUnsupportedSearchFilters({
        providerName: "kimi",
        request,
        support: {
          country: false,
          language: false,
          freshness: false,
          date: false,
          domainFilter: false,
        },
      });
      if (unsupportedFilter) {
        return unsupportedFilter;
      }

      const baseUrl = resolveKimiBaseUrl(kimiConfig);
      const model = resolveKimiModel(kimiConfig);
      const cacheKey = normalizeCacheKey(
        `kimi:${baseUrl}:${model}:${buildSearchRequestCacheIdentity({
          query: request.query,
          count: request.count,
        })}`,
      );
      const cached = readCache(KIMI_SEARCH_CACHE, cacheKey);
      if (cached) return { ...cached.value, cached: true } as SearchProviderExecutionResult;
      const startedAt = Date.now();
      const result = await runKimiSearch({
        query: request.query,
        apiKey,
        baseUrl,
        model,
        timeoutSeconds: ctx.timeoutSeconds,
      });
      const payload = {
        query: request.query,
        provider: "kimi",
        model,
        tookMs: Date.now() - startedAt,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "kimi",
          wrapped: true,
        },
        content: wrapWebContent(result.content),
        citations: result.citations,
      };
      writeCache(KIMI_SEARCH_CACHE, cacheKey, payload, ctx.cacheTtlMs);
      return payload as SearchProviderExecutionResult;
    },
  };
}

export const __testing = {
  KIMI_SEARCH_CACHE,
  clearSearchProviderCaches() {
    KIMI_SEARCH_CACHE.clear();
  },
} as const;
