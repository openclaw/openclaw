import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  isNonSecretApiKeyMarker,
  normalizeOptionalSecretInput,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveEnvApiKey } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  enablePluginInConfig,
  readNumberParam,
  readResponseText,
  readStringParam,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCount,
  resolveSiteName,
  truncateText,
  wrapWebContent,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { OLLAMA_CLOUD_BASE_URL } from "./defaults.js";
import {
  buildOllamaWebSearchSsrFPolicy,
  fetchOllamaModels,
  resolveOllamaApiBase,
} from "./provider-models.js";
import { checkOllamaCloudAuth } from "./setup.js";

const OLLAMA_WEB_SEARCH_SCHEMA = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: 10,
      }),
    ),
  },
  { additionalProperties: false },
);

// Ollama's web_search capability is served by Ollama Cloud at
// https://ollama.com/api/web_search. The local Ollama daemon (0.16.0+) does
// not expose this endpoint; older bundled versions pointed at the local
// /api/experimental/web_search path, which now 404s. See issue #69132.
const OLLAMA_WEB_SEARCH_PATH = "/api/web_search";
const DEFAULT_OLLAMA_WEB_SEARCH_COUNT = 5;
const DEFAULT_OLLAMA_WEB_SEARCH_TIMEOUT_MS = 15_000;
const OLLAMA_WEB_SEARCH_SNIPPET_MAX_CHARS = 300;

type OllamaWebSearchResult = {
  title?: string;
  url?: string;
  content?: string;
};

type OllamaWebSearchResponse = {
  results?: OllamaWebSearchResult[];
};

function resolveOllamaWebSearchApiKey(config?: OpenClawConfig): string | undefined {
  const providerApiKey = normalizeOptionalSecretInput(config?.models?.providers?.ollama?.apiKey);
  if (providerApiKey && !isNonSecretApiKeyMarker(providerApiKey)) {
    return providerApiKey;
  }
  return resolveEnvApiKey("ollama")?.apiKey;
}

function resolveOllamaWebSearchBaseUrl(config?: OpenClawConfig): string {
  const pluginBaseUrl = normalizeOptionalString(
    resolveProviderWebSearchPluginConfig(config, "ollama")?.baseUrl,
  );
  if (pluginBaseUrl) {
    return resolveOllamaApiBase(pluginBaseUrl);
  }
  return OLLAMA_CLOUD_BASE_URL;
}

// Returns true only for the canonical Ollama Cloud endpoint. The Ollama API
// key is a cloud credential, so we refuse to attach it to any other host
// (including custom `plugins.entries.ollama.config.webSearch.baseUrl`
// overrides used for self-hosted proxies) to prevent credential exfiltration
// via a misconfigured or attacker-controlled base URL.
function isOllamaCloudHost(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" && url.hostname === "ollama.com";
  } catch {
    return false;
  }
}

function normalizeOllamaWebSearchResult(
  result: OllamaWebSearchResult,
): { title: string; url: string; content: string } | null {
  const url = normalizeOptionalString(result.url) ?? "";
  if (!url) {
    return null;
  }
  return {
    title: normalizeOptionalString(result.title) ?? "",
    url,
    content: normalizeOptionalString(result.content) ?? "",
  };
}

export async function runOllamaWebSearch(params: {
  config?: OpenClawConfig;
  query: string;
  count?: number;
}): Promise<Record<string, unknown>> {
  const query = params.query.trim();
  if (!query) {
    throw new Error("query parameter is required");
  }

  const baseUrl = resolveOllamaWebSearchBaseUrl(params.config);
  const apiKey = resolveOllamaWebSearchApiKey(params.config);
  // Fail fast when the provider is routed at Ollama Cloud without a usable
  // credential. Otherwise the request always 401s on the server and the user
  // sees the generic signin error only after a network round-trip.
  if (isOllamaCloudHost(baseUrl) && !apiKey) {
    throw new Error(
      "Ollama web search requires an Ollama Cloud credential. Run `ollama signin` or set OLLAMA_API_KEY.",
    );
  }
  const count = resolveSearchCount(params.count, DEFAULT_OLLAMA_WEB_SEARCH_COUNT);
  const startedAt = Date.now();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey && isOllamaCloudHost(baseUrl)) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const { response, release } = await fetchWithSsrFGuard({
    url: `${baseUrl}${OLLAMA_WEB_SEARCH_PATH}`,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify({ query, max_results: count }),
      signal: AbortSignal.timeout(DEFAULT_OLLAMA_WEB_SEARCH_TIMEOUT_MS),
    },
    policy: buildOllamaWebSearchSsrFPolicy(baseUrl),
    auditContext: "ollama-web-search.search",
  });

  try {
    if (response.status === 401) {
      throw new Error("Ollama web search authentication failed. Run `ollama signin`.");
    }
    if (response.status === 403) {
      throw new Error(
        "Ollama web search is unavailable. Ensure cloud-backed web search is enabled on the Ollama host.",
      );
    }
    if (!response.ok) {
      const detail = await readResponseText(response, { maxBytes: 64_000 });
      throw new Error(`Ollama web search failed (${response.status}): ${detail.text || ""}`.trim());
    }

    const payload = (await response.json()) as OllamaWebSearchResponse;
    const results = Array.isArray(payload.results)
      ? payload.results
          .map(normalizeOllamaWebSearchResult)
          .filter((result): result is NonNullable<typeof result> => result !== null)
          .slice(0, count)
      : [];

    return {
      query,
      provider: "ollama",
      count: results.length,
      tookMs: Date.now() - startedAt,
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: "ollama",
        wrapped: true,
      },
      results: results.map((result) => {
        const snippet = truncateText(result.content, OLLAMA_WEB_SEARCH_SNIPPET_MAX_CHARS).text;
        return {
          title: result.title ? wrapWebContent(result.title, "web_search") : "",
          url: result.url,
          snippet: snippet ? wrapWebContent(snippet, "web_search") : "",
          siteName: resolveSiteName(result.url) || undefined,
        };
      }),
    };
  } finally {
    await release();
  }
}

async function warnOllamaWebSearchPrereqs(params: {
  config: OpenClawConfig;
  prompter: {
    note: (message: string, title?: string) => Promise<void>;
  };
}): Promise<OpenClawConfig> {
  const baseUrl = resolveOllamaWebSearchBaseUrl(params.config);
  const apiKey = resolveOllamaWebSearchApiKey(params.config);
  // Use the host-aware cloud check so `https://ollama.com:443`, mixed-case
  // hostnames, trailing slashes, etc. all match the same notice/allowance
  // as the runtime path instead of falling through a strict string compare.
  const routesToCloud = isOllamaCloudHost(baseUrl);
  if (routesToCloud) {
    await params.prompter.note(
      [
        "Ollama Web Search sends your search queries to Ollama Cloud:",
        `${OLLAMA_CLOUD_BASE_URL}${OLLAMA_WEB_SEARCH_PATH}`,
        "Set plugins.entries.ollama.config.webSearch.baseUrl to route through a self-hosted proxy instead.",
      ].join("\n"),
      "Ollama Web Search (Cloud)",
    );
  } else {
    // Only probe daemon reachability for self-hosted/custom bases. Ollama
    // Cloud doesn't serve /api/tags, so skip that check when we're pointing
    // at it.
    const { reachable } = await fetchOllamaModels(baseUrl);
    if (!reachable) {
      await params.prompter.note(
        [
          "Ollama Web Search requires Ollama to be running.",
          `Expected host: ${baseUrl}`,
          "Start Ollama before using this provider.",
        ].join("\n"),
        "Ollama Web Search",
      );
      return params.config;
    }
  }

  // Pass the runtime credential into the preflight so a user with a valid
  // OLLAMA_API_KEY (but no local `ollama signin` artifact) isn't falsely
  // warned to sign in. Only attach on the cloud path; custom proxies never
  // see the Ollama API key.
  const auth = await checkOllamaCloudAuth(baseUrl, routesToCloud ? { apiKey } : undefined);
  if (!auth.signedIn) {
    await params.prompter.note(
      [
        "Ollama Web Search requires `ollama signin`.",
        ...(auth.signinUrl ? [auth.signinUrl] : ["Run `ollama signin`."]),
      ].join("\n"),
      "Ollama Web Search",
    );
  }

  return params.config;
}

export function createOllamaWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "ollama",
    label: "Ollama Web Search",
    hint: "Ollama Cloud · requires ollama signin",
    onboardingScopes: ["text-inference"],
    requiresCredential: false,
    envVars: [],
    placeholder: "(run ollama signin)",
    signupUrl: "https://ollama.com/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 110,
    credentialPath: "",
    getCredentialValue: () => undefined,
    setCredentialValue: () => {},
    applySelectionConfig: (config) => enablePluginInConfig(config, "ollama").config,
    runSetup: async (ctx) =>
      await warnOllamaWebSearchPrereqs({
        config: ctx.config,
        prompter: ctx.prompter,
      }),
    createTool: (ctx) => ({
      description:
        "Search the web using Ollama's Cloud web-search API. Returns titles, URLs, and snippets.",
      parameters: OLLAMA_WEB_SEARCH_SCHEMA,
      execute: async (args) =>
        await runOllamaWebSearch({
          config: ctx.config,
          query: readStringParam(args, "query", { required: true }),
          count: readNumberParam(args, "count", { integer: true }),
        }),
    }),
  };
}

export const __testing = {
  normalizeOllamaWebSearchResult,
  resolveOllamaWebSearchApiKey,
  resolveOllamaWebSearchBaseUrl,
  warnOllamaWebSearchPrereqs,
};
