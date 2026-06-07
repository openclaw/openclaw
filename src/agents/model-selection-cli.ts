/**
 * Detects providers whose model selections are backed by CLI runtimes.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimeCliBackends } from "../plugins/cli-backends.runtime.js";
import { resolvePluginSetupCliBackendDescriptor } from "../plugins/setup-registry.runtime.js";
import {
  type AuthProfileCredential,
  loadAuthProfileStoreWithoutExternalProfiles,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";
import { isStoredCredentialCompatibleWithAuthProvider } from "./auth-profiles/order.js";
import { normalizeProviderId } from "./model-selection-normalize.js";

/** Compact integration label shown in picker descriptions and similar surfaces. */
export type ModelIntegrationLabel = "CLI" | "OAuth" | "API";

/** Return true when a provider id resolves to a configured or plugin CLI backend. */
export function isCliProvider(provider: string, cfg?: OpenClawConfig): boolean {
  const normalized = normalizeProviderId(provider);
  const backends = cfg?.agents?.defaults?.cliBackends ?? {};
  if (Object.keys(backends).some((key) => normalizeProviderId(key) === normalized)) {
    return true;
  }
  const cliBackends = resolveRuntimeCliBackends();
  if (cliBackends.some((backend) => normalizeProviderId(backend.id) === normalized)) {
    return true;
  }
  if (resolvePluginSetupCliBackendDescriptor({ backend: normalized, config: cfg })) {
    return true;
  }
  return false;
}

/**
 * Resolve the user-facing integration label for a model entry. Returns "CLI"
 * when the model is pinned to a CLI backend via `agentRuntime.id` in user
 * config, otherwise undefined. Intended for picker/status display only —
 * never used as a routing key.
 */
export function resolveModelRuntimeLabel(
  provider: string,
  modelId: string,
  cfg?: OpenClawConfig,
): string | undefined {
  const modelKey = `${provider}/${modelId}`;
  const runtimeId = cfg?.agents?.defaults?.models?.[modelKey]?.agentRuntime?.id;
  if (runtimeId && isCliProvider(runtimeId, cfg)) {
    return "CLI";
  }
  return undefined;
}

/**
 * Maps a stored auth-profile credential type to the compact integration label
 * shown in the picker. OAuth credentials win over api-key/token credentials —
 * users typically prefer the subscription path when both are configured.
 */
export function classifyAuthCredentialIntegration(
  type: AuthProfileCredential["type"] | undefined,
): "OAuth" | "API" | undefined {
  if (type === "oauth") {
    return "OAuth";
  }
  if (type === "api_key" || type === "token") {
    return "API";
  }
  return undefined;
}

/**
 * Pick the most-preferred matching profile for a provider and classify it as
 * OAuth or API. Reads from the agent's auth-profile store (external CLI
 * profiles excluded to keep listModels paths read-only). Returns undefined
 * when no compatible profile is registered.
 */
export function resolveProviderAuthIntegrationLabel(params: {
  provider: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
}): "OAuth" | "API" | undefined {
  if (!params.agentDir) {
    return undefined;
  }
  const store = loadAuthProfileStoreWithoutExternalProfiles(params.agentDir);
  const order = resolveAuthProfileOrder({
    cfg: params.cfg,
    store,
    provider: params.provider,
  });
  for (const profileId of order) {
    const credential = store.profiles[profileId];
    if (!credential) {
      continue;
    }
    if (
      !isStoredCredentialCompatibleWithAuthProvider({
        cfg: params.cfg,
        provider: params.provider,
        credential,
      })
    ) {
      continue;
    }
    return classifyAuthCredentialIntegration(credential.type);
  }
  return undefined;
}

/**
 * Resolve the user-facing integration label for a model entry. Prefers the
 * CLI-pinned signal; otherwise falls back to the auth-profile category for the
 * canonical provider. Display-only — never used as a routing key.
 */
export function resolveModelIntegrationLabel(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
}): ModelIntegrationLabel | undefined {
  if (resolveModelRuntimeLabel(params.provider, params.modelId, params.cfg) === "CLI") {
    return "CLI";
  }
  return resolveProviderAuthIntegrationLabel({
    provider: params.provider,
    cfg: params.cfg,
    agentDir: params.agentDir,
  });
}
