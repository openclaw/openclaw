import type { Api } from "@mariozechner/pi-ai";
import type { ModelDefinitionConfig } from "../config/types.js";
import type {
  ProviderRequestCapabilities,
  ProviderRequestCapability,
  ProviderRequestTransport,
} from "./provider-attribution.js";
import {
  resolveProviderRequestCapabilities,
  resolveProviderRequestPolicy,
  type ProviderRequestPolicyResolution,
} from "./provider-attribution.js";

type RequestApi = Api | ModelDefinitionConfig["api"];

export type ResolvedProviderRequestAuthConfig = {
  mode: "provider-default" | "authorization-bearer";
  injectAuthorizationHeader: boolean;
};

export type ResolvedProviderRequestProxyConfig = {
  configured: false;
};

export type ResolvedProviderRequestTlsConfig = {
  configured: false;
};

export type ResolvedProviderRequestConfig = {
  api?: RequestApi;
  baseUrl?: string;
  headers?: Record<string, string>;
  auth: ResolvedProviderRequestAuthConfig;
  proxy: ResolvedProviderRequestProxyConfig;
  tls: ResolvedProviderRequestTlsConfig;
  policy: ProviderRequestPolicyResolution;
};

export type ProviderRequestHeaderPrecedence = "caller-wins" | "defaults-win";

export type ResolvedProviderRequestPolicyConfig = ResolvedProviderRequestConfig & {
  allowPrivateNetwork: boolean;
  capabilities: ProviderRequestCapabilities;
};

const FORBIDDEN_HEADER_KEYS = new Set(["__proto__", "prototype", "constructor"]);

type ResolveProviderRequestPolicyConfigParams = {
  provider?: string;
  api?: RequestApi;
  baseUrl?: string;
  defaultBaseUrl?: string;
  capability?: ProviderRequestCapability;
  transport?: ProviderRequestTransport;
  discoveredHeaders?: Record<string, string>;
  providerHeaders?: Record<string, string>;
  modelHeaders?: Record<string, string>;
  callerHeaders?: Record<string, string>;
  precedence?: ProviderRequestHeaderPrecedence;
  authHeader?: boolean;
  compat?: {
    supportsStore?: boolean;
  } | null;
  modelId?: string | null;
  allowPrivateNetwork?: boolean;
};

export function normalizeBaseUrl(baseUrl: string | undefined, fallback: string): string;
export function normalizeBaseUrl(
  baseUrl: string | undefined,
  fallback?: string,
): string | undefined;
export function normalizeBaseUrl(
  baseUrl: string | undefined,
  fallback?: string,
): string | undefined {
  const raw = baseUrl?.trim() || fallback?.trim();
  if (!raw) {
    return undefined;
  }
  return raw.replace(/\/+$/, "");
}

export function mergeProviderRequestHeaders(
  ...headerSets: Array<Record<string, string> | undefined>
): Record<string, string> | undefined {
  let merged: Record<string, string> | undefined;
  const headerNamesByLowerKey = new Map<string, string>();
  for (const headers of headerSets) {
    if (!headers) {
      continue;
    }
    if (!merged) {
      merged = Object.create(null) as Record<string, string>;
    }
    for (const [key, value] of Object.entries(headers)) {
      const normalizedKey = key.toLowerCase();
      if (FORBIDDEN_HEADER_KEYS.has(normalizedKey)) {
        continue;
      }
      const previousKey = headerNamesByLowerKey.get(normalizedKey);
      if (previousKey && previousKey !== key) {
        delete merged[previousKey];
      }
      merged[key] = value;
      headerNamesByLowerKey.set(normalizedKey, key);
    }
  }
  return merged && Object.keys(merged).length > 0 ? merged : undefined;
}

export function resolveProviderRequestPolicyConfig(
  params: ResolveProviderRequestPolicyConfigParams,
): ResolvedProviderRequestPolicyConfig {
  const baseUrl = normalizeBaseUrl(params.baseUrl, params.defaultBaseUrl);
  const capability = params.capability ?? "llm";
  const transport = params.transport ?? "http";
  const policyInput = {
    provider: params.provider,
    api: params.api,
    baseUrl,
    capability,
    transport,
  } satisfies Parameters<typeof resolveProviderRequestPolicy>[0];
  const policy = resolveProviderRequestPolicy(policyInput);
  const capabilities = resolveProviderRequestCapabilities({
    ...policyInput,
    compat: params.compat,
    modelId: params.modelId,
  });
  const defaultHeaders = mergeProviderRequestHeaders(
    params.discoveredHeaders,
    params.providerHeaders,
    params.modelHeaders,
  );
  const protectedAttributionKeys = new Set(
    Object.keys(policy.attributionHeaders ?? {}).map((key) => key.toLowerCase()),
  );
  const unprotectedCallerHeaders = params.callerHeaders
    ? Object.fromEntries(
        Object.entries(params.callerHeaders).filter(
          ([key]) => !protectedAttributionKeys.has(key.toLowerCase()),
        ),
      )
    : undefined;
  const mergedDefaults = mergeProviderRequestHeaders(defaultHeaders, policy.attributionHeaders);
  const headers =
    params.precedence === "caller-wins"
      ? mergeProviderRequestHeaders(mergedDefaults, unprotectedCallerHeaders)
      : mergeProviderRequestHeaders(unprotectedCallerHeaders, mergedDefaults);

  return {
    api: params.api,
    baseUrl,
    headers,
    auth: {
      mode: params.authHeader ? "authorization-bearer" : "provider-default",
      injectAuthorizationHeader: params.authHeader === true,
    },
    proxy: { configured: false },
    tls: { configured: false },
    policy,
    capabilities,
    allowPrivateNetwork: params.allowPrivateNetwork ?? Boolean(params.baseUrl?.trim()),
  };
}

export function resolveProviderRequestConfig(params: {
  provider: string;
  api?: RequestApi;
  baseUrl?: string;
  capability?: ProviderRequestCapability;
  transport?: ProviderRequestTransport;
  discoveredHeaders?: Record<string, string>;
  providerHeaders?: Record<string, string>;
  modelHeaders?: Record<string, string>;
  authHeader?: boolean;
}): ResolvedProviderRequestConfig {
  const resolved = resolveProviderRequestPolicyConfig(params);
  return {
    api: resolved.api,
    baseUrl: resolved.baseUrl,
    // Model resolution intentionally excludes attribution headers. Those are
    // applied later at transport/request time so native-host gating stays tied
    // to the final resolved route instead of the catalog/config merge step.
    headers: mergeProviderRequestHeaders(
      params.discoveredHeaders,
      params.providerHeaders,
      params.modelHeaders,
    ),
    auth: resolved.auth,
    proxy: resolved.proxy,
    tls: resolved.tls,
    policy: resolved.policy,
  };
}

export function resolveProviderRequestHeaders(params: {
  provider: string;
  api?: RequestApi;
  baseUrl?: string;
  capability?: ProviderRequestCapability;
  transport?: ProviderRequestTransport;
  callerHeaders?: Record<string, string>;
  defaultHeaders?: Record<string, string>;
  precedence?: ProviderRequestHeaderPrecedence;
}): Record<string, string> | undefined {
  return resolveProviderRequestPolicyConfig({
    provider: params.provider,
    api: params.api,
    baseUrl: params.baseUrl,
    capability: params.capability,
    transport: params.transport,
    callerHeaders: params.callerHeaders,
    providerHeaders: params.defaultHeaders,
    precedence: params.precedence,
  }).headers;
}
