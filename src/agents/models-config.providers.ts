import type { OpenClawConfig } from "../config/config.js";
import { coerceSecretRef, resolveSecretInputRef } from "../config/types.secrets.js";
import { isRecord } from "../utils.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import { resolveOllamaApiBase } from "./models-config.providers.discovery.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
export type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];
type SecretDefaults = {
  env?: string;
  file?: string;
  exec?: string;
};

const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

function resolveSecretDefaults(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): SecretDefaults | undefined {
  const secrets = cfg.secrets;
  if (!secrets?.defaults) {
    return undefined;
  }
  const defaults = secrets.defaults;
  const out: SecretDefaults = {};
  if (defaults.env && ENV_VAR_NAME_RE.test(defaults.env)) {
    out.env = defaults.env;
  }
  if (defaults.file && env[defaults.file]) {
    out.file = defaults.file;
  }
  if (defaults.exec && env[defaults.exec]) {
    out.exec = defaults.exec;
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeApiKeyConfig(value: string): string {
  const trimmed = value.trim();
  const match = /^\$\{([A-Z0-9_]+)\}$/.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function normalizeHeaderValues(params: {
  headers: ProviderConfig["headers"] | undefined;
  secretDefaults: SecretDefaults | undefined;
}): { headers: ProviderConfig["headers"] | undefined; mutated: boolean } {
  const { headers } = params;
  if (!headers) {
    return { headers, mutated: false };
  }
  let mutated = false;
  const nextHeaders: Record<string, NonNullable<ProviderConfig["headers"]>[string]> = {};
  for (const [headerName, headerValue] of Object.entries(headers)) {
    const resolvedRef = resolveSecretInputRef({
      value: headerValue,
      defaults: params.secretDefaults,
    }).ref;
    if (!resolvedRef || !resolvedRef.id.trim()) {
      nextHeaders[headerName] = headerValue;
      continue;
    }
    mutated = true;
    nextHeaders[headerName] = resolvedRef.source === "env"
      ? `\${env:${resolvedRef.id}}`
      : `\${${resolvedRef.source}}`;
  }
  if (!mutated) {
    return { headers, mutated: false };
  }
  return { headers: nextHeaders, mutated: true };
}

function normalizeSourceProviderLookup(
  providers: ModelsConfig["providers"] | undefined,
): Record<string, ProviderConfig> {
  if (!providers) {
    return {};
  }
  const out: Record<string, ProviderConfig> = {};
  for (const [key, provider] of Object.entries(providers)) {
    const normalizedKey = key.trim();
    if (!normalizedKey || !isRecord(provider)) {
      continue;
    }
    out[normalizedKey] = provider;
  }
  return out;
}

export function normalizeProviderConfig(params: {
  provider: string;
  providerConfig: ProviderConfig;
  secretDefaults?: SecretDefaults;
  env?: NodeJS.ProcessEnv;
}): ProviderConfig {
  const secretDefaults = params.secretDefaults;
  const env = params.env ?? process.env;
  let provider = { ...params.providerConfig };
  let mutated = false;

  if (provider.apiKey !== undefined) {
    const resolved = normalizeOptionalSecretInput({
      value: provider.apiKey,
      defaults: secretDefaults,
      normalize: normalizeApiKeyConfig,
    });
    if (resolved !== provider.apiKey) {
      provider.apiKey = resolved;
      mutated = true;
    }
  }

  const headerResult = normalizeHeaderValues({ headers: provider.headers, secretDefaults });
  if (headerResult.mutated) {
    provider.headers = headerResult.headers;
    mutated = true;
  }

  if (provider.api === undefined) {
    provider.api = "openai-completions";
    mutated = true;
  }

  return mutated ? provider : provider;
}

export function normalizeModelsConfig(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): OpenClawConfig {
  const models = cfg.models;
  if (!models) {
    return cfg;
  }

  const secretDefaults = resolveSecretDefaults(cfg, env);
  const providers = normalizeSourceProviderLookup(models.providers);
  let mutated = false;
  const nextProviders: Record<string, ProviderConfig> = {};

  for (const [providerId, providerConfig] of Object.entries(providers)) {
    const normalized = normalizeProviderConfig({
      provider: providerId,
      providerConfig,
      secretDefaults,
      env,
    });
    nextProviders[providerId] = normalized;
    if (normalized !== providerConfig) {
      mutated = true;
    }
  }

  if (!mutated) {
    return cfg;
  }

  return {
    ...cfg,
    models: {
      ...models,
      providers: nextProviders,
    },
  };
}

export { resolveOllamaApiBase };

// Re-export provider builders for backward compatibility
export {
  buildKilocodeProvider,
  buildKimiCodingProvider,
  buildQianfanProvider,
  buildXiaomiProvider,
  QIANFAN_BASE_URL,
  QIANFAN_DEFAULT_MODEL_ID,
  XIAOMI_DEFAULT_MODEL_ID,
  normalizeGoogleModelId,
} from "./models-config.providers.discovery.js";
