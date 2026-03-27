import {
  getOAuthApiKey as getOAuthApiKeyFromPi,
  refreshOpenAICodexToken as refreshOpenAICodexTokenFromPi,
} from "@mariozechner/pi-ai/oauth";
import { ensureGlobalUndiciEnvProxyDispatcher as ensureGlobalUndiciEnvProxyDispatcherFromRuntime } from "openclaw/plugin-sdk/infra-runtime";

type OpenAICodexOAuthCredentialLike = {
  access: string;
  refresh: string;
  expires: number;
};

type OpenAICodexProviderRuntimeOverrides = {
  getOAuthApiKey?: typeof getOAuthApiKeyFromPi;
  refreshOpenAICodexToken?: typeof refreshOpenAICodexTokenFromPi;
  ensureGlobalUndiciEnvProxyDispatcher?: typeof ensureGlobalUndiciEnvProxyDispatcherFromRuntime;
};

type OpenAICodexProviderRuntimeState = {
  overrides: OpenAICodexProviderRuntimeOverrides | null;
};

const OPENAI_CODEX_PROVIDER_RUNTIME_STATE_KEY = Symbol.for(
  "openclaw.openaiCodexProviderRuntimeState",
);

function resolveOpenAICodexProviderRuntimeState(): OpenAICodexProviderRuntimeState {
  const sharedGlobal = globalThis as typeof globalThis & Record<PropertyKey, unknown>;
  const existing = sharedGlobal[OPENAI_CODEX_PROVIDER_RUNTIME_STATE_KEY];
  if (existing && typeof existing === "object") {
    return existing as OpenAICodexProviderRuntimeState;
  }
  const created: OpenAICodexProviderRuntimeState = {
    overrides: null,
  };
  sharedGlobal[OPENAI_CODEX_PROVIDER_RUNTIME_STATE_KEY] = created;
  return created;
}

function resolveOpenAICodexProviderRuntimeDeps() {
  const overrides = resolveOpenAICodexProviderRuntimeState().overrides;
  return {
    getOAuthApiKey: overrides?.getOAuthApiKey ?? getOAuthApiKeyFromPi,
    refreshOpenAICodexToken:
      overrides?.refreshOpenAICodexToken ?? refreshOpenAICodexTokenFromPi,
    ensureGlobalUndiciEnvProxyDispatcher:
      overrides?.ensureGlobalUndiciEnvProxyDispatcher ??
      ensureGlobalUndiciEnvProxyDispatcherFromRuntime,
  };
}

export async function getOAuthApiKey(
  ...args: Parameters<typeof getOAuthApiKeyFromPi>
): Promise<Awaited<ReturnType<typeof getOAuthApiKeyFromPi>>> {
  const deps = resolveOpenAICodexProviderRuntimeDeps();
  deps.ensureGlobalUndiciEnvProxyDispatcher();
  return await deps.getOAuthApiKey(...args);
}

export async function refreshOpenAICodexOAuthCredential(
  credential: OpenAICodexOAuthCredentialLike,
): Promise<Awaited<ReturnType<typeof refreshOpenAICodexTokenFromPi>> | OpenAICodexOAuthCredentialLike> {
  const deps = resolveOpenAICodexProviderRuntimeDeps();
  deps.ensureGlobalUndiciEnvProxyDispatcher();
  if (Date.now() < credential.expires) {
    return credential;
  }
  return await deps.refreshOpenAICodexToken(credential.refresh);
}

export const __testing = {
  setDepsForTests(overrides?: OpenAICodexProviderRuntimeOverrides) {
    resolveOpenAICodexProviderRuntimeState().overrides = overrides ? { ...overrides } : null;
  },
  resetDepsForTests() {
    resolveOpenAICodexProviderRuntimeState().overrides = null;
  },
};
