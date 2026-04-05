import { getEnvApiKey } from "@mariozechner/pi-ai";
import { getShellEnvAppliedKeys } from "../infra/shell-env.js";
import { resolvePluginSetupProvider } from "../plugins/setup-registry.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import { resolveProviderEnvApiKeyCandidates } from "./model-auth-env-vars.js";
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

  const candidates = resolveProviderEnvApiKeyCandidates()[normalized];
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

  const setupProvider = resolvePluginSetupProvider({
    provider: normalized,
    env,
  });
  if (setupProvider?.resolveConfigApiKey) {
    const resolved = setupProvider.resolveConfigApiKey({
      provider: normalized,
      env,
    });
    if (resolved?.trim()) {
      return {
        apiKey: resolved,
        source: resolved === GCP_VERTEX_CREDENTIALS_MARKER ? "gcloud adc" : "env",
      };
    }
  }

  return null;
}
