import {
  fetchWithSsrFGuard,
  shouldUseEnvHttpProxyForUrl,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "./openclaw-runtime-network.js";
import type { SsrFPolicy } from "./ssrf-policy.js";

export const MEMORY_REMOTE_TRUSTED_ENV_PROXY_MODE = "trusted_env_proxy";

export const buildRemoteBaseUrlPolicy: (baseUrl: string) => SsrFPolicy | undefined =
  ssrfPolicyFromHttpBaseUrlAllowedHostname;

export type RemoteHttpTimeoutMs = number | (() => number | undefined);

export function resolveRemoteHttpTimeoutMs(
  timeoutMs: RemoteHttpTimeoutMs | undefined,
): number | undefined {
  const value = typeof timeoutMs === "function" ? timeoutMs() : timeoutMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

export async function withRemoteHttpResponse<T>(params: {
  url: string;
  init?: RequestInit;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  fetchWithSsrFGuardImpl?: typeof fetchWithSsrFGuard;
  shouldUseEnvHttpProxyForUrlImpl?: typeof shouldUseEnvHttpProxyForUrl;
  auditContext?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onResponse: (response: Response) => Promise<T>;
}): Promise<T> {
  const guardedFetch = params.fetchWithSsrFGuardImpl ?? fetchWithSsrFGuard;
  const shouldUseEnvProxy = params.shouldUseEnvHttpProxyForUrlImpl ?? shouldUseEnvHttpProxyForUrl;
  const { response, release } = await guardedFetch({
    url: params.url,
    fetchImpl: params.fetchImpl,
    init: params.init,
    policy: params.ssrfPolicy,
    timeoutMs: params.timeoutMs,
    signal: params.signal ?? params.init?.signal ?? undefined,
    auditContext: params.auditContext ?? "memory-remote",
    ...(shouldUseEnvProxy(params.url) ? { mode: MEMORY_REMOTE_TRUSTED_ENV_PROXY_MODE } : {}),
  });
  try {
    return await params.onResponse(response);
  } finally {
    await release();
  }
}
