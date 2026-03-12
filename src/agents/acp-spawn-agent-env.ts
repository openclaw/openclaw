import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentEffectiveModelPrimary } from "./agent-scope.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import { PROVIDER_ENV_API_KEY_CANDIDATES } from "./model-auth-env-vars.js";
import { isNonSecretApiKeyMarker } from "./model-auth-markers.js";
import { getCustomProviderApiKey } from "./model-auth.js";
import {
  findNormalizedProviderValue,
  normalizeProviderIdForAuth,
  parseModelRef,
} from "./model-selection.js";

/**
 * Resolve per-agent env overrides for ACP child processes.
 *
 * Returns a map of env vars to inject (provider API key candidates) or
 * undefined when no agent-specific overrides are needed.
 */
export function resolveAcpSpawnAgentEnv(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Record<string, string> | undefined {
  const modelRef = resolveAgentEffectiveModelPrimary(params.cfg, params.agentId);
  if (!modelRef) {
    return undefined;
  }

  // parseModelRef handles both "provider/model" and bare model names (defaulting
  // to DEFAULT_PROVIDER), plus normalizes aliases via normalizeProviderId.
  const parsed = parseModelRef(modelRef, DEFAULT_PROVIDER);
  if (!parsed) {
    return undefined;
  }
  const provider = normalizeProviderIdForAuth(parsed.provider);

  const apiKey = getCustomProviderApiKey(params.cfg, provider);
  if (!apiKey || isNonSecretApiKeyMarker(apiKey)) {
    return undefined;
  }

  const candidates = PROVIDER_ENV_API_KEY_CANDIDATES[provider];
  if (!candidates || candidates.length === 0) {
    return undefined;
  }

  const env: Record<string, string> = {};
  for (const envVar of candidates) {
    env[envVar] = apiKey;
  }

  // Inject baseUrl if configured for the provider.
  const providerConfig = findNormalizedProviderValue(params.cfg.models?.providers, provider);
  const baseUrl =
    providerConfig && typeof providerConfig === "object" && "baseUrl" in providerConfig
      ? (providerConfig as { baseUrl?: string }).baseUrl?.trim()
      : undefined;
  if (baseUrl) {
    // Use OPENAI_BASE_URL as the conventional env var for base URL overrides;
    // most OpenAI-compatible runtimes (including acpx backends) honor it.
    env.OPENAI_BASE_URL = baseUrl;
  }

  return env;
}
