import type { Api } from "@mariozechner/pi-ai";
import type { ModelDefinitionConfig } from "../config/types.js";
import type { PinnedDispatcherPolicy } from "../infra/net/ssrf.js";
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

export type ProviderRequestAuthOverride =
  | {
      mode: "provider-default";
    }
  | {
      mode: "authorization-bearer";
      token: string;
    }
  | {
      mode: "header";
      headerName: string;
      value: string;
      prefix?: string;
    };

export type ProviderRequestTlsOverride = {
  ca?: string;
  cert?: string;
  key?: string;
  passphrase?: string;
  serverName?: string;
  insecureSkipVerify?: boolean;
};

export type ProviderRequestProxyOverride =
  | {
      mode: "env-proxy";
      tls?: ProviderRequestTlsOverride;
    }
  | {
      mode: "explicit-proxy";
      url: string;
      tls?: ProviderRequestTlsOverride;
    };

export type ProviderRequestTransportOverrides = {
  headers?: Record<string, string>;
  auth?: ProviderRequestAuthOverride;
  proxy?: ProviderRequestProxyOverride;
  tls?: ProviderRequestTlsOverride;
};

export type ResolvedProviderRequestAuthConfig =
  | {
      configured: false;
      mode: "provider-default" | "authorization-bearer";
      injectAuthorizationHeader: boolean;
    }
  | {
      configured: true;
      mode: "authorization-bearer";
      headerName: "Authorization";
      value: string;
      injectAuthorizationHeader: true;
    }
  | {
      configured: true;
      mode: "header";
      headerName: string;
      value: string;
      prefix?: string;
      injectAuthorizationHeader: false;
    };

export type ResolvedProviderRequestProxyConfig =
  | {
      configured: false;
    }
  | {
      configured: true;
      mode: "env-proxy";
      tls: ResolvedProviderRequestTlsConfig;
    }
  | {
      configured: true;
      mode: "explicit-proxy";
      proxyUrl: string;
      tls: ResolvedProviderRequestTlsConfig;
    };

export type ResolvedProviderRequestTlsConfig =
  | {
      configured: false;
    }
  | {
      configured: true;
      ca?: string;
      cert?: string;
      key?: string;
      passphrase?: string;
      serverName?: string;
      rejectUnauthorized?: boolean;
    };

export type ResolvedProviderRequestExtraHeadersConfig = {
  configured: boolean;
  headers?: Record<string, string>;
};

export type ResolvedProviderRequestConfig = {
  api?: RequestApi;
  baseUrl?: string;
  headers?: Record<string, string>;
  extraHeaders: ResolvedProviderRequestExtraHeadersConfig;
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
const FORBIDDEN_INSECURE_TLS_MESSAGE =
  "Provider transport overrides do not allow insecureSkipVerify";
const FORBIDDEN_RUNTIME_TRANSPORT_OVERRIDE_MESSAGE =
  "Runtime auth request overrides do not allow proxy or TLS transport settings";

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
  request?: ProviderRequestTransportOverrides;
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

function resolveTlsOverride(
  tls: ProviderRequestTlsOverride | undefined,
): ResolvedProviderRequestTlsConfig {
  if (!tls) {
    return { configured: false };
  }
  if (tls.insecureSkipVerify === true) {
    throw new Error(FORBIDDEN_INSECURE_TLS_MESSAGE);
  }
  const ca = tls.ca?.trim();
  const cert = tls.cert?.trim();
  const key = tls.key?.trim();
  const passphrase = tls.passphrase?.trim();
  const serverName = tls.serverName?.trim();
  const rejectUnauthorized = tls.insecureSkipVerify === false ? true : undefined;
  if (!ca && !cert && !key && !passphrase && !serverName && rejectUnauthorized === undefined) {
    return { configured: false };
  }
  return {
    configured: true,
    ...(ca ? { ca } : {}),
    ...(cert ? { cert } : {}),
    ...(key ? { key } : {}),
    ...(passphrase ? { passphrase } : {}),
    ...(serverName ? { serverName } : {}),
    ...(rejectUnauthorized !== undefined ? { rejectUnauthorized } : {}),
  };
}

function resolveAuthOverride(params: {
  authHeader?: boolean;
  request?: ProviderRequestTransportOverrides;
}): ResolvedProviderRequestAuthConfig {
  const auth = params.request?.auth;
  if (auth?.mode === "authorization-bearer") {
    const value = auth.token.trim();
    if (value) {
      return {
        configured: true,
        mode: "authorization-bearer",
        headerName: "Authorization",
        value,
        injectAuthorizationHeader: true,
      };
    }
  }
  if (auth?.mode === "header") {
    const headerName = auth.headerName.trim();
    const value = auth.value.trim();
    const prefix = auth.prefix?.trim();
    if (headerName && value) {
      return {
        configured: true,
        mode: "header",
        headerName,
        value,
        ...(prefix ? { prefix } : {}),
        injectAuthorizationHeader: false,
      };
    }
  }
  return {
    configured: false,
    mode: params.authHeader ? "authorization-bearer" : "provider-default",
    injectAuthorizationHeader: params.authHeader === true,
  };
}

export function sanitizeRuntimeProviderRequestOverrides(
  request: ProviderRequestTransportOverrides | undefined,
): ProviderRequestTransportOverrides | undefined {
  if (!request) {
    return undefined;
  }
  if (request.proxy || request.tls) {
    throw new Error(FORBIDDEN_RUNTIME_TRANSPORT_OVERRIDE_MESSAGE);
  }
  const headers = request.headers;
  const auth = request.auth;
  if (!headers && !auth) {
    return undefined;
  }
  return {
    ...(headers ? { headers } : {}),
    ...(auth ? { auth } : {}),
  };
}

function resolveProxyOverride(
  request: ProviderRequestTransportOverrides | undefined,
): ResolvedProviderRequestProxyConfig {
  const proxy = request?.proxy;
  if (!proxy) {
    return { configured: false };
  }
  const tls = resolveTlsOverride(proxy.tls);
  if (proxy.mode === "env-proxy") {
    return {
      configured: true,
      mode: "env-proxy",
      tls,
    };
  }
  const proxyUrl = proxy.url.trim();
  if (!proxyUrl) {
    return { configured: false };
  }
  return {
    configured: true,
    mode: "explicit-proxy",
    proxyUrl,
    tls,
  };
}

function applyResolvedAuthHeader(
  headers: Record<string, string> | undefined,
  auth: ResolvedProviderRequestAuthConfig,
): Record<string, string> | undefined {
  if (!auth.configured) {
    return headers;
  }
  const next = mergeProviderRequestHeaders(headers) ?? Object.create(null);
  const keysToDelete = new Set([auth.headerName.toLowerCase()]);
  if (auth.mode === "header") {
    keysToDelete.add("authorization");
  }
  for (const key of Object.keys(next)) {
    if (keysToDelete.has(key.toLowerCase())) {
      delete next[key];
    }
  }
  next[auth.headerName] =
    auth.mode === "authorization-bearer"
      ? `Bearer ${auth.value}`
      : `${auth.prefix ?? ""}${auth.value}`;
  return Object.keys(next).length > 0 ? next : undefined;
}

function toTlsConnectOptions(
  tls: ResolvedProviderRequestTlsConfig,
): Record<string, unknown> | undefined {
  if (!tls.configured) {
    return undefined;
  }
  const next: Record<string, unknown> = {};
  if (tls.ca) {
    next.ca = tls.ca;
  }
  if (tls.cert) {
    next.cert = tls.cert;
  }
  if (tls.key) {
    next.key = tls.key;
  }
  if (tls.passphrase) {
    next.passphrase = tls.passphrase;
  }
  if (tls.serverName) {
    next.servername = tls.serverName;
  }
  if (tls.rejectUnauthorized !== undefined) {
    next.rejectUnauthorized = tls.rejectUnauthorized;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

export function buildProviderRequestDispatcherPolicy(
  request: Pick<ResolvedProviderRequestConfig, "proxy" | "tls">,
): PinnedDispatcherPolicy | undefined {
  const targetTls = toTlsConnectOptions(request.tls);
  if (!request.proxy.configured) {
    return targetTls ? { mode: "direct", connect: targetTls } : undefined;
  }
  const proxiedTls = toTlsConnectOptions(request.proxy.tls);
  if (request.proxy.mode === "env-proxy") {
    return {
      mode: "env-proxy",
      ...(targetTls ? { connect: { ...targetTls } } : {}),
      ...(proxiedTls ? { proxyTls: { ...proxiedTls } } : {}),
    };
  }
  return {
    mode: "explicit-proxy",
    proxyUrl: request.proxy.proxyUrl,
    ...(proxiedTls ? { proxyTls: proxiedTls } : {}),
  };
}

export function buildProviderRequestTlsClientOptions(
  request: Pick<ResolvedProviderRequestConfig, "tls">,
): Record<string, unknown> | undefined {
  return toTlsConnectOptions(request.tls);
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
  const auth = resolveAuthOverride({
    authHeader: params.authHeader,
    request: params.request,
  });
  const extraHeaders = applyResolvedAuthHeader(
    mergeProviderRequestHeaders(
      params.discoveredHeaders,
      params.providerHeaders,
      params.modelHeaders,
      params.request?.headers,
    ),
    auth,
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
  const mergedDefaults = mergeProviderRequestHeaders(extraHeaders, policy.attributionHeaders);
  const headers =
    params.precedence === "caller-wins"
      ? mergeProviderRequestHeaders(mergedDefaults, unprotectedCallerHeaders)
      : mergeProviderRequestHeaders(unprotectedCallerHeaders, mergedDefaults);

  return {
    api: params.api,
    baseUrl,
    headers,
    extraHeaders: {
      configured: Boolean(extraHeaders),
      headers: extraHeaders,
    },
    auth,
    proxy: resolveProxyOverride(params.request),
    tls: resolveTlsOverride(params.request?.tls),
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
  request?: ProviderRequestTransportOverrides;
}): ResolvedProviderRequestConfig {
  const resolved = resolveProviderRequestPolicyConfig(params);
  return {
    api: resolved.api,
    baseUrl: resolved.baseUrl,
    // Model resolution intentionally excludes attribution headers. Those are
    // applied later at transport/request time so native-host gating stays tied
    // to the final resolved route instead of the catalog/config merge step.
    headers: resolved.extraHeaders.headers,
    extraHeaders: resolved.extraHeaders,
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
  request?: ProviderRequestTransportOverrides;
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
    request: params.request,
  }).headers;
}
