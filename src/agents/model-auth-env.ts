import { getEnvApiKey } from "@mariozechner/pi-ai";
import { getShellEnvAppliedKeys } from "../infra/shell-env.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import { hasAnthropicVertexAvailableAuth } from "./anthropic-vertex-provider.js";
import { PROVIDER_ENV_API_KEY_CANDIDATES } from "./model-auth-env-vars.js";
import { GCP_VERTEX_CREDENTIALS_MARKER } from "./model-auth-markers.js";
import { normalizeProviderIdForAuth } from "./provider-id.js";

export type EnvApiKeyResult = {
  apiKey: string;
  source: string;
};

export function resolveEnvApiKey(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): EnvApiKeyResult | null {
  const normalized = normalizeProviderIdForAuth(provider);
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

  if (normalized === "anthropic-vertex") {
    if (hasAnthropicVertexAvailableAuth(env)) {
      return { apiKey: GCP_VERTEX_CREDENTIALS_MARKER, source: "gcloud adc" };
    }
    return null;
  }

  return null;
}
