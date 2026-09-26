import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { ModelDefinitionConfig } from "../config/types.js";
import type {
  ConfiguredModelProviderRequest,
  ConfiguredProviderRequest,
} from "../config/types.provider-request.js";
import { assertSecretInputResolved } from "../config/types.secrets.js";
import type { PinnedDispatcherPolicy } from "../infra/net/ssrf.js";
import type { Api } from "../llm/types.js";
import type { PluginMetadataSnapshotOwnerMaps } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  type ProviderRequestCapabilities,
  type ProviderRequestCapability,
  type ProviderRequestTransport,
  resolveProviderRequestCapabilities,
} from "./provider-attribution.js";

type RequestApi = Api | ModelDefinitionConfig["api"];

/** Auth override accepted from sanitized provider/model request config. */
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

/** TLS override accepted from sanitized provider/model request config. */
export type ProviderRequestTlsOverride = {
  ca?: string;
  cert?: string;
  key?: string;
  passphrase?: string;
  serverName?: string;
  insecureSkipVerify?: boolean;
};

/** Proxy override accepted from sanitized provider/model request config. */
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

/** Transport override block shared by provider and model request config. */
export type ProviderRequestTransportOverrides = {
  headers?: Record<string, string>;
  auth?: ProviderRequestAuthOverride;
  proxy?: ProviderRequestProxyOverride;
  tls?: ProviderRequestTlsOverride;
};

/** Model-scoped transport overrides, including private-network policy. */
export type ModelProviderRequestTransportOverrides = ProviderRequestTransportOverrides & {
  allowPrivateNetwork?: boolean;
};

type ProviderRequestHeaderPrecedence = "caller-wins" | "defaults-win";

const FORBIDDEN_HEADER_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const FORBIDDEN_INSECURE_TLS_MESSAGE =
  "Provider transport overrides do not allow insecureSkipVerify";
const FORBIDDEN_RUNTIME_TRANSPORT_OVERRIDE_MESSAGE =
  "Runtime auth request overrides do not allow proxy or TLS transport settings";

// Provider/model/caller request inputs are merged through one path so SSRF,
// header precedence, and Copilot dynamic headers stay consistent.
type ResolveProviderRequestPolicyConfigParams = {
  provider?: string;
  api?: RequestApi;
  baseUrl?: string;
  providerMetadataOwners?: PluginMetadataSnapshotOwnerMaps;
  defaultBaseUrl?: string;
  capability?: ProviderRequestCapability;
  transport?: ProviderRequestTransport;
  discoveredHeaders?: Record<string, string>;
  providerHeaders?: Record<string, string>;
  modelHeaders?: Record<string, string>;
  callerHeaders?: Record<string, string>;
  precedence?: ProviderRequestHeaderPrecedence;
  authHeader?: boolean;
  compat?: unknown;
  modelId?: string | null;
  allowPrivateNetwork?: boolean;
  request?: ModelProviderRequestTransportOverrides;
  routeFacts?: ProviderRequestRouteFacts;
};

function sanitizeConfiguredRequestString(value: unknown, path: string): string | undefined {
  if (typeof value !== "string") {
    // Config transport overrides are sanitized after secrets runtime resolution.
    // Fail closed if a raw SecretRef leaks into this path instead of silently dropping it.
    assertSecretInputResolved({ value, path });
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** Sanitizes provider-level request overrides after secret resolution. */
export function sanitizeConfiguredProviderRequest(
  request: ConfiguredProviderRequest | undefined,
): ProviderRequestTransportOverrides | undefined {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return undefined;
  }

  let headers: Record<string, string> | undefined;
  if (request.headers && typeof request.headers === "object" && !Array.isArray(request.headers)) {
    const nextHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      const sanitized = sanitizeConfiguredRequestString(value, `request.headers.${key}`);
      if (sanitized) {
        nextHeaders[key] = sanitized;
      }
    }
    if (Object.keys(nextHeaders).length > 0) {
      headers = nextHeaders;
    }
  }

  let auth: ProviderRequestAuthOverride | undefined;
  const rawAuth = request.auth;
  if (rawAuth && typeof rawAuth === "object" && !Array.isArray(rawAuth)) {
    if (rawAuth.mode === "provider-default") {
      auth = { mode: "provider-default" };
    } else if (rawAuth.mode === "authorization-bearer") {
      const token = sanitizeConfiguredRequestString(rawAuth.token, "request.auth.token");
      if (token) {
        auth = { mode: "authorization-bearer", token };
      }
    } else if (rawAuth.mode === "header") {
      const headerName = sanitizeConfiguredRequestString(
        rawAuth.headerName,
        "request.auth.headerName",
      );
      const value = sanitizeConfiguredRequestString(rawAuth.value, "request.auth.value");
      const prefix = sanitizeConfiguredRequestString(rawAuth.prefix, "request.auth.prefix");
      if (headerName && value) {
        auth = {
          mode: "header",
          headerName,
          value,
          ...(prefix ? { prefix } : {}),
        };
      }
    }
  }

  const sanitizeTls = (
    tls: unknown,
    pathPrefix: "request.tls" | "request.proxy.tls",
  ): ProviderRequestTlsOverride | undefined => {
    if (!tls || typeof tls !== "object" || Array.isArray(tls)) {
      return undefined;
    }
    const rawTls = tls as Record<string, unknown>;
    const next: ProviderRequestTlsOverride = {};
    for (const key of ["ca", "cert", "key", "passphrase", "serverName"] as const) {
      const value = sanitizeConfiguredRequestString(rawTls[key], `${pathPrefix}.${key}`);
      if (value) {
        next[key] = value;
      }
    }
    if (typeof rawTls.insecureSkipVerify === "boolean") {
      next.insecureSkipVerify = rawTls.insecureSkipVerify;
    }
    return Object.keys(next).length > 0 ? next : undefined;
  };

  let proxy: ProviderRequestProxyOverride | undefined;
  const rawProxy = request.proxy;
  if (rawProxy && typeof rawProxy === "object" && !Array.isArray(rawProxy)) {
    const tls = sanitizeTls(rawProxy.tls, "request.proxy.tls");
    if (rawProxy.mode === "env-proxy") {
      proxy = {
        mode: "env-proxy",
        ...(tls ? { tls } : {}),
      };
    } else if (rawProxy.mode === "explicit-proxy") {
      const url = sanitizeConfiguredRequestString(rawProxy.url, "request.proxy.url");
      if (url) {
        proxy = {
          mode: "explicit-proxy",
          url,
          ...(tls ? { tls } : {}),
        };
      }
    }
  }

  const tls = sanitizeTls(request.tls, "request.tls");

  if (!headers && !auth && !proxy && !tls) {
    return undefined;
  }
  return {
    ...(headers ? { headers } : {}),
    ...(auth ? { auth } : {}),
    ...(proxy ? { proxy } : {}),
    ...(tls ? { tls } : {}),
  };
}

/** Sanitizes model-level request overrides after secret resolution. */
export function sanitizeConfiguredModelProviderRequest(
  request: ConfiguredModelProviderRequest | undefined,
): ModelProviderRequestTransportOverrides | undefined {
  const sanitized = sanitizeConfiguredProviderRequest(request);
  const rawAllow = request?.allowPrivateNetwork;
  const allowPrivateNetwork = rawAllow === true ? true : rawAllow === false ? false : undefined;
  if (!sanitized && allowPrivateNetwork === undefined) {
    return undefined;
  }
  return {
    ...sanitized,
    ...(allowPrivateNetwork !== undefined ? { allowPrivateNetwork } : {}),
  };
}

/** Merges model request overrides, preserving the latest private-network policy. */
export function mergeModelProviderRequestOverrides(
  ...overrides: Array<ModelProviderRequestTransportOverrides | undefined>
): ModelProviderRequestTransportOverrides | undefined {
  const merged: ModelProviderRequestTransportOverrides = {};
  let hasMerged = false;
  for (const current of overrides) {
    if (!current) {
      continue;
    }
    hasMerged = true;
    if (current.headers) {
      merged.headers = Object.assign({}, merged.headers, current.headers);
    }
    if (current.auth) {
      merged.auth = current.auth;
    }
    if (current.proxy) {
      merged.proxy = current.proxy;
    }
    if (current.tls) {
      merged.tls = current.tls;
    }
    if (current.allowPrivateNetwork !== undefined) {
      merged.allowPrivateNetwork = current.allowPrivateNetwork;
    }
  }
  return hasMerged ? merged : undefined;
}

/** Normalizes provider base URLs by trimming trailing slashes. */
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

// Header keys are compared case-insensitively and prototype-polluting names are
// dropped before values are attached to outbound provider requests.
function mergeProviderRequestHeaders(
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
      const normalizedKey = normalizeLowercaseStringOrEmpty(key);
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

function resolveTlsOverride(tls: ProviderRequestTlsOverride | undefined) {
  if (!tls) {
    return { configured: false } as const;
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
    return { configured: false } as const;
  }
  return {
    configured: true,
    ...(ca ? { ca } : {}),
    ...(cert ? { cert } : {}),
    ...(key ? { key } : {}),
    ...(passphrase ? { passphrase } : {}),
    ...(serverName ? { serverName } : {}),
    ...(rejectUnauthorized !== undefined ? { rejectUnauthorized } : {}),
  } as const;
}

type ResolvedProviderRequestTlsConfig = ReturnType<typeof resolveTlsOverride>;

function resolveAuthOverride(params: {
  authHeader?: boolean;
  request?: ProviderRequestTransportOverrides;
}) {
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
      } as const;
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
      } as const;
    }
  }
  return {
    configured: false,
    mode: params.authHeader ? "authorization-bearer" : "provider-default",
    injectAuthorizationHeader: params.authHeader === true,
  } as const;
}

type ResolvedProviderRequestAuthConfig = ReturnType<typeof resolveAuthOverride>;

/** Sanitizes runtime-only provider request overrides for auth request paths. */
function sanitizeRuntimeProviderRequestOverrides(
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

/** Applies provider-prepared runtime auth overrides to a resolved model. */
export function applyPreparedRuntimeAuthToModel<
  T extends {
    provider: string;
    api?: RequestApi;
    baseUrl?: string;
    headers?: Record<string, string>;
  },
>(
  model: T,
  preparedAuth:
    | { baseUrl?: string; request?: ModelProviderRequestTransportOverrides }
    | null
    | undefined,
): T {
  if (!preparedAuth?.baseUrl && !preparedAuth?.request) {
    return model;
  }
  const providerHeaders = preparedAuth.request?.auth
    ? Object.fromEntries(
        Object.entries(model.headers ?? {}).filter(
          ([key]) => !["authorization", "api-key", "x-api-key"].includes(key.toLowerCase()),
        ),
      )
    : model.headers;
  const requestConfig = resolveProviderRequestConfig({
    provider: model.provider,
    api: model.api,
    baseUrl: preparedAuth.baseUrl ?? model.baseUrl,
    providerHeaders,
    request: sanitizeRuntimeProviderRequestOverrides(preparedAuth.request),
    capability: "llm",
    transport: "stream",
  });
  const next = {
    ...model,
    ...(preparedAuth.baseUrl ? { baseUrl: preparedAuth.baseUrl } : {}),
    headers: requestConfig.headers,
  };
  const routeFacts = getModelProviderRequestRouteFacts(model);
  return routeFacts
    ? attachModelProviderRequestRouteFacts(next, routeFacts.providerMetadataOwners)
    : next;
}

function resolveProxyOverride(request: ProviderRequestTransportOverrides | undefined) {
  const proxy = request?.proxy;
  if (!proxy) {
    return { configured: false } as const;
  }
  const tls = resolveTlsOverride(proxy.tls);
  if (proxy.mode === "env-proxy") {
    return {
      configured: true,
      mode: "env-proxy",
      tls,
    } as const;
  }
  const proxyUrl = proxy.url.trim();
  if (!proxyUrl) {
    return { configured: false } as const;
  }
  return {
    configured: true,
    mode: "explicit-proxy",
    proxyUrl,
    tls,
  } as const;
}

function applyResolvedAuthHeader(
  headers: Record<string, string> | undefined,
  auth: ResolvedProviderRequestAuthConfig,
): Record<string, string> | undefined {
  if (!auth.configured) {
    return headers;
  }
  const next = mergeProviderRequestHeaders(headers) ?? Object.create(null);
  const keysToDelete = new Set([normalizeLowercaseStringOrEmpty(auth.headerName)]);
  if (auth.mode === "header") {
    keysToDelete.add("authorization");
  }
  for (const key of Object.keys(next)) {
    if (keysToDelete.has(normalizeLowercaseStringOrEmpty(key))) {
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
  for (const key of ["ca", "cert", "key", "passphrase"] as const) {
    if (tls[key]) {
      next[key] = tls[key];
    }
  }
  if (tls.serverName) {
    next.servername = tls.serverName;
  }
  if (tls.rejectUnauthorized !== undefined) {
    next.rejectUnauthorized = tls.rejectUnauthorized;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** Builds the dispatcher proxy/TLS policy for outbound provider requests. */
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

/** Resolves the full provider request policy, headers, auth, proxy, and TLS config. */
export function resolveProviderRequestPolicyConfig(
  params: ResolveProviderRequestPolicyConfigParams,
) {
  const baseUrl = normalizeBaseUrl(params.baseUrl, params.defaultBaseUrl);
  const capabilities =
    params.routeFacts?.capabilities ??
    resolveProviderRequestCapabilities({
      provider: params.provider,
      api: params.api,
      baseUrl,
      providerMetadataOwners: params.providerMetadataOwners,
      capability: params.capability ?? "llm",
      transport: params.transport ?? "http",
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
    Object.keys(capabilities.attributionHeaders ?? {}).map((key) =>
      normalizeLowercaseStringOrEmpty(key),
    ),
  );
  const unprotectedCallerHeaders = params.callerHeaders
    ? Object.fromEntries(
        Object.entries(params.callerHeaders).filter(
          ([key]) => !protectedAttributionKeys.has(normalizeLowercaseStringOrEmpty(key)),
        ),
      )
    : undefined;
  const mergedDefaults = mergeProviderRequestHeaders(extraHeaders, capabilities.attributionHeaders);
  const headers =
    params.precedence === "caller-wins"
      ? mergeProviderRequestHeaders(mergedDefaults, unprotectedCallerHeaders)
      : mergeProviderRequestHeaders(unprotectedCallerHeaders, mergedDefaults);
  // Runtime/caller policy takes precedence over model config.
  const allowPrivateNetwork = params.allowPrivateNetwork ?? params.request?.allowPrivateNetwork;

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
    capabilities,
    allowPrivateNetwork: allowPrivateNetwork === undefined ? false : allowPrivateNetwork,
    trustConfiguredBaseUrlOrigin:
      (allowPrivateNetwork === undefined || allowPrivateNetwork) &&
      (capabilities.endpointClass === "custom" || capabilities.endpointClass === "local"),
  };
}

/** Resolves request config used during model/catalog setup paths. */
export function resolveProviderRequestConfig(params: {
  provider: string;
  api?: RequestApi;
  baseUrl?: string;
  providerMetadataOwners?: PluginMetadataSnapshotOwnerMaps;
  capability?: ProviderRequestCapability;
  transport?: ProviderRequestTransport;
  discoveredHeaders?: Record<string, string>;
  providerHeaders?: Record<string, string>;
  modelHeaders?: Record<string, string>;
  authHeader?: boolean;
  request?: ProviderRequestTransportOverrides;
}) {
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
  };
}

type ResolvedProviderRequestConfig = ReturnType<typeof resolveProviderRequestConfig>;

/** Resolves final headers for one provider request route. */
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

const MODEL_PROVIDER_REQUEST_TRANSPORT_SYMBOL = Symbol.for(
  "openclaw.modelProviderRequestTransport",
);
const MODEL_PROVIDER_REQUEST_ROUTE_FACTS_SYMBOL = Symbol.for(
  "openclaw.modelProviderRequestRouteFacts",
);

type ProviderRequestRouteFacts = {
  providerMetadataOwners: PluginMetadataSnapshotOwnerMaps;
  capabilities: ProviderRequestCapabilities;
  providerOwner?: string;
};
type ProviderRequestRouteModel = {
  provider?: string;
  api?: RequestApi;
  baseUrl?: string;
  id?: string;
  compat?: unknown;
};

type ModelWithProviderRequestTransport = {
  [MODEL_PROVIDER_REQUEST_TRANSPORT_SYMBOL]?: ModelProviderRequestTransportOverrides;
};
type ModelWithProviderRequestRouteFacts = {
  [MODEL_PROVIDER_REQUEST_ROUTE_FACTS_SYMBOL]?: ProviderRequestRouteFacts;
};

/** Attaches model-scoped provider request transport metadata without mutating the model. */
export function attachModelProviderRequestTransport<TModel extends object>(
  model: TModel,
  request: ModelProviderRequestTransportOverrides | undefined,
): TModel {
  if (!request) {
    return model;
  }
  return { ...model, [MODEL_PROVIDER_REQUEST_TRANSPORT_SYMBOL]: request };
}

/** Reads provider request transport metadata attached to a model definition. */
export function getModelProviderRequestTransport(
  model: object,
): ModelProviderRequestTransportOverrides | undefined {
  return (model as ModelWithProviderRequestTransport)[MODEL_PROVIDER_REQUEST_TRANSPORT_SYMBOL];
}

/** Resolves and attaches the final provider route against one lifecycle-owned metadata generation. */
export function attachModelProviderRequestRouteFacts<TModel extends ProviderRequestRouteModel>(
  model: TModel,
  providerMetadataOwners: PluginMetadataSnapshotOwnerMaps | undefined,
): TModel {
  if (!providerMetadataOwners || !model.provider) {
    return model;
  }
  const next = { ...model } as TModel & ModelWithProviderRequestRouteFacts;
  const capabilities = resolveProviderRequestCapabilities({
    provider: model.provider,
    api: model.api,
    baseUrl: normalizeBaseUrl(model.baseUrl),
    providerMetadataOwners,
    capability: "llm",
    transport: "stream",
    modelId: model.id,
    compat: model.compat,
  });
  next[MODEL_PROVIDER_REQUEST_ROUTE_FACTS_SYMBOL] = {
    providerMetadataOwners,
    capabilities,
    ...(!["default", "invalid", "local", "custom"].includes(capabilities.endpointClass)
      ? { providerOwner: capabilities.endpointClass }
      : {}),
  };
  return next;
}

/** Reads the prepared provider route attached to a transport model. */
export function getModelProviderRequestRouteFacts(
  model: object,
): ProviderRequestRouteFacts | undefined {
  return (model as ModelWithProviderRequestRouteFacts)[MODEL_PROVIDER_REQUEST_ROUTE_FACTS_SYMBOL];
}

/** Re-resolves a projected transport model against the source model's metadata generation. */
export function inheritModelProviderRequestRouteFacts<TModel extends ProviderRequestRouteModel>(
  source: object,
  target: TModel,
): TModel {
  return attachModelProviderRequestRouteFacts(
    target,
    getModelProviderRequestRouteFacts(source)?.providerMetadataOwners,
  );
}
