/**
 * Live-test provider API-key discovery.
 * Reads provider-specific and manifest-declared env names without logging or
 * exposing secret values, with explicit single-key pins for flaky live lanes.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeStringEntries,
  normalizeUniqueTrimmedStringList,
} from "@openclaw/normalization-core/string-normalization";
import { getProviderEnvVarsCore } from "../secrets/provider-env-vars.js";
import { classifyFailoverSignal } from "./failover/classify.js";

const KEY_SPLIT_RE = /[\s,;]+/g;

const PROVIDER_PREFIX_OVERRIDES: Record<string, string> = {
  google: "GEMINI",
  "google-vertex": "GEMINI",
};

type ProviderApiKeyConfig = {
  liveSingle: string;
  listVar: string;
  primaryVar: string;
  prefixedVar: string;
  fallbackVars: string[];
};

type CollectProviderApiKeysOptions = {
  env?: NodeJS.ProcessEnv;
  providerEnvVars?: readonly string[];
};

function parseKeyList(raw?: string | null): string[] {
  if (!raw) {
    return [];
  }
  return normalizeStringEntries(raw.split(KEY_SPLIT_RE));
}

function collectEnvPrefixedKeys(prefix: string, env: NodeJS.ProcessEnv): string[] {
  const keys: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const trimmed = normalizeOptionalString(value);
    if (!trimmed) {
      continue;
    }
    keys.push(trimmed);
  }
  return keys;
}

function resolveProviderApiKeyConfig(provider: string): ProviderApiKeyConfig {
  const normalized = normalizeProviderId(provider);
  const base = PROVIDER_PREFIX_OVERRIDES[normalized] ?? normalized.toUpperCase().replace(/-/g, "_");
  return {
    liveSingle: `OPENCLAW_LIVE_${base}_KEY`,
    listVar: normalized === "anthropic" ? "OPENCLAW_LIVE_ANTHROPIC_KEYS" : `${base}_API_KEYS`,
    primaryVar: `${base}_API_KEY`,
    prefixedVar: `${base}_API_KEY_`,
    fallbackVars:
      normalized === "google" || normalized === "google-vertex" ? ["GOOGLE_API_KEY"] : [],
  };
}

/** Collect configured API keys for live provider tests without exposing values. */
export function collectProviderApiKeys(
  provider: string,
  options: CollectProviderApiKeysOptions = {},
): string[] {
  const env = options.env ?? process.env;
  const normalizedProvider = normalizeProviderId(provider);
  const config = resolveProviderApiKeyConfig(normalizedProvider);

  const forcedSingle = normalizeOptionalString(env[config.liveSingle]);
  if (forcedSingle) {
    // OPENCLAW_LIVE_*_KEY pins a single key so retries do not rotate fixtures.
    return [forcedSingle];
  }

  const fromList = parseKeyList(env[config.listVar]);
  const primary = env[config.primaryVar];
  const fromPrefixed = collectEnvPrefixedKeys(config.prefixedVar, env);
  const fallback = config.fallbackVars.map((envVar) => env[envVar]);
  const manifestEnvVars = options.providerEnvVars ?? getProviderEnvVarsCore(normalizedProvider);
  return normalizeUniqueTrimmedStringList([
    ...fromList,
    primary,
    ...fromPrefixed,
    ...fallback,
    ...manifestEnvVars.map((envVar) => env[envVar]),
  ]);
}

/** Return whether a provider error message indicates API-key rate limiting. */
export function isApiKeyRateLimitError(message: string): boolean {
  const classification = classifyFailoverSignal({ message });
  return classification?.kind === "reason" && classification.reason === "rate_limit";
}
