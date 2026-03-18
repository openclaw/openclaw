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
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveProviderWebSearchPluginConfig,
  setProviderWebSearchPluginConfigValue,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";

const DEFAULT_KIMI_BASE_URL = "https://api.moonshot.ai/v1";
const DEFAULT_KIMI_MODEL = "moonshot-v1-128k";
const KIMI_WEB_SEARCH_TOOL = {
  type: "builtin_function",
  function: { name: "$web_search" },
} as const;

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

function resolveKimiConfig(searchConfig?: SearchConfigRecord): KimiConfig {
  const kimi = searchConfig?.kimi;
  return kimi && typeof kimi === "object" && !Array.isArray(kimi) ? (kimi as KimiConfig) : {};
}

function resolveKimiApiKey(kimi?: KimiConfig): string | undefined {
  return (
    readConfiguredSecretString(kimi?.apiKey, "tools.web.search.kimi.apiKey") ??
    readProviderEnvValue(["KIMI_API_KEY", "MOONSHOT_API_KEY"])
  );
}

function resolveKimiModel(kimi?: KimiConfig): string {
  const model = typeof kimi?.model === "string" ? kimi.model.trim() : "";
  return model || DEFAULT_KIMI_MODEL;
}

function resolveKimiBaseUrl(kimi?: KimiConfig): string {
  const baseUrl = typeof kimi?.baseUrl === "string" ? kimi.baseUrl.trim() : "";
  return baseUrl || DEFAULT_KIMI_BASE_URL;
}

function extractKimiMessageText(message: KimiMessage | undefined): string | undefined {
  const content = message?.content?.trim();
  if (content) {
    return content;
  }
  const reasoning = message?.reasoning_content?.trim();
  return reasoning || undefined;
}

function extractKimiCitations(data: KimiSearchResponse): string[] {
  const citations = (data.search_results ?? [])
    .map((entry) => entry.url?.trim())
    .filter((url): url is string => Boolean(url));

  for (const toolCall of data.choices?.[0]?.message?.tool_calls ?? []) {
    const rawArguments = toolCall.function?.arguments;
    if (!rawArguments) {
      continue;
    }
    try {
      const parsed = JSON.parse(rawArguments) as {
        search_results?: Array<{ url?: string }>;
        url?: string;
      };
      if (typeof parsed.url === "string" && parsed.url.trim()) {
        citations.push(parsed.url.trim());
      }
      for (const result of parsed.search_results ?? []) {
        if (typeof result.url === "string" && result.url.trim()) {
          citations.push(result.url.trim());
        }
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
}): Promise<{ content: string; citations: string[] }> {
  const endpoint = `${params.baseUrl.trim().replace(/\/$/, "")}/chat/completions`;
  const messages: Array<Record<string, unknown>> = [{ role: "user", content: params.query }];
  const collectedCitations = new Set<string>();

  for (let round = 0; round < 3; round += 1) {
    const next = await withTrustedWebSearchEndpoint(
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
      async (
        res,
      ): Promise<{ done: true; content: string; citations: string[] } | { done: false }> => {
        if (!res.ok) {
          const detail = await res.text();
          throw new Error(`Kimi API error (${res.status}): ${detail || res.statusText}`);
        }

        const data = (await res.json()) as KimiSearchResponse;
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
        let pushed = false;
        for (const toolCall of toolCalls) {
          const toolCallId = toolCall.id?.trim();
          if (!toolCallId) {
            continue;
          }
          pushed = true;
          messages.push({ role: "tool", tool_call_id: toolCallId, content: toolContent });
        }
        if (!pushed) {
          return { done: true, content: text ?? "No response", citations: [...collectedCitations] };
        }
        return { done: false };
      },
    );

    if (next.done) {
      return { content: next.content, citations: next.citations };
    }
  }

  return {
    content: "Search completed but no final answer was produced.",
    citations: [...collectedCitations],
  };
}

function createKimiSchema() {
  return Type.Object({
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: MAX_SEARCH_COUNT,
      }),
    ),
    country: Type.Optional(Type.String({ description: "Not supported by Kimi." })),
    language: Type.Optional(Type.String({ description: "Not supported by Kimi." })),
    freshness: Type.Optional(Type.String({ description: "Not supported by Kimi." })),
    date_after: Type.Optional(Type.String({ description: "Not supported by Kimi." })),
    date_before: Type.Optional(Type.String({ description: "Not supported by Kimi." })),
  });
}

function createKimiToolDefinition(
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search the web using Kimi by Moonshot. Returns AI-synthesized answers with citations from native $web_search.",
    parameters: createKimiSchema(),
    execute: async (args) => {
      const params = args as Record<string, unknown>;
      for (const name of ["country", "language", "freshness", "date_after", "date_before"]) {
        if (readStringParam(params, name)) {
          const label =
            name === "country"
              ? "country filtering"
              : name === "language"
                ? "language filtering"
                : name === "freshness"
                  ? "freshness filtering"
                  : "date_after/date_before filtering";
          return {
            error: name.startsWith("date_") ? "unsupported_date_filter" : `unsupported_${name}`,
            message: `${label} is not supported by the kimi provider. Only Brave and Perplexity support ${name === "country" ? "country filtering" : name === "language" ? "language filtering" : name === "freshness" ? "freshness" : "date filtering"}.`,
            docs: "https://docs.openclaw.ai/tools/web",
          };
        }
      }

      const kimiConfig = resolveKimiConfig(searchConfig);
      const apiKey = resolveKimiApiKey(kimiConfig);
      if (!apiKey) {
        return {
          error: "missing_kimi_api_key",
          message:
            "web_search (kimi) needs a Moonshot API key. Set KIMI_API_KEY or MOONSHOT_API_KEY in the Gateway environment, or configure tools.web.search.kimi.apiKey.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ??
        searchConfig?.maxResults ??
        undefined;
      const model = resolveKimiModel(kimiConfig);
      const baseUrl = resolveKimiBaseUrl(kimiConfig);
      const cacheKey = buildSearchCacheKey([
        "kimi",
        query,
        resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        baseUrl,
        model,
      ]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const start = Date.now();
      const result = await runKimiSearch({
        query,
        apiKey,
        baseUrl,
        model,
        timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
      });
      const payload = {
        query,
        provider: "kimi",
        model,
        tookMs: Date.now() - start,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "kimi",
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

export function createKimiWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "kimi",
    label: "Kimi (Moonshot)",
    hint: "Moonshot web search",
    envVars: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
    placeholder: "sk-...",
    signupUrl: "https://platform.moonshot.cn/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 40,
    credentialPath: "plugins.entries.moonshot.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.moonshot.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) => {
      const kimi = searchConfig?.kimi;
      return kimi && typeof kimi === "object" && !Array.isArray(kimi)
        ? (kimi as Record<string, unknown>).apiKey
        : undefined;
    },
    setCredentialValue: (searchConfigTarget, value) => {
      const scoped = searchConfigTarget.kimi;
      if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
        searchConfigTarget.kimi = { apiKey: value };
        return;
      }
      (scoped as Record<string, unknown>).apiKey = value;
    },
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "moonshot")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "moonshot", "apiKey", value);
    },
    createTool: (ctx) => {
      const pluginConfig = resolveProviderWebSearchPluginConfig(ctx.config, "moonshot");
      const searchConfig = {
        ...(ctx.searchConfig as SearchConfigRecord | undefined),
        kimi: {
          ...((ctx.searchConfig as SearchConfigRecord | undefined)?.kimi as
            | Record<string, unknown>
            | undefined),
          ...(pluginConfig as Record<string, unknown> | undefined),
        },
      } as SearchConfigRecord;
      return createKimiToolDefinition(searchConfig);
    },
  };
}

export const __testing = {
  resolveKimiApiKey,
  resolveKimiModel,
  resolveKimiBaseUrl,
  extractKimiCitations,
} as const;
