import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderAuthEvidence } from "../secrets/provider-env-vars.js";
import { resolveProviderEnvAuthEvidence } from "./model-auth-env-vars.js";
import { resolveEnvApiKey, type EnvApiKeyResult } from "./model-auth-env.js";
import { resolveProviderAuthAliasMap } from "./provider-auth-aliases.js";
import { normalizeProviderIdForAuth } from "./provider-id.js";

const GCE_METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const DEFAULT_METADATA_TIMEOUT_MS = 1_000;

type LiveEnvApiKeyLookupOptions = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  aliasMap?: Readonly<Record<string, string>>;
  candidateMap?: Readonly<Record<string, readonly string[]>>;
  authEvidenceMap?: Readonly<Record<string, readonly ProviderAuthEvidence[]>>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hasRequiredAuthEvidenceEnv(
  evidence: ProviderAuthEvidence,
  env: NodeJS.ProcessEnv,
): boolean {
  const hasEnv = (key: string) => Boolean(normalizeOptionalString(env[key]));
  if (evidence.requiresAnyEnv?.length && !evidence.requiresAnyEnv.some(hasEnv)) {
    return false;
  }
  if (evidence.requiresAllEnv?.length && !evidence.requiresAllEnv.every(hasEnv)) {
    return false;
  }
  return true;
}

async function fetchGceMetadataAccessToken(params: {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<string | undefined> {
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1, params.timeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS),
  );
  try {
    const response = await fetchImpl(GCE_METADATA_TOKEN_URL, {
      headers: { "Metadata-Flavor": "Google" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return undefined;
    }
    const payload = (await response.json().catch(() => undefined)) as
      | { access_token?: unknown }
      | undefined;
    return normalizeOptionalString(payload?.access_token);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveLiveAuthEvidence(params: {
  evidence: readonly ProviderAuthEvidence[] | undefined;
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<EnvApiKeyResult | null> {
  for (const entry of params.evidence ?? []) {
    if (entry.type !== "gce-metadata-token") {
      continue;
    }
    if (!hasRequiredAuthEvidenceEnv(entry, params.env)) {
      continue;
    }
    const token = await fetchGceMetadataAccessToken({
      fetchImpl: params.fetchImpl,
      timeoutMs: params.timeoutMs,
    });
    if (!token) {
      continue;
    }
    return {
      apiKey: entry.credentialMarker,
      source: entry.source ?? "GCE metadata service account",
    };
  }
  return null;
}

export async function resolveLiveEnvApiKey(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
  options: LiveEnvApiKeyLookupOptions = {},
): Promise<EnvApiKeyResult | null> {
  const envResolved = resolveEnvApiKey(provider, env, options);
  if (envResolved) {
    return envResolved;
  }
  const lookupParams = {
    config: options.config,
    workspaceDir: options.workspaceDir,
    env,
  };
  const aliasMap = options.aliasMap ?? resolveProviderAuthAliasMap(lookupParams);
  const normalizedProvider = normalizeProviderIdForAuth(provider);
  const normalized = aliasMap[normalizedProvider] ?? normalizedProvider;
  const authEvidenceMap = options.authEvidenceMap ?? resolveProviderEnvAuthEvidence(lookupParams);
  const evidence = Object.hasOwn(authEvidenceMap, normalized)
    ? authEvidenceMap[normalized]
    : undefined;
  return await resolveLiveAuthEvidence({
    evidence,
    env,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
}
