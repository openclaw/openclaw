// Ollama provider module implements model/runtime integration.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  isNonSecretApiKeyMarker,
  normalizeOptionalSecretInput,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveEnvApiKey } from "openclaw/plugin-sdk/provider-auth-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import {
  enablePluginInConfig,
  readPositiveIntegerParam,
  readResponseText,
  readStringParam,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCount,
  resolveSiteName,
  truncateText,
  wrapWebContent,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search";
import { resolveSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import { OLLAMA_DEFAULT_BASE_URL } from "./defaults.js";
import { readProviderBaseUrl } from "./provider-base-url.js";
import {
  buildOllamaBaseUrlSsrFPolicy,
  fetchOllamaModels,
  resolveOllamaApiBase,
} from "./provider-models.js";
import { checkOllamaCloudAuth } from "./setup.js";

const OLLAMA_WEB_SEARCH_SCHEMA = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Integer({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: 10,
      }),
    ),
  },
  { additionalProperties: false },
);

const OLLAMA_HOSTED_WEB_SEARCH_PATH = "/api/web_search";
const OLLAMA_LOCAL_WEB_SEARCH_PROXY_PATH = "/api/experimental/web_search";
const OLLAMA_CLOUD_BASE_URL = "https://ollama.com";
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

type OllamaWebSearchAttempt = {
  baseUrl: string;
  path: string;
  apiKey?: string;
};

type ConfiguredOllamaWebSearchApiKeyResult =
  | { status: "available"; apiKey: string }
  | { status: "blocked"; message: string }
  | { status: "missing" };

async function readOllamaWebSearchResponse(response: Response): Promise<OllamaWebSearchResponse> {
  return await readProviderJsonResponse<OllamaWebSearchResponse>(response, "Ollama web search");
}

function isOllamaCloudBaseUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    return parsed.protocol === "https:" && parsed.hostname === "ollama.com";
  } catch {
    return false;
  }
}

function resolveConfiguredOllamaWebSearchApiKeyResult(
  config?: OpenClawConfig,
): ConfiguredOllamaWebSearchApiKeyResult {
  const resolved = resolveSecretInputString({
    value: config?.models?.providers?.ollama?.apiKey,
    defaults: config?.secrets?.defaults,
    path: "models.providers.ollama.apiKey",
    mode: "inspect",
  });
  if (resolved.status === "missing") {
    return { status: "missing" };
  }
  if (resolved.status === "configured_unavailable") {
    if (resolved.ref.source !== "env") {
      // This sync web-search path can only materialize env refs locally.
      // A configured non-env ref still owns the credential slot, so do not
      // replace it with ambient env auth from a different account.
      return {
        status: "blocked",
        message:
          "models.providers.ollama.apiKey SecretRef cannot be resolved by Ollama web search. Use an env SecretRef for this path.",
      };
    }
    const envApiKey = normalizeOptionalSecretInput(process.env[resolved.ref.id]);
    return envApiKey && !isNonSecretApiKeyMarker(envApiKey)
      ? { status: "available", apiKey: envApiKey }
      : {
          status: "blocked",
          message: `models.providers.ollama.apiKey env SecretRef ${resolved.ref.id} is not available for Ollama web search.`,
        };
  }

  const providerApiKey = normalizeOptionalSecretInput(resolved.value);
  return providerApiKey && !isNonSecretApiKeyMarker(providerApiKey)
    ? { status: "available", apiKey: providerApiKey }
    : { status: "missing" };
}

function resolveEnvOllamaWebSearchApiKey(): string | undefined {
  return resolveEnvApiKey("ollama")?.apiKey;
}

function resolveOllamaWebSearchApiKey(config?: OpenClawConfig): string | undefined {
  const configured = resolveConfiguredOllamaWebSearchApiKeyResult(config);
  if (configured.status === "available") {
    return configured.apiKey;
  }
  if (configured.status === "blocked") {
    throw new Error(configured.message);
  }
  return resolveEnvOllamaWebSearchApiKey();
}

function resolveOllamaWebSearchBaseUrl(config?: OpenClawConfig): string {
  const pluginBaseUrl = normalizeOptionalString(
    resolveProviderWebSearchPluginConfig(config, "ollama")?.baseUrl,
  );
  if (pluginBaseUrl) {
    return resolveOllamaApiBase(pluginBaseUrl);
  }
  const configuredBaseUrl = readProviderBaseUrl(config?.models?.providers?.ollama);
  if (configuredBaseUrl) {
    return resolveOllamaApiBase(configuredBaseUrl);
  }
  return OLLAMA_DEFAULT_BASE_URL;
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

function buildOllamaWebSearchAttempts(params: {
  baseUrl: string;
  configuredApiKey?: string;
  envApiKey?: string;
}): OllamaWebSearchAttempt[] {
  if (isOllamaCloudBaseUrl(params.baseUrl)) {
    return [
      {
        baseUrl: params.baseUrl,
        path: OLLAMA_HOSTED_WEB_SEARCH_PATH,
        apiKey: params.configuredApiKey ?? params.envApiKey,
      },
    ];
  }

  const attempts: OllamaWebSearchAttempt[] = [
    {
      baseUrl: params.baseUrl,
      path: OLLAMA_LOCAL_WEB_SEARCH_PROXY_PATH,
      apiKey: params.configuredApiKey,
    },
    {
      baseUrl: params.baseUrl,
      path: OLLAMA_HOSTED_WEB_SEARCH_PATH,
      apiKey: params.configuredApiKey,
    },
  ];
  if (params.envApiKey) {
    attempts.push({
      baseUrl: OLLAMA_CLOUD_BASE_URL,
      path: OLLAMA_HOSTED_WEB_SEARCH_PATH,
      apiKey: params.envApiKey,
    });
  }
  return attempts;
}

async function runOllamaWebSearch(params: {
  config?: OpenClawConfig;
  query: string;
  count?: number;
}): Promise<Record<string, unknown>> {
  const query = params.query.trim();
  if (!query) {
    throw new Error("query parameter is required");
  }

  const baseUrl = resolveOllamaWebSearchBaseUrl(params.config);
  const configuredApiKeyResult = resolveConfiguredOllamaWebSearchApiKeyResult(params.config);
  if (configuredApiKeyResult.status === "blocked") {
    throw new Error(configuredApiKeyResult.message);
  }
  const configuredAuth =
    configuredApiKeyResult.status === "available" ? configuredApiKeyResult.apiKey : undefined;
  const envAuth =
    configuredApiKeyResult.status === "missing" ? resolveEnvOllamaWebSearchApiKey() : undefined;
  const count = resolveSearchCount(params.count, DEFAULT_OLLAMA_WEB_SEARCH_COUNT);
  const startedAt = Date.now();
  const body = JSON.stringify({ query, max_results: count });
  const attempts = buildOllamaWebSearchAttempts({
    baseUrl,
    configuredApiKey: configuredAuth,
    envApiKey: envAuth,
  });

  let payload: OllamaWebSearchResponse | undefined;
  let lastError: Error | undefined;
  for (const attempt of attempts) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (attempt.apiKey) {
      headers.Authorization = `Bearer ${attempt.apiKey}`;
    }
    const { response, release } = await fetchWithSsrFGuard({
      url: `${attempt.baseUrl}${attempt.path}`,
      init: {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(DEFAULT_OLLAMA_WEB_SEARCH_TIMEOUT_MS),
      },
      policy: buildOllamaBaseUrlSsrFPolicy(attempt.baseUrl),
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
        const message =
          `Ollama web search failed (${response.status}): ${detail.text || ""}`.trim();
        if (response.status === 404) {
          lastError = new Error(message);
          continue;
        }
        throw new Error(message);
      }
      payload = await readOllamaWebSearchResponse(response);
      break;
    } catch (error) {
      if (error instanceof Error) {
        lastError = error;
      } else {
        lastError = new Error(String(error));
      }
      throw lastError;
    } finally {
      await release();
    }
  }

  if (!payload) {
    throw lastError ?? new Error("Ollama web search failed");
  }

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
}

async function warnOllamaWebSearchPrereqs(params: {
  config: OpenClawConfig;
  prompter: {
    note: (message: string, title?: string) => Promise<void>;
  };
}): Promise<OpenClawConfig> {
  const baseUrl = resolveOllamaWebSearchBaseUrl(params.config);
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

  const auth = await checkOllamaCloudAuth(baseUrl);
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
    hint: "Local Ollama host · requires ollama signin",
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
        "Search the web using Ollama's web search API. Returns titles, URLs, and snippets from the configured Ollama host.",
      parameters: OLLAMA_WEB_SEARCH_SCHEMA,
      execute: async (args) =>
        await runOllamaWebSearch({
          config: ctx.config,
          query: readStringParam(args, "query", { required: true }),
          count: readPositiveIntegerParam(args, "count", {
            max: 10,
            message: "count must be an integer from 1 to 10.",
          }),
        }),
    }),
  };
}

export const testing = {
  buildOllamaWebSearchAttempts,
  normalizeOllamaWebSearchResult,
  resolveEnvOllamaWebSearchApiKey,
  resolveOllamaWebSearchApiKey,
  resolveOllamaWebSearchBaseUrl,
  isOllamaCloudBaseUrl,
  readOllamaWebSearchResponse,
  warnOllamaWebSearchPrereqs,
};
export { testing as __testing };
