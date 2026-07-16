import "./embedding-batch.js";
import "./openai-chatgpt-oauth-flow.runtime.js";
import "./openai-chatgpt-oauth.runtime.js";
import "./openai-chatgpt-provider.runtime.js";
import "./openai-provider.js";
import "./tts.js";
import "./usage.js";
import type { ProviderBatchOutputLine } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import type { LiveModelCatalogFetchGuard } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import type { ProviderUsageSnapshot } from "openclaw/plugin-sdk/provider-usage";
import type {
  OAuthCredentials,
  OAuthProviderInterface,
} from "./openai-chatgpt-oauth-types.runtime.js";

function requireTestApi(symbolName: string): unknown {
  const api = Reflect.get(globalThis, Symbol.for(symbolName));
  if (!api) {
    throw new Error(`OpenAI test API is unavailable: ${symbolName}`);
  }
  return api;
}

export const { parseOpenAiBatchOutput } = requireTestApi(
  "openclaw.openaiEmbeddingBatchTestApi",
) as {
  parseOpenAiBatchOutput: (text: string) => ProviderBatchOutputLine[];
};

type TokenResult =
  | { type: "success"; access: string; refresh: string; expires: number }
  | { type: "failed"; message: string; status?: number };

export const { openaiCodexOAuthProvider, testing: openAiOAuthFlowTesting } = requireTestApi(
  "openclaw.openaiOAuthFlowTestApi",
) as {
  openaiCodexOAuthProvider: OAuthProviderInterface;
  testing: {
    callbackHost: string;
    createAuthorizationFlow: (
      originator?: string,
    ) => Promise<{ verifier: string; redirectUri: string; state: string; url: string }>;
    exchangeAuthorizationCode: (
      code: string,
      verifier: string,
      redirectUri?: string,
      options?: { signal?: AbortSignal; timeoutMs?: number },
    ) => Promise<TokenResult>;
    refreshAccessToken: (
      refreshToken: string,
      options?: { signal?: AbortSignal; timeoutMs?: number },
    ) => Promise<TokenResult>;
    resolveCallbackHost: (env?: NodeJS.ProcessEnv) => string;
    resolveRedirectUri: (host?: string) => string;
  };
};

export const { runOpenAIOAuthTlsPreflight } = requireTestApi(
  "openclaw.openaiOAuthRuntimeTestApi",
) as {
  runOpenAIOAuthTlsPreflight: (options?: {
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  }) => Promise<
    { ok: true } | { ok: false; kind: "tls-cert" | "network"; code?: string; message: string }
  >;
};

type OpenAICodexProviderRuntime = {
  getOAuthApiKey: (
    providerId: string,
    credentials: Record<string, OAuthCredentials>,
  ) => Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null>;
  refreshOpenAICodexToken: (refreshToken: string) => Promise<OAuthCredentials>;
};

export const { createOpenAICodexProviderRuntime } = requireTestApi(
  "openclaw.openaiProviderRuntimeTestApi",
) as {
  createOpenAICodexProviderRuntime: (deps: {
    ensureGlobalUndiciEnvProxyDispatcher: () => void;
    getOAuthApiKey: OpenAICodexProviderRuntime["getOAuthApiKey"];
    refreshOpenAICodexToken: OpenAICodexProviderRuntime["refreshOpenAICodexToken"];
  }) => OpenAICodexProviderRuntime;
};

export const { buildOpenAICodexLiveProviderConfig, buildOpenAILiveProviderConfig } = requireTestApi(
  "openclaw.openaiProviderTestApi",
) as {
  buildOpenAICodexLiveProviderConfig: (params: {
    discoveryApiKey: string;
    accountId?: string;
    fetchGuard?: LiveModelCatalogFetchGuard;
    signal?: AbortSignal;
  }) => Promise<ModelProviderConfig>;
  buildOpenAILiveProviderConfig: (params: {
    apiKey: string;
    baseUrl?: string;
    discoveryApiKey?: string;
    env?: Record<string, string | undefined>;
    fetchGuard?: LiveModelCatalogFetchGuard;
    signal?: AbortSignal;
  }) => Promise<ModelProviderConfig>;
};

export const { resolveOpenAITtsInstructions } = requireTestApi("openclaw.openaiTtsTestApi") as {
  resolveOpenAITtsInstructions: (
    model: string,
    instructions?: string,
    baseUrl?: string,
  ) => string | undefined;
};

export const { fetchOpenAIAdminUsage } = requireTestApi("openclaw.openaiUsageTestApi") as {
  fetchOpenAIAdminUsage: (params: {
    apiKey: string;
    projectId?: string;
    timeoutMs: number;
    fetchFn: typeof fetch;
    now?: number;
    periodDays?: number;
  }) => Promise<ProviderUsageSnapshot>;
};
