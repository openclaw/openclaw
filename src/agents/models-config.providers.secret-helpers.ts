import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef, resolveSecretInputRef } from "../config/types.secrets.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { isRecord } from "../utils.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { resolveEnvApiKey, type EnvApiKeyLookupOptions } from "./model-auth-env.js";
import {
  isNonSecretApiKeyMarker,
  resolveEnvSecretRefHeaderValueMarker,
  resolveNonEnvSecretRefApiKeyMarker,
  resolveNonEnvSecretRefHeaderValueMarker,
} from "./model-auth-markers.js";
import { resolveAwsSdkEnvVarName } from "./model-auth-runtime-shared.js";
import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
export type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];

export type SecretDefaults = {
  env?: string;
  file?: string;
  exec?: string;
};

export type ProfileApiKeyResolution = {
  apiKey: string;
  source: "plaintext" | "env-ref" | "non-env-ref";
  discoveryApiKey?: string;
};

export type ProviderApiKeyResolver = (provider: string) => {
  apiKey: string | undefined;
  discoveryApiKey?: string;
};

export type ProviderAuthResolver = (
  provider: string,
  options?: { oauthMarker?: string },
) => {
  apiKey: string | undefined;
  discoveryApiKey?: string;
  mode: "api_key" | "aws-sdk" | "oauth" | "token" | "none";
  source: "env" | "profile" | "none";
  profileId?: string;
};

type ProviderRequestConfig = NonNullable<ProviderConfig["request"]>;
type ProviderRequestAuthConfig = NonNullable<ProviderRequestConfig["auth"]>;
type ProviderRequestTlsConfig = NonNullable<ProviderRequestConfig["tls"]>;
type ProviderRequestProxyConfig = NonNullable<ProviderRequestConfig["proxy"]>;
type RequestTlsSecretKey = "ca" | "cert" | "key" | "passphrase";

const REQUEST_TLS_SECRET_KEYS: readonly RequestTlsSecretKey[] = ["ca", "cert", "key", "passphrase"];

const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

export function normalizeApiKeyConfig(value: string): string {
  const trimmed = value.trim();
  const match = /^\$\{([A-Z0-9_]+)\}$/.exec(trimmed);
  return match?.[1] ?? trimmed;
}

export function toDiscoveryApiKey(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed || isNonSecretApiKeyMarker(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function resolveEnvApiKeyVarName(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
  options: EnvApiKeyLookupOptions = {},
): string | undefined {
  const resolved = resolveEnvApiKey(provider, env, options);
  if (!resolved) {
    return undefined;
  }
  const match = /^(?:env: |shell env: )([A-Z0-9_]+)$/.exec(resolved.source);
  return match ? match[1] : undefined;
}

export function resolveAwsSdkApiKeyVarName(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return resolveAwsSdkEnvVarName(env);
}

export function normalizeHeaderValues(params: {
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
    nextHeaders[headerName] =
      resolvedRef.source === "env"
        ? resolveEnvSecretRefHeaderValueMarker(resolvedRef.id)
        : resolveNonEnvSecretRefHeaderValueMarker(resolvedRef.source);
  }
  if (!mutated) {
    return { headers, mutated: false };
  }
  return { headers: nextHeaders, mutated: true };
}

function resolveSecretInputMarker(params: {
  value: unknown;
  secretDefaults: SecretDefaults | undefined;
}): string | undefined {
  const resolvedRef = resolveSecretInputRef({
    value: params.value,
    defaults: params.secretDefaults,
  }).ref;
  if (!resolvedRef || !resolvedRef.id.trim()) {
    return undefined;
  }
  return resolvedRef.source === "env"
    ? resolveEnvSecretRefHeaderValueMarker(resolvedRef.id)
    : resolveNonEnvSecretRefHeaderValueMarker(resolvedRef.source);
}

function normalizeRequestHeaders(params: {
  headers: ProviderRequestConfig["headers"] | undefined;
  secretDefaults: SecretDefaults | undefined;
  refsOnly?: boolean;
}): {
  headers: ProviderRequestConfig["headers"] | undefined;
  mutated: boolean;
  hasMarkers: boolean;
} {
  const { headers } = params;
  if (!headers) {
    return { headers, mutated: false, hasMarkers: false };
  }
  let mutated = false;
  let hasMarkers = false;
  const nextHeaders: Record<string, NonNullable<ProviderRequestConfig["headers"]>[string]> = {};
  for (const [headerName, headerValue] of Object.entries(headers)) {
    const marker = resolveSecretInputMarker({
      value: headerValue,
      secretDefaults: params.secretDefaults,
    });
    if (marker) {
      hasMarkers = true;
      mutated = mutated || marker !== headerValue;
      nextHeaders[headerName] = marker;
      continue;
    }
    if (!params.refsOnly) {
      nextHeaders[headerName] = headerValue;
    }
  }
  if (params.refsOnly && !hasMarkers) {
    return { headers: undefined, mutated: false, hasMarkers: false };
  }
  if (!params.refsOnly && !mutated) {
    return { headers, mutated: false, hasMarkers };
  }
  return { headers: nextHeaders, mutated: true, hasMarkers };
}

function normalizeRequestTlsSecrets(params: {
  tls: ProviderRequestTlsConfig | undefined;
  secretDefaults: SecretDefaults | undefined;
  refsOnly?: boolean;
}): { tls: ProviderRequestTlsConfig | undefined; mutated: boolean; hasMarkers: boolean } {
  const { tls } = params;
  if (!tls) {
    return { tls, mutated: false, hasMarkers: false };
  }
  let mutated = false;
  let hasMarkers = false;
  const nextTls: ProviderRequestTlsConfig = params.refsOnly ? {} : { ...tls };
  for (const key of REQUEST_TLS_SECRET_KEYS) {
    const marker = resolveSecretInputMarker({
      value: tls[key],
      secretDefaults: params.secretDefaults,
    });
    if (!marker) {
      continue;
    }
    hasMarkers = true;
    mutated = mutated || tls[key] !== marker;
    nextTls[key] = marker;
  }
  if (params.refsOnly && !hasMarkers) {
    return { tls: undefined, mutated: false, hasMarkers: false };
  }
  if (!params.refsOnly && !mutated) {
    return { tls, mutated: false, hasMarkers };
  }
  return { tls: nextTls, mutated: true, hasMarkers };
}

function normalizeRequestAuthSecrets(params: {
  auth: ProviderRequestAuthConfig | undefined;
  secretDefaults: SecretDefaults | undefined;
  refsOnly?: boolean;
}): { auth: ProviderRequestAuthConfig | undefined; mutated: boolean; hasMarkers: boolean } {
  const { auth } = params;
  if (!auth) {
    return { auth, mutated: false, hasMarkers: false };
  }
  if (auth.mode === "authorization-bearer") {
    const marker = resolveSecretInputMarker({
      value: auth.token,
      secretDefaults: params.secretDefaults,
    });
    if (!marker) {
      return params.refsOnly
        ? { auth: undefined, mutated: false, hasMarkers: false }
        : { auth, mutated: false, hasMarkers: false };
    }
    return {
      auth: { ...auth, token: marker },
      mutated: auth.token !== marker,
      hasMarkers: true,
    };
  }
  if (auth.mode === "header") {
    const marker = resolveSecretInputMarker({
      value: auth.value,
      secretDefaults: params.secretDefaults,
    });
    if (!marker) {
      return params.refsOnly
        ? { auth: undefined, mutated: false, hasMarkers: false }
        : { auth, mutated: false, hasMarkers: false };
    }
    return {
      auth: { ...auth, value: marker },
      mutated: auth.value !== marker,
      hasMarkers: true,
    };
  }
  return params.refsOnly
    ? { auth: undefined, mutated: false, hasMarkers: false }
    : { auth, mutated: false, hasMarkers: false };
}

function normalizeRequestProxySecrets(params: {
  proxy: ProviderRequestProxyConfig | undefined;
  secretDefaults: SecretDefaults | undefined;
  refsOnly?: boolean;
}): { proxy: ProviderRequestProxyConfig | undefined; mutated: boolean; hasMarkers: boolean } {
  const { proxy } = params;
  if (!proxy) {
    return { proxy, mutated: false, hasMarkers: false };
  }
  const tls = normalizeRequestTlsSecrets({
    tls: proxy.tls,
    secretDefaults: params.secretDefaults,
    refsOnly: params.refsOnly,
  });
  if (!tls.hasMarkers) {
    return params.refsOnly
      ? { proxy: undefined, mutated: false, hasMarkers: false }
      : { proxy, mutated: false, hasMarkers: false };
  }
  return {
    proxy: { ...proxy, tls: tls.tls },
    mutated: tls.mutated,
    hasMarkers: true,
  };
}

export function normalizeProviderRequestSecrets(params: {
  request: ProviderConfig["request"] | undefined;
  secretDefaults: SecretDefaults | undefined;
}): { request: ProviderConfig["request"] | undefined; mutated: boolean; hasMarkers: boolean } {
  const { request } = params;
  if (!request) {
    return { request, mutated: false, hasMarkers: false };
  }
  let mutated = false;
  let hasMarkers = false;
  const nextRequest: ProviderRequestConfig = { ...request };

  const headers = normalizeRequestHeaders({
    headers: request.headers,
    secretDefaults: params.secretDefaults,
  });
  if (headers.mutated) {
    mutated = true;
    nextRequest.headers = headers.headers;
  }
  hasMarkers = hasMarkers || headers.hasMarkers;

  const auth = normalizeRequestAuthSecrets({
    auth: request.auth,
    secretDefaults: params.secretDefaults,
  });
  if (auth.mutated) {
    mutated = true;
    nextRequest.auth = auth.auth;
  }
  hasMarkers = hasMarkers || auth.hasMarkers;

  const proxy = normalizeRequestProxySecrets({
    proxy: request.proxy,
    secretDefaults: params.secretDefaults,
  });
  if (proxy.mutated) {
    mutated = true;
    nextRequest.proxy = proxy.proxy;
  }
  hasMarkers = hasMarkers || proxy.hasMarkers;

  const tls = normalizeRequestTlsSecrets({
    tls: request.tls,
    secretDefaults: params.secretDefaults,
  });
  if (tls.mutated) {
    mutated = true;
    nextRequest.tls = tls.tls;
  }
  hasMarkers = hasMarkers || tls.hasMarkers;

  return mutated ? { request: nextRequest, mutated, hasMarkers } : { request, mutated, hasMarkers };
}

export function collectProviderRequestSecretMarkerPatch(params: {
  request: ProviderConfig["request"] | undefined;
  secretDefaults: SecretDefaults | undefined;
}): { request: ProviderConfig["request"] | undefined; hasMarkers: boolean } {
  const { request } = params;
  if (!request) {
    return { request: undefined, hasMarkers: false };
  }
  let hasMarkers = false;
  const patch: ProviderRequestConfig = {};

  const headers = normalizeRequestHeaders({
    headers: request.headers,
    secretDefaults: params.secretDefaults,
    refsOnly: true,
  });
  if (headers.hasMarkers) {
    hasMarkers = true;
    patch.headers = headers.headers;
  }

  const auth = normalizeRequestAuthSecrets({
    auth: request.auth,
    secretDefaults: params.secretDefaults,
    refsOnly: true,
  });
  if (auth.hasMarkers) {
    hasMarkers = true;
    patch.auth = auth.auth;
  }

  const proxy = normalizeRequestProxySecrets({
    proxy: request.proxy,
    secretDefaults: params.secretDefaults,
    refsOnly: true,
  });
  if (proxy.hasMarkers) {
    hasMarkers = true;
    patch.proxy = proxy.proxy;
  }

  const tls = normalizeRequestTlsSecrets({
    tls: request.tls,
    secretDefaults: params.secretDefaults,
    refsOnly: true,
  });
  if (tls.hasMarkers) {
    hasMarkers = true;
    patch.tls = tls.tls;
  }

  return hasMarkers ? { request: patch, hasMarkers: true } : { request: undefined, hasMarkers };
}

function mergeTlsSecretMarkerPatch(params: {
  current: ProviderRequestTlsConfig | undefined;
  patch: ProviderRequestTlsConfig | undefined;
}): { tls: ProviderRequestTlsConfig | undefined; mutated: boolean } {
  if (!params.patch) {
    return { tls: params.current, mutated: false };
  }
  const nextTls: ProviderRequestTlsConfig = isRecord(params.current) ? { ...params.current } : {};
  let mutated = !params.current;
  for (const key of REQUEST_TLS_SECRET_KEYS) {
    const patchValue = params.patch[key];
    if (patchValue === undefined || nextTls[key] === patchValue) {
      continue;
    }
    mutated = true;
    nextTls[key] = patchValue;
  }
  return { tls: mutated ? nextTls : params.current, mutated };
}

export function mergeProviderRequestSecretMarkerPatch(params: {
  request: ProviderConfig["request"] | undefined;
  markerPatch: ProviderConfig["request"] | undefined;
}): { request: ProviderConfig["request"] | undefined; mutated: boolean } {
  if (!params.markerPatch) {
    return { request: params.request, mutated: false };
  }
  const nextRequest: ProviderRequestConfig = isRecord(params.request) ? { ...params.request } : {};
  let mutated = !params.request;

  if (params.markerPatch.headers) {
    const nextHeaders: NonNullable<ProviderRequestConfig["headers"]> = isRecord(nextRequest.headers)
      ? { ...nextRequest.headers }
      : {};
    let headersMutated = !nextRequest.headers;
    for (const [headerName, marker] of Object.entries(params.markerPatch.headers)) {
      if (nextHeaders[headerName] === marker) {
        continue;
      }
      headersMutated = true;
      nextHeaders[headerName] = marker;
    }
    if (headersMutated) {
      mutated = true;
      nextRequest.headers = nextHeaders;
    }
  }

  if (params.markerPatch.auth && nextRequest.auth !== params.markerPatch.auth) {
    mutated = true;
    nextRequest.auth = params.markerPatch.auth;
  }

  if (params.markerPatch.proxy) {
    const currentProxy = isRecord(nextRequest.proxy)
      ? (nextRequest.proxy as ProviderRequestProxyConfig)
      : undefined;
    let nextProxy: ProviderRequestProxyConfig = {
      ...params.markerPatch.proxy,
      ...currentProxy,
    };
    let proxyMutated = !currentProxy;
    const mergedProxyTls = mergeTlsSecretMarkerPatch({
      current: currentProxy?.tls,
      patch: params.markerPatch.proxy.tls,
    });
    if (mergedProxyTls.mutated) {
      proxyMutated = true;
      nextProxy = { ...nextProxy, tls: mergedProxyTls.tls };
    }
    if (proxyMutated) {
      mutated = true;
      nextRequest.proxy = nextProxy;
    }
  }

  const mergedTls = mergeTlsSecretMarkerPatch({
    current: nextRequest.tls,
    patch: params.markerPatch.tls,
  });
  if (mergedTls.mutated) {
    mutated = true;
    nextRequest.tls = mergedTls.tls;
  }

  return { request: mutated ? nextRequest : params.request, mutated };
}

export function resolveApiKeyFromCredential(
  cred: AuthProfileStore["profiles"][string] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ProfileApiKeyResolution | undefined {
  if (!cred) {
    return undefined;
  }
  if (cred.type === "api_key") {
    const keyRef = coerceSecretRef(cred.keyRef);
    if (keyRef && keyRef.id.trim()) {
      if (keyRef.source === "env") {
        const envVar = keyRef.id.trim();
        return {
          apiKey: envVar,
          source: "env-ref",
          discoveryApiKey: toDiscoveryApiKey(env[envVar]),
        };
      }
      return {
        apiKey: resolveNonEnvSecretRefApiKeyMarker(keyRef.source),
        source: "non-env-ref",
      };
    }
    if (cred.key?.trim()) {
      return {
        apiKey: cred.key,
        source: "plaintext",
        discoveryApiKey: toDiscoveryApiKey(cred.key),
      };
    }
    return undefined;
  }
  if (cred.type === "token") {
    const tokenRef = coerceSecretRef(cred.tokenRef);
    if (tokenRef && tokenRef.id.trim()) {
      if (tokenRef.source === "env") {
        const envVar = tokenRef.id.trim();
        return {
          apiKey: envVar,
          source: "env-ref",
          discoveryApiKey: toDiscoveryApiKey(env[envVar]),
        };
      }
      return {
        apiKey: resolveNonEnvSecretRefApiKeyMarker(tokenRef.source),
        source: "non-env-ref",
      };
    }
    if (cred.token?.trim()) {
      return {
        apiKey: cred.token,
        source: "plaintext",
        discoveryApiKey: toDiscoveryApiKey(cred.token),
      };
    }
  }
  return undefined;
}

export function listAuthProfilesForProvider(store: AuthProfileStore, provider: string): string[] {
  const providerKey = resolveProviderIdForAuth(provider);
  return Object.entries(store.profiles)
    .filter(([, cred]) => resolveProviderIdForAuth(cred.provider) === providerKey)
    .map(([id]) => id);
}

export function resolveApiKeyFromProfiles(params: {
  provider: string;
  store: AuthProfileStore;
  env?: NodeJS.ProcessEnv;
}): ProfileApiKeyResolution | undefined {
  const ids = listAuthProfilesForProvider(params.store, params.provider);
  for (const id of ids) {
    const resolved = resolveApiKeyFromCredential(params.store.profiles[id], params.env);
    if (resolved) {
      return resolved;
    }
  }
  return undefined;
}

export function normalizeConfiguredProviderApiKey(params: {
  providerKey: string;
  provider: ProviderConfig;
  secretDefaults: SecretDefaults | undefined;
  profileApiKey: ProfileApiKeyResolution | undefined;
  secretRefManagedProviders?: Set<string>;
}): ProviderConfig {
  const configuredApiKey = params.provider.apiKey;
  const configuredApiKeyRef = resolveSecretInputRef({
    value: configuredApiKey,
    defaults: params.secretDefaults,
  }).ref;

  if (configuredApiKeyRef && configuredApiKeyRef.id.trim()) {
    const marker =
      configuredApiKeyRef.source === "env"
        ? configuredApiKeyRef.id.trim()
        : resolveNonEnvSecretRefApiKeyMarker(configuredApiKeyRef.source);
    params.secretRefManagedProviders?.add(params.providerKey);
    if (params.provider.apiKey === marker) {
      return params.provider;
    }
    return {
      ...params.provider,
      apiKey: marker,
    };
  }

  if (typeof configuredApiKey !== "string") {
    return params.provider;
  }

  const normalizedConfiguredApiKey = normalizeApiKeyConfig(configuredApiKey);
  if (isNonSecretApiKeyMarker(normalizedConfiguredApiKey)) {
    params.secretRefManagedProviders?.add(params.providerKey);
  }
  if (
    params.profileApiKey &&
    params.profileApiKey.source !== "plaintext" &&
    normalizedConfiguredApiKey === params.profileApiKey.apiKey
  ) {
    params.secretRefManagedProviders?.add(params.providerKey);
  }
  if (normalizedConfiguredApiKey === configuredApiKey) {
    return params.provider;
  }
  return {
    ...params.provider,
    apiKey: normalizedConfiguredApiKey,
  };
}

export function normalizeResolvedEnvApiKey(params: {
  providerKey: string;
  provider: ProviderConfig;
  env: NodeJS.ProcessEnv;
  secretRefManagedProviders?: Set<string>;
}): ProviderConfig {
  const currentApiKey = params.provider.apiKey;
  if (
    typeof currentApiKey !== "string" ||
    !currentApiKey.trim() ||
    ENV_VAR_NAME_RE.test(currentApiKey.trim())
  ) {
    return params.provider;
  }

  const envVarName = resolveEnvApiKeyVarName(params.providerKey, params.env);
  if (!envVarName || params.env[envVarName] !== currentApiKey) {
    return params.provider;
  }
  params.secretRefManagedProviders?.add(params.providerKey);
  return {
    ...params.provider,
    apiKey: envVarName,
  };
}

export function resolveMissingProviderApiKey(params: {
  providerKey: string;
  provider: ProviderConfig;
  env: NodeJS.ProcessEnv;
  profileApiKey: ProfileApiKeyResolution | undefined;
  secretRefManagedProviders?: Set<string>;
  providerApiKeyResolver?: (env: NodeJS.ProcessEnv) => string | undefined;
}): ProviderConfig {
  const hasModels = Array.isArray(params.provider.models) && params.provider.models.length > 0;
  const normalizedApiKey = normalizeOptionalSecretInput(params.provider.apiKey);
  const hasConfiguredApiKey = Boolean(normalizedApiKey || params.provider.apiKey);
  if (!hasModels || hasConfiguredApiKey) {
    return params.provider;
  }

  const authMode = params.provider.auth;
  if (params.providerApiKeyResolver && (!authMode || authMode === "aws-sdk")) {
    const resolvedApiKey = params.providerApiKeyResolver(params.env);
    if (!resolvedApiKey) {
      return params.provider;
    }
    return {
      ...params.provider,
      apiKey: resolvedApiKey,
    };
  }
  if (authMode === "aws-sdk") {
    const awsEnvVar = resolveAwsSdkApiKeyVarName(params.env);
    if (!awsEnvVar) {
      return params.provider;
    }
    return {
      ...params.provider,
      apiKey: awsEnvVar,
    };
  }

  const fromEnv = resolveEnvApiKeyVarName(params.providerKey, params.env);
  const apiKey = fromEnv ?? params.profileApiKey?.apiKey;
  if (!apiKey?.trim()) {
    return params.provider;
  }
  if (params.profileApiKey && params.profileApiKey.source !== "plaintext") {
    params.secretRefManagedProviders?.add(params.providerKey);
  }
  return {
    ...params.provider,
    apiKey,
  };
}
