import type { OpenClawConfig } from "../config/config.js";
import type { ModelProviderConfig, ModelProviderEndpointConfig } from "../config/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("providers/endpoints");

const DEFAULT_HEALTH_TIMEOUT_MS = 1500;
const DEFAULT_HEALTH_TTL_MS = 10_000;
const DEFAULT_SUCCESS_STATUSES = new Set([200]);

type HealthCacheEntry = { ok: boolean; checkedAt: number };
const healthCache = new Map<string, HealthCacheEntry>();

function cacheKey(providerId: string, endpoint: ModelProviderEndpointConfig): string {
  const id = endpoint.id?.trim() || endpoint.baseUrl.trim();
  return `${providerId}:${id}`;
}

function resolveSuccessStatuses(endpoint: ModelProviderEndpointConfig): Set<number> {
  const statuses = endpoint.health?.successStatus;
  if (Array.isArray(statuses) && statuses.length > 0) {
    return new Set(statuses.map((value) => Math.trunc(value)));
  }
  return DEFAULT_SUCCESS_STATUSES;
}

async function checkHealth(
  providerId: string,
  endpoint: ModelProviderEndpointConfig,
): Promise<boolean> {
  if (!endpoint.health) {
    return true;
  }
  const now = Date.now();
  const ttl = endpoint.health.cacheTtlMs ?? DEFAULT_HEALTH_TTL_MS;
  const key = cacheKey(providerId, endpoint);
  const cached = healthCache.get(key);
  if (cached && now - cached.checkedAt < ttl) {
    return cached.ok;
  }

  const url = endpoint.health.url?.trim() || endpoint.baseUrl.trim();
  if (!url) {
    return true;
  }
  const method = endpoint.health.method ?? "GET";
  const timeoutMs = endpoint.health.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const successStatuses = resolveSuccessStatuses(endpoint);

  let ok = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      body: method === "POST" ? (endpoint.health.body ?? "") : undefined,
      signal: controller.signal,
    });
    ok = successStatuses.has(res.status);
  } catch (err) {
    ok = false;
    log.debug(`provider endpoint health check failed for ${providerId}: ${String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  healthCache.set(key, { ok, checkedAt: now });
  return ok;
}

function sortEndpoints(endpoints: ModelProviderEndpointConfig[]): ModelProviderEndpointConfig[] {
  return [...endpoints].toSorted((a, b) => {
    const aPriority = a.priority ?? 0;
    const bPriority = b.priority ?? 0;
    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }
    return a.baseUrl.localeCompare(b.baseUrl);
  });
}

function applyEndpoint(
  provider: ModelProviderConfig,
  endpoint: ModelProviderEndpointConfig,
): ModelProviderConfig {
  const headers = endpoint.headers
    ? { ...provider.headers, ...endpoint.headers }
    : provider.headers;
  return {
    ...provider,
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey ?? provider.apiKey,
    auth: endpoint.auth ?? provider.auth,
    headers,
    authHeader:
      typeof endpoint.authHeader === "boolean" ? endpoint.authHeader : provider.authHeader,
  };
}

export async function resolveProviderEndpoint(params: {
  providerId: string;
  provider: ModelProviderConfig;
}): Promise<{ provider: ModelProviderConfig; endpoint?: ModelProviderEndpointConfig }> {
  const { providerId, provider } = params;
  const endpoints = provider.endpoints?.filter((entry) => entry.baseUrl?.trim());
  if (!endpoints || endpoints.length === 0) {
    return { provider };
  }
  const strategy = provider.endpointStrategy ?? "health";
  const ordered = sortEndpoints(endpoints);

  if (strategy === "ordered") {
    const endpoint = ordered[0];
    if (!endpoint) {
      return { provider };
    }
    return { provider: applyEndpoint(provider, endpoint), endpoint };
  }

  for (const endpoint of ordered) {
    if (await checkHealth(providerId, endpoint)) {
      return { provider: applyEndpoint(provider, endpoint), endpoint };
    }
  }

  log.warn(
    `provider endpoint health checks failed for ${providerId}, falling back to base provider`,
  );
  return { provider };
}

export async function resolveProviderEndpointConfig(params: {
  cfg: OpenClawConfig;
  providerId: string;
}): Promise<{ cfg: OpenClawConfig; endpoint?: ModelProviderEndpointConfig }> {
  const providers = params.cfg.models?.providers;
  if (!providers) {
    return { cfg: params.cfg };
  }
  const provider = providers[params.providerId];
  if (!provider) {
    return { cfg: params.cfg };
  }
  const resolved = await resolveProviderEndpoint({
    providerId: params.providerId,
    provider,
  });
  if (resolved.provider === provider) {
    return { cfg: params.cfg, endpoint: resolved.endpoint };
  }
  return {
    cfg: {
      ...params.cfg,
      models: {
        ...params.cfg.models,
        providers: {
          ...providers,
          [params.providerId]: resolved.provider,
        },
      },
    },
    endpoint: resolved.endpoint,
  };
}
