import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  resolveAuthProfileOrder,
  type AuthProfileStore,
  type OpenClawConfig,
  type SecretInput,
} from "openclaw/plugin-sdk/provider-auth";
import { isNonSecretApiKeyMarker } from "openclaw/plugin-sdk/provider-auth-markers";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  resolveProviderHttpRequestConfigWithOriginTrust,
  resolveProviderTransportSsrFPolicy,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  coerceSecretRef,
  resolveConfiguredSecretInputString,
} from "openclaw/plugin-sdk/secret-input-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { OLLAMA_DEFAULT_BASE_URL } from "./defaults.js";
import { isLocalOllamaBaseUrl } from "./discovery-shared.js";
import { readProviderBaseUrl } from "./provider-base-url.js";
import { resolveOllamaApiBase } from "./provider-models.js";

export function isSavedOllamaEndpoint(
  provider: ModelProviderConfig | undefined,
  baseUrl: string,
): boolean {
  return Boolean(provider && resolveOllamaApiBase(readProviderBaseUrl(provider)) === baseUrl);
}

/** Resolve only the selected endpoint's transport; keep authored SecretRefs in saved config. */
export async function resolveOllamaSetupFetch(params: {
  cfg: OpenClawConfig;
  baseUrl: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  agentDir?: string;
  existingProfiles?: ProviderAuthContext["existingProfiles"];
  assertCurrent?: () => void;
}): Promise<typeof fetchWithSsrFGuard> {
  const source = params.cfg.models?.providers?.ollama;
  const saved = isSavedOllamaEndpoint(source, params.baseUrl) ? source : undefined;
  // Only the selected connection's HTTP inputs enter the private resolved projection.
  const provider = structuredClone({
    apiKey: saved?.apiKey,
    headers: saved?.headers,
    request: saved?.request,
  });
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent?.();
  };
  const resolveInput = async (value: SecretInput | undefined, field: string) => {
    assertCurrent();
    const resolved = await resolveConfiguredSecretInputString({
      config: params.cfg,
      env: params.env ?? process.env,
      value,
      path: "models.providers.ollama." + field,
      unresolvedReasonStyle: "detailed",
    });
    assertCurrent();
    if (resolved.unresolvedRefReason) {
      throw new Error(resolved.unresolvedRefReason);
    }
    return resolved.value;
  };
  for (const [headers, field] of [
    [provider.headers, "headers"],
    [provider.request?.headers, "request.headers"],
  ] as const) {
    if (headers) {
      for (const [name, value] of Object.entries(headers)) {
        const resolved = await resolveInput(value, field + "[" + JSON.stringify(name) + "]");
        if (resolved === undefined) {
          delete headers[name];
        } else {
          headers[name] = resolved;
        }
      }
    }
  }
  const request = provider.request;
  if (request?.auth?.mode === "authorization-bearer") {
    request.auth.token = (await resolveInput(request.auth.token, "request.auth.token")) ?? "";
  } else if (request?.auth?.mode === "header") {
    request.auth.value = (await resolveInput(request.auth.value, "request.auth.value")) ?? "";
  }
  for (const [tls, field] of [
    [request?.tls, "request.tls"],
    [request?.proxy?.tls, "request.proxy.tls"],
  ] as const) {
    if (tls) {
      for (const name of ["ca", "cert", "key", "passphrase"] as const) {
        tls[name] = await resolveInput(tls[name], field + "." + name);
      }
    }
  }
  const headers = { ...provider.headers, ...request?.headers };
  const explicitHttpAuth =
    Object.keys(headers).some((name) => name.toLowerCase() === "authorization") ||
    (request?.auth && request.auth.mode !== "provider-default");
  let apiKey: string | undefined;
  if (
    saved &&
    !explicitHttpAuth &&
    (provider.apiKey || params.existingProfiles?.length || !isLocalOllamaBaseUrl(params.baseUrl))
  ) {
    const profileId =
      typeof provider.apiKey === "string" && !isNonSecretApiKeyMarker(provider.apiKey)
        ? params.existingProfiles?.find((profile) => profile.profileId === provider.apiKey)
            ?.profileId
        : undefined;
    if (provider.apiKey !== undefined && !profileId) {
      const configured = await resolveInput(provider.apiKey, "apiKey");
      const ref = coerceSecretRef(provider.apiKey, params.cfg.secrets?.defaults);
      const value =
        !ref && configured === "OLLAMA_API_KEY"
          ? (params.env ?? process.env).OLLAMA_API_KEY
          : configured;
      // An authored input owns the request, including an explicit no-auth marker.
      apiKey = value && (ref || !isNonSecretApiKeyMarker(value)) ? value : undefined;
    } else if (params.existingProfiles?.length) {
      // Choose through the auth owner, then bind one admitted identity so a
      // failed profile cannot fall through to process-wide environment auth.
      const store: AuthProfileStore = {
        version: 1,
        profiles: Object.fromEntries(
          params.existingProfiles.map((profile) => [profile.profileId, profile.credential]),
        ),
      };
      const selectedProfile =
        profileId ??
        resolveAuthProfileOrder({
          cfg: params.cfg,
          provider: "ollama",
          store,
          readinessMode: "read-only",
          includePendingOAuthRefresh: true,
        })[0];
      if (!selectedProfile) {
        throw new Error(
          "No authorized Ollama profile is available. Reconnect Ollama and retry setup.",
        );
      }
      const auth = await resolveApiKeyForProvider({
        provider: "ollama",
        cfg: params.cfg,
        profileId: selectedProfile,
        lockedProfile: true,
        store,
        agentDir: params.agentDir,
        signal: params.signal,
        assertRefreshAdmission: assertCurrent,
      });
      assertCurrent();
      apiKey = auth.apiKey && !isNonSecretApiKeyMarker(auth.apiKey) ? auth.apiKey : undefined;
    } else if (!isLocalOllamaBaseUrl(params.baseUrl)) {
      const value = (params.env ?? process.env).OLLAMA_API_KEY?.trim();
      apiKey = value && !isNonSecretApiKeyMarker(value) ? value : undefined;
    }
  }
  const http = saved
    ? resolveProviderHttpRequestConfigWithOriginTrust({
        provider: "ollama",
        baseUrl: params.baseUrl,
        defaultBaseUrl: OLLAMA_DEFAULT_BASE_URL,
        allowPrivateNetwork: request?.allowPrivateNetwork ?? true,
        defaultHeaders: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}),
        },
        request: sanitizeConfiguredModelProviderRequest({ ...request, headers }),
      })
    : undefined;
  return (options) =>
    fetchWithSsrFGuard({
      ...options,
      signal: params.signal
        ? options.signal
          ? AbortSignal.any([params.signal, options.signal])
          : params.signal
        : options.signal,
      ...(http
        ? {
            init: { ...options.init, headers: http.headers },
            policy: resolveProviderTransportSsrFPolicy({ ...http, url: options.url }),
            dispatcherPolicy: http.dispatcherPolicy,
          }
        : {}),
      beforeRequest: assertCurrent,
    });
}
