/**
 * Live-test provider API-key discovery.
 * Reads provider-specific and manifest-declared env names without logging or
 * exposing secret values, with explicit single-key pins for flaky live lanes.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { getProviderEnvVarsCore } from "../secrets/provider-env-vars.js";
import { classifyFailoverSignal } from "./failover/classify.js";

const KEY_SPLIT_RE = /[\s,;]+/g;

const PROVIDER_PREFIX_OVERRIDES: Record<string, string> = {
  google: "GEMINI",
  "google-vertex": "GEMINI",
};

type CollectProviderApiKeysOptions = {
  env?: NodeJS.ProcessEnv;
  providerEnvVars?: readonly string[];
};

/** Collect configured API keys for live provider tests without exposing values. */
export function collectProviderApiKeys(
  provider: string,
  options: CollectProviderApiKeysOptions = {},
): string[] {
  const env = options.env ?? process.env;
  const normalized = normalizeProviderId(provider);
  const base = PROVIDER_PREFIX_OVERRIDES[normalized] ?? normalized.toUpperCase().replace(/-/g, "_");

  const forcedSingle = normalizeOptionalString(env[`OPENCLAW_LIVE_${base}_KEY`]);
  if (forcedSingle) {
    // OPENCLAW_LIVE_*_KEY pins a single key so retries do not rotate fixtures.
    return [forcedSingle];
  }

  const listVar = normalized === "anthropic" ? "OPENCLAW_LIVE_ANTHROPIC_KEYS" : `${base}_API_KEYS`;
  const manifestEnvVars = options.providerEnvVars ?? getProviderEnvVarsCore(normalized);
  return normalizeUniqueTrimmedStringList([
    ...(env[listVar]?.split(KEY_SPLIT_RE) ?? []),
    env[`${base}_API_KEY`],
    ...Object.entries(env)
      .filter(([name]) => name.startsWith(`${base}_API_KEY_`))
      .map(([, value]) => value),
    ...(normalized === "google" || normalized === "google-vertex" ? [env.GOOGLE_API_KEY] : []),
    ...manifestEnvVars.map((envVar) => env[envVar]),
  ]);
}

/** Return whether a provider error message indicates API-key rate limiting. */
export function isApiKeyRateLimitError(message: string): boolean {
  const classification = classifyFailoverSignal({ message });
  return classification?.kind === "reason" && classification.reason === "rate_limit";
}
