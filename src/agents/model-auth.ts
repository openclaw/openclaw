import path from "node:path";
import { type Api, getEnvApiKey, type Model } from "@mariozechner/pi-ai";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import { getShellEnvAppliedKeys } from "../infra/shell-env.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  normalizeOptionalSecretInput,
  normalizeSecretInput,
} from "../utils/normalize-secret-input.js";
import {
  type AuthProfileStore,
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
  resolveAuthStorePathForDisplay,
} from "./auth-profiles.js";
import { PROVIDER_ENV_API_KEY_CANDIDATES } from "./model-auth-env-vars.js";
import {
  CUSTOM_LOCAL_AUTH_MARKER,
  isKnownEnvApiKeyMarker,
  isNonSecretApiKeyMarker,
  OLLAMA_LOCAL_AUTH_MARKER,
} from "./model-auth-markers.js";
import { normalizeProviderId } from "./model-selection.js";

export { ensureAuthProfileStore, resolveAuthProfileOrder } from "./auth-profiles.js";

const log = createSubsystemLogger("model-auth");

function resolveProviderConfig(
  cfg: OpenClawConfig | undefined,
  provider: string,
): ModelProviderConfig | undefined {
  const providers = cfg?.models?.providers ?? {};
  const direct = providers[provider] as ModelProviderConfig | undefined;
  if (direct) {
    return direct;
  }
  const normalized = normalizeProviderId(provider);
  if (normalized === provider) {
    const matched = Object.entries(providers).find(
      ([key]) => normalizeProviderId(key) === normalized,
    );
    return matched?.[1];
  }
  return (
    (providers[normalized] as ModelProviderConfig | undefined) ??
    Object.entries(providers).find(([key]) => normalizeProviderId(key) === normalized)?.[1]
  );
}

export function getCustomProviderApiKey(
  cfg: OpenClawConfig | undefined,
  provider: string,
): string | undefined {
  const entry = resolveProviderConfig(cfg, provider);
  return normalizeOptionalSecretInput(entry?.apiKey);
}

type ResolvedCustomProviderApiKey = {
  apiKey: string;
  source: string;
};

export function resolveUsableCustomProviderApiKey(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  env?: NodeJS.ProcessEnv;
}): ResolvedCustomProviderApiKey | null {
  const customKey = getCustomProviderApiKey(params.cfg, params.provider);
  if (!customKey) {
    return null;
  }
  if (!isNonSecretApiKeyMarker(customKey)) {
    return { apiKey: customKey, source: "models.json" };
  }
  if (!isKnownEnvApiKeyMarker(customKey)) {
    return null;
  }
  const envValue = normalizeOptionalSecretInput((params.env ?? process.env)[customKey]);
  if (!envValue) {
    return null;
  }
  const applied = new Set(getShellEnvAppliedKeys());
  return {
    apiKey: envValue,
    source: resolveEnvSourceLabel({
      applied,
      envVars: [customKey],
      label: `${customKey} (models.json marker)`,
    }),
  };
}

export function hasUsableCustomProviderApiKey(
  cfg: OpenClawConfig | undefined,
  provider: string,
  env?: NodeJS.ProcessEnv,
): boolean {
  return Boolean(resolveUsableCustomProviderApiKey({ cfg, provider, env }));
}

function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "[::1]" ||
      host === "[::ffff:7f00:1]" ||
      host === "[::ffff:127.0.0.1]"
    );
  } catch {
    return false;
  }
}

function hasExplicitProviderApiKeyConfig(providerConfig: ModelProviderConfig): boolean {
  return (
    normalizeOptionalSecretInput(providerConfig.apiKey) !== undefined ||
    coerceSecretRef(providerConfig.apiKey) !== null
  );
}

function isCustomLocalProviderConfig(providerConfig: ModelProviderConfig): boolean {
  return (
    typeof providerConfig.baseUrl === "string" &&
    providerConfig.baseUrl.trim().length > 0 &&
    typeof providerConfig.api === "string" &&
    providerConfig.api.trim().length > 0 &&
    Array.isArray(providerConfig.models) &&
    providerConfig.models.length > 0
  );
}

function resolveSyntheticLocalProviderAuth(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
}): ResolvedProviderAuth | null {
  const providerConfig = resolveProviderConfig(params.cfg, params.provider);
  if (!providerConfig) {
    return null;
  }

  const hasApiConfig =
    Boolean(providerConfig.api?.trim()) ||
    Boolean(providerConfig.baseUrl?.trim()) ||
    (Array.isArray(providerConfig.models) && providerConfig.models.length > 0);
  if (!hasApiConfig) {
    return null;
  }

  const normalizedProvider = normalizeProviderId(params.provider);
  if (normalizedProvider === "ollama") {
    return {
      apiKey: OLLAMA_LOCAL_AUTH_MARKER,
      source: "models.providers.ollama (synthetic local key)",
      mode: "api-key",
    };
  }

  if (!isCustomLocalProviderConfig(providerConfig)) {
    return null;
  }
  if (hasExplicitProviderApiKeyConfig(providerConfig)) {
    return null;
  }

  // Custom providers pointing at a local server (e.g. llama.cpp, vLLM, LocalAI)
  // typically don't require auth. Synthesize a local key so the auth resolver
  // doesn't reject them when the user left the API key blank during onboarding.
  if (providerConfig.baseUrl && isLocalBaseUrl(providerConfig.baseUrl)) {
    return {
      apiKey: CUSTOM_LOCAL_AUTH_MARKER,
      source: `models.providers.${params.provider} (synthetic local key)`,
      mode: "api-key",
    };
  }

  return null;
}

function resolveEnvSourceLabel(params: {
  applied: Set<string>;
  envVars: string[];
  label: string;
}): string {
  const shellApplied = params.envVars.some((envVar) => params.applied.has(envVar));
  const prefix = shellApplied ? "shell env: " : "env: ";
  return `${prefix}${params.label}`;
}

export type ResolvedProviderAuth = {
  apiKey?: string;
  profileId?: string;
  source: string;
  mode: "api-key" | "oauth" | "token";
};

export async function resolveApiKeyForProvider(params: {
  provider: string;
  cfg?: OpenClawConfig;
  profileId?: string;
  preferredProfile?: string;
  store?: AuthProfileStore;
  agentDir?: string;
}): Promise<ResolvedProviderAuth> {
  const { provider, cfg, profileId, preferredProfile } = params;
  const store = params.store ?? ensureAuthProfileStore(params.agentDir);

  if (profileId) {
    const resolved = await resolveApiKeyForProfile({
      cfg,
      store,
      profileId,
      agentDir: params.agentDir,
    });
    if (!resolved) {
      throw new Error(`No credentials found for profile "${profileId}".`);
    }
    const mode = store.profiles[profileId]?.type;
    return {
      apiKey: resolved.apiKey,
      profileId,
      source: `profile:${profileId}`,
      mode: mode === "oauth" ? "oauth" : mode === "token" ? "token" : "api-key",
    };
  }

  const order = resolveAuthProfileOrder({
    cfg,
    store,
    provider,
    preferredProfile,
  });
  for (const candidate of order) {
    try {
      const resolved = await resolveApiKeyForProfile({
        cfg,
        store,
        profileId: candidate,
        agentDir: params.agentDir,
      });
      if (resolved) {
        const mode = store.profiles[candidate]?.type;
        return {
          apiKey: resolved.apiKey,
          profileId: candidate,
          source: `profile:${candidate}`,
          mode: mode === "oauth" ? "oauth" : mode === "token" ? "token" : "api-key",
        };
      }
    } catch (err) {
      log.debug?.(`auth profile "${candidate}" failed for provider "${provider}": ${String(err)}`);
    }
  }

  const envResolved = resolveEnvApiKey(provider);
  if (envResolved) {
    return {
      apiKey: envResolved.apiKey,
      source: envResolved.source,
      mode: envResolved.source.includes("OAUTH_TOKEN") ? "oauth" : "api-key",
    };
  }

  const customKey = resolveUsableCustomProviderApiKey({ cfg, provider });
  if (customKey) {
    return { apiKey: customKey.apiKey, source: customKey.source, mode: "api-key" };
  }

  const syntheticLocalAuth = resolveSyntheticLocalProviderAuth({ cfg, provider });
  if (syntheticLocalAuth) {
    return syntheticLocalAuth;
  }

  const normalized = normalizeProviderId(provider);

  if (provider === "openai") {
    const hasCodex = listProfilesForProvider(store, "openai-codex").length > 0;
    if (hasCodex) {
      throw new Error(
        'No API key found for provider "openai". You are authenticated with OpenAI Codex OAuth. Use openai-codex/gpt-5.4 (OAuth) or set OPENAI_API_KEY to use openai/gpt-5.4.',
      );
    }
  }

  const authStorePath = resolveAuthStorePathForDisplay(params.agentDir);
  const resolvedAgentDir = path.dirname(authStorePath);
  throw new Error(
    [
      `No API key found for provider "${provider}".`,
      `Auth store: ${authStorePath} (agentDir: ${resolvedAgentDir}).`,
      `Configure auth for this agent (${formatCliCommand("openclaw agents add <id>")}) or copy auth-profiles.json from the main agentDir.`,
    ].join(" "),
  );
}

export type EnvApiKeyResult = { apiKey: string; source: string };
export type ModelAuthMode = "api-key" | "oauth" | "token" | "mixed" | "unknown";

export function resolveEnvApiKey(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): EnvApiKeyResult | null {
  const normalized = normalizeProviderId(provider);
  const applied = new Set(getShellEnvAppliedKeys());
  const pick = (envVar: string): EnvApiKeyResult | null => {
    const value = normalizeOptionalSecretInput(env[envVar]);
    if (!value) {
      return null;
    }
    const source = applied.has(envVar) ? `shell env: ${envVar}` : `env: ${envVar}`;
    return { apiKey: value, source };
  };

  const candidates = PROVIDER_ENV_API_KEY_CANDIDATES[normalized];
  if (candidates) {
    for (const envVar of candidates) {
      const resolved = pick(envVar);
      if (resolved) {
        return resolved;
      }
    }
  }

  if (normalized === "google-vertex") {
    const envKey = getEnvApiKey(normalized);
    if (!envKey) {
      return null;
    }
    return { apiKey: envKey, source: "gcloud adc" };
  }
  return null;
}

export function resolveModelAuthMode(
  provider?: string,
  cfg?: OpenClawConfig,
  store?: AuthProfileStore,
): ModelAuthMode | undefined {
  const resolved = provider?.trim();
  if (!resolved) {
    return undefined;
  }

  const authStore = store ?? ensureAuthProfileStore();
  const profiles = listProfilesForProvider(authStore, resolved);
  if (profiles.length > 0) {
    const modes = new Set(
      profiles
        .map((id) => authStore.profiles[id]?.type)
        .filter((mode): mode is "api_key" | "oauth" | "token" => Boolean(mode)),
    );
    const distinct = ["oauth", "token", "api_key"].filter((k) =>
      modes.has(k as "oauth" | "token" | "api_key"),
    );
    if (distinct.length >= 2) {
      return "mixed";
    }
    if (modes.has("oauth")) {
      return "oauth";
    }
    if (modes.has("token")) {
      return "token";
    }
    if (modes.has("api_key")) {
      return "api-key";
    }
  }

  const envKey = resolveEnvApiKey(resolved);
  if (envKey?.apiKey) {
    return envKey.source.includes("OAUTH_TOKEN") ? "oauth" : "api-key";
  }

  if (hasUsableCustomProviderApiKey(cfg, resolved)) {
    return "api-key";
  }

  return "unknown";
}

export async function getApiKeyForModel(params: {
  model: Model<Api>;
  cfg?: OpenClawConfig;
  profileId?: string;
  preferredProfile?: string;
  store?: AuthProfileStore;
  agentDir?: string;
}): Promise<ResolvedProviderAuth> {
  return resolveApiKeyForProvider({
    provider: params.model.provider,
    cfg: params.cfg,
    profileId: params.profileId,
    preferredProfile: params.preferredProfile,
    store: params.store,
    agentDir: params.agentDir,
  });
}

export function requireApiKey(auth: ResolvedProviderAuth, provider: string): string {
  const key = normalizeSecretInput(auth.apiKey);
  if (key) {
    return key;
  }
  throw new Error(`No API key resolved for provider "${provider}" (auth mode: ${auth.mode}).`);
}

export function applyLocalNoAuthHeaderOverride<T extends Model<Api>>(
  model: T,
  auth: ResolvedProviderAuth | null | undefined,
): T {
  if (auth?.apiKey !== CUSTOM_LOCAL_AUTH_MARKER || model.api !== "openai-completions") {
    return model;
  }

  // OpenAI's SDK always generates Authorization from apiKey. Keep the non-secret
  // placeholder so construction succeeds, then clear the header at request build
  // time for local servers that intentionally do not require auth.
  const headers = {
    ...model.headers,
    Authorization: null,
  } as unknown as Record<string, string>;

  return {
    ...model,
    headers,
  };
}
