import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { OLLAMA_DEFAULT_BASE_URL } from "./defaults.js";
import { resolveOllamaApiBase } from "./provider-models.js";

export const OLLAMA_PROVIDER_ID = "ollama";
export const OLLAMA_DEFAULT_API_KEY = "ollama-local";

export type OllamaPluginConfig = {
  discovery?: {
    enabled?: boolean;
  };
};

type OllamaDiscoveryContext = {
  config: {
    models?: {
      providers?: {
        ollama?: ModelProviderConfig;
      };
      ollamaDiscovery?: {
        enabled?: boolean;
      };
    };
  };
  env: NodeJS.ProcessEnv;
  resolveProviderApiKey: (providerId: string) => { apiKey?: unknown };
};

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeOptionalString(value);
  }
  if (value && typeof value === "object" && "value" in value) {
    return normalizeOptionalString((value as { value?: unknown }).value);
  }
  return undefined;
}

export function resolveOllamaDiscoveryApiKey(params: {
  env: NodeJS.ProcessEnv;
  explicitApiKey?: string;
  resolvedApiKey?: unknown;
}): string {
  const envApiKey = params.env.OLLAMA_API_KEY?.trim() ? "OLLAMA_API_KEY" : undefined;
  const resolvedApiKey = normalizeOptionalString(params.resolvedApiKey);
  return envApiKey ?? params.explicitApiKey ?? resolvedApiKey ?? OLLAMA_DEFAULT_API_KEY;
}

function shouldSkipAmbientOllamaDiscovery(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.VITEST) || env.NODE_ENV === "test";
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "::"]);

function isIpv4LanRange(host: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return false;
  }
  const [a, b] = host.split(".").map(Number);
  if (a === 10) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  return false;
}

function isIpv6LocalRange(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "::1") {
    return true;
  }
  if (lower.startsWith("fe80:")) {
    return true;
  }
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) {
    return true;
  }
  return false;
}

export function isLocalOllamaBaseUrl(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) {
    return true;
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  let host = url.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (LOCAL_HOSTNAMES.has(host)) {
    return true;
  }
  if (host.endsWith(".local")) {
    return true;
  }
  if (isIpv4LanRange(host)) {
    return true;
  }
  if (isIpv6LocalRange(host)) {
    return true;
  }
  if (!host.includes(".") && !host.includes(":")) {
    return true;
  }
  return false;
}

export function hasMeaningfulExplicitOllamaConfig(
  providerConfig: ModelProviderConfig | undefined,
): boolean {
  if (!providerConfig) {
    return false;
  }
  if (Array.isArray(providerConfig.models) && providerConfig.models.length > 0) {
    return true;
  }
  if (typeof providerConfig.baseUrl === "string" && providerConfig.baseUrl.trim()) {
    return resolveOllamaApiBase(providerConfig.baseUrl) !== OLLAMA_DEFAULT_BASE_URL;
  }
  if (readStringValue(providerConfig.apiKey)) {
    return true;
  }
  if (providerConfig.auth) {
    return true;
  }
  if (typeof providerConfig.authHeader === "boolean") {
    return true;
  }
  if (
    providerConfig.headers &&
    typeof providerConfig.headers === "object" &&
    Object.keys(providerConfig.headers).length > 0
  ) {
    return true;
  }
  if (providerConfig.request) {
    return true;
  }
  if (typeof providerConfig.injectNumCtxForOpenAICompat === "boolean") {
    return true;
  }
  return false;
}

export async function resolveOllamaDiscoveryResult(params: {
  ctx: OllamaDiscoveryContext;
  pluginConfig: OllamaPluginConfig;
  buildProvider: (
    configuredBaseUrl?: string,
    opts?: { quiet?: boolean },
  ) => Promise<ModelProviderConfig>;
}): Promise<{ provider: ModelProviderConfig } | null> {
  const explicit = params.ctx.config.models?.providers?.ollama;
  const hasExplicitModels = Array.isArray(explicit?.models) && explicit.models.length > 0;
  const hasMeaningfulExplicitConfig = hasMeaningfulExplicitOllamaConfig(explicit);
  const discoveryEnabled =
    params.pluginConfig.discovery?.enabled ?? params.ctx.config.models?.ollamaDiscovery?.enabled;
  if (!hasExplicitModels && discoveryEnabled === false) {
    return null;
  }
  const ollamaKey = params.ctx.resolveProviderApiKey(OLLAMA_PROVIDER_ID).apiKey;
  const hasRealOllamaKey =
    typeof ollamaKey === "string" &&
    ollamaKey.trim().length > 0 &&
    ollamaKey.trim() !== OLLAMA_DEFAULT_API_KEY;
  const explicitApiKey = readStringValue(explicit?.apiKey);
  if (hasExplicitModels && explicit) {
    return {
      provider: {
        ...explicit,
        baseUrl:
          typeof explicit.baseUrl === "string" && explicit.baseUrl.trim()
            ? resolveOllamaApiBase(explicit.baseUrl)
            : OLLAMA_DEFAULT_BASE_URL,
        api: explicit.api ?? "ollama",
        apiKey: resolveOllamaDiscoveryApiKey({
          env: params.ctx.env,
          explicitApiKey,
          resolvedApiKey: ollamaKey,
        }),
      },
    };
  }
  if (
    !hasRealOllamaKey &&
    !hasMeaningfulExplicitConfig &&
    shouldSkipAmbientOllamaDiscovery(params.ctx.env)
  ) {
    return null;
  }

  const provider = await params.buildProvider(explicit?.baseUrl, {
    quiet: !hasRealOllamaKey && !hasMeaningfulExplicitConfig,
  });
  if (provider.models?.length === 0 && !ollamaKey && !explicit?.apiKey) {
    return null;
  }
  return {
    provider: {
      ...provider,
      apiKey: resolveOllamaDiscoveryApiKey({
        env: params.ctx.env,
        explicitApiKey,
        resolvedApiKey: ollamaKey,
      }),
    },
  };
}
