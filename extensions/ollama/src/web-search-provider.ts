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
import { OLLAMA_CLOUD_BASE_URL, OLLAMA_DEFAULT_BASE_URL } from "./defaults.js";
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
      Type.Number({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: 10,
      }),
    ),
  },
  { additionalProperties: false },
);

const OLLAMA_WEB_SEARCH_PATH = "/api/web_search";
const OLLAMA_EXPERIMENTAL_WEB_SEARCH_PATH = "/api/experimental/web_search";
const OLLAMA_LOCAL_WEB_SEARCH_PATHS = [
  OLLAMA_WEB_SEARCH_PATH,
  OLLAMA_EXPERIMENTAL_WEB_SEARCH_PATH,
] as const;
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

type OllamaWebSearchTarget = {
  kind: "local" | "cloud";
  baseUrl: string;
  path: string;
  url: string;
};

type OllamaWebSearchApiKeyResolution = {
  apiKey: string | undefined;
  source: "provider-config" | "env" | "none";
};

function resolveOllamaWebSearchAuth(config?: OpenClawConfig): OllamaWebSearchApiKeyResolution {
  const providerApiKey = normalizeOptionalSecretInput(config?.models?.providers?.ollama?.apiKey);
  if (providerApiKey && !isNonSecretApiKeyMarker(providerApiKey)) {
    return { apiKey: providerApiKey, source: "provider-config" };
  }
  const envKey = resolveEnvApiKey("ollama")?.apiKey;
  if (envKey) {
    return { apiKey: envKey, source: "env" };
  }
  return { apiKey: undefined, source: "none" };
}

function resolveOllamaWebSearchApiKey(config?: OpenClawConfig): string | undefined {
  return resolveOllamaWebSearchAuth(config).apiKey;
}

function hasUsableOllamaCloudWebSearchApiKey(apiKey: string | undefined): apiKey is string {
  return typeof apiKey === "string" && apiKey.trim().length > 0 && !isNonSecretApiKeyMarker(apiKey);
}

function resolveOllamaWebSearchBaseUrl(config?: OpenClawConfig): string {
  const pluginBaseUrl = normalizeOptionalString(
    resolveProviderWebSearchPluginConfig(config, "ollama")?.baseUrl,
  );
  if (pluginBaseUrl) {
    return resolveOllamaApiBase(pluginBaseUrl);
  }
  const configuredBaseUrl = config?.models?.providers?.ollama?.baseUrl;
  if (normalizeOptionalString(configuredBaseUrl)) {
    return resolveOllamaApiBase(configuredBaseUrl);
  }
  return OLLAMA_DEFAULT_BASE_URL;
}

function createOllamaWebSearchTarget(params: {
  kind: "local" | "cloud";
  baseUrl: string;
  path: string;
}): OllamaWebSearchTarget {
  return {
    kind: params.kind,
    baseUrl: params.baseUrl,
    path: params.path,
    url: `${params.baseUrl}${params.path}`,
  };
}

function canUseOllamaCloudFallback(auth: OllamaWebSearchApiKeyResolution): boolean {
  // Only an env-sourced OLLAMA_API_KEY triggers the Ollama Cloud fallback.
  // Provider-config apiKey is scoped to the configured host and must not
  // leak to ollama.com just because the user set a bearer for their local
  // or self-hosted Ollama.
  return auth.source === "env" && hasUsableOllamaCloudWebSearchApiKey(auth.apiKey);
}

function resolveOllamaWebSearchTargets(params: {
  config?: OpenClawConfig;
  auth: OllamaWebSearchApiKeyResolution;
}): OllamaWebSearchTarget[] {
  const baseUrl = resolveOllamaWebSearchBaseUrl(params.config);
  if (baseUrl === OLLAMA_CLOUD_BASE_URL) {
    return [
      createOllamaWebSearchTarget({
        kind: "cloud",
        baseUrl,
        path: OLLAMA_WEB_SEARCH_PATH,
      }),
    ];
  }

  const targets = OLLAMA_LOCAL_WEB_SEARCH_PATHS.map((path) =>
    createOllamaWebSearchTarget({
      kind: "local",
      baseUrl,
      path,
    }),
  );
  if (canUseOllamaCloudFallback(params.auth)) {
    targets.push(
      createOllamaWebSearchTarget({
        kind: "cloud",
        baseUrl: OLLAMA_CLOUD_BASE_URL,
        path: OLLAMA_WEB_SEARCH_PATH,
      }),
    );
  }
  return targets;
}

function buildOllamaWebSearchHeaders(params: {
  target: OllamaWebSearchTarget;
  auth: OllamaWebSearchApiKeyResolution;
}): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const { apiKey, source } = params.auth;
  if (!apiKey) {
    return headers;
  }
  if (params.target.kind === "cloud") {
    if (hasUsableOllamaCloudWebSearchApiKey(apiKey)) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    return headers;
  }
  // Local target: only attach the key when it was explicitly configured for
  // this Ollama provider. Env-sourced OLLAMA_API_KEY is the Ollama Cloud
  // convention and must not leak to local or self-hosted Ollama hosts during
  // the local-first fallback attempts.
  if (source === "provider-config") {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function buildOllamaWebSearchUnavailableError(params: {
  baseUrl: string;
  detail?: string;
  triedCloudFallback: boolean;
  canUseCloudFallback: boolean;
}): Error {
  const detail = params.detail?.trim() || "404 page not found";
  const lead = `The configured Ollama host (${params.baseUrl}) did not expose ${OLLAMA_WEB_SEARCH_PATH} or ${OLLAMA_EXPERIMENTAL_WEB_SEARCH_PATH}.`;
  const tail = params.triedCloudFallback
    ? "The Ollama Cloud retry also returned 404 — verify OLLAMA_API_KEY and your Ollama Cloud web search access."
    : params.canUseCloudFallback
      ? "OpenClaw can retry Ollama Cloud automatically when a real OLLAMA_API_KEY is available."
      : "Set OLLAMA_API_KEY for hosted Ollama web search, or use a host that exposes Ollama web search.";
  return new Error(`Ollama web search failed (404): ${detail}. ${lead} ${tail}`.trim());
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
  const auth = resolveOllamaWebSearchAuth(params.config);
  const targets = resolveOllamaWebSearchTargets({
    config: params.config,
    auth,
  });
  const count = resolveSearchCount(params.count, DEFAULT_OLLAMA_WEB_SEARCH_COUNT);
  const startedAt = Date.now();
  const canUseCloudFallback = canUseOllamaCloudFallback(auth);
  let lastLocal404Detail: string | undefined;

  for (const [index, target] of targets.entries()) {
    const { response, release } = await fetchWithSsrFGuard({
      url: target.url,
      init: {
        method: "POST",
        headers: buildOllamaWebSearchHeaders({ target, auth }),
        body: JSON.stringify({ query, max_results: count }),
        signal: AbortSignal.timeout(DEFAULT_OLLAMA_WEB_SEARCH_TIMEOUT_MS),
      },
      policy: buildOllamaBaseUrlSsrFPolicy(target.baseUrl),
      auditContext: "ollama-web-search.search",
    });

    try {
      if (response.status === 404) {
        const detail = await readResponseText(response, { maxBytes: 64_000 });
        if (target.kind === "local") {
          lastLocal404Detail = detail.text || lastLocal404Detail;
          if (index < targets.length - 1) {
            continue;
          }
        }
        throw buildOllamaWebSearchUnavailableError({
          baseUrl,
          detail: target.kind === "cloud" ? detail.text : lastLocal404Detail,
          triedCloudFallback: target.kind === "cloud",
          canUseCloudFallback,
        });
      }
      if (response.status === 401) {
        throw new Error(
          target.kind === "cloud"
            ? "Ollama web search authentication failed. Set `OLLAMA_API_KEY`."
            : "Ollama web search authentication failed. Run `ollama signin`.",
        );
      }
      if (response.status === 403) {
        throw new Error(
          target.kind === "cloud"
            ? "Ollama web search is unavailable for this Ollama Cloud account."
            : "Ollama web search is unavailable. Ensure cloud-backed web search is enabled on the Ollama host.",
        );
      }
      if (!response.ok) {
        const detail = await readResponseText(response, { maxBytes: 64_000 });
        throw new Error(
          `Ollama web search failed (${response.status}): ${detail.text || ""}`.trim(),
        );
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

  throw buildOllamaWebSearchUnavailableError({
    baseUrl,
    detail: lastLocal404Detail,
    triedCloudFallback: false,
    canUseCloudFallback,
  });
}

async function warnOllamaWebSearchPrereqs(params: {
  config: OpenClawConfig;
  prompter: {
    note: (message: string, title?: string) => Promise<void>;
  };
}): Promise<OpenClawConfig> {
  const baseUrl = resolveOllamaWebSearchBaseUrl(params.config);
  const apiKey = resolveOllamaWebSearchApiKey(params.config);
  if (baseUrl === OLLAMA_CLOUD_BASE_URL) {
    if (!hasUsableOllamaCloudWebSearchApiKey(apiKey)) {
      await params.prompter.note(
        [
          "Ollama Web Search against ollama.com requires `OLLAMA_API_KEY`.",
          "Set `models.providers.ollama.apiKey` or export `OLLAMA_API_KEY`.",
        ].join("\n"),
        "Ollama Web Search",
      );
    }
    return params.config;
  }

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
    hint: "Configured Ollama host · hosted fallback supported",
    onboardingScopes: ["text-inference"],
    requiresCredential: false,
    envVars: ["OLLAMA_API_KEY"],
    placeholder: "(optional: OLLAMA_API_KEY)",
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
        "Search the web with Ollama. Prefers the configured Ollama host and can fall back to Ollama Cloud when a real OLLAMA_API_KEY is available.",
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
  buildOllamaWebSearchHeaders,
  hasUsableOllamaCloudWebSearchApiKey,
  normalizeOllamaWebSearchResult,
  resolveOllamaWebSearchApiKey,
  resolveOllamaWebSearchAuth,
  resolveOllamaWebSearchBaseUrl,
  resolveOllamaWebSearchTargets,
  warnOllamaWebSearchPrereqs,
};
