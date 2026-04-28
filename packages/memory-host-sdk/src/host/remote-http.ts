import {
  getMemoryHostServices,
  MEMORY_REMOTE_TRUSTED_ENV_PROXY_MODE,
  type MemoryHostGuardedFetch,
} from "./services.js";
import type { SsrFPolicy } from "./ssrf-policy.js";

export { MEMORY_REMOTE_TRUSTED_ENV_PROXY_MODE };

export const buildRemoteBaseUrlPolicy: (baseUrl: string) => SsrFPolicy | undefined = (baseUrl) =>
  getMemoryHostServices().network.buildRemoteBaseUrlPolicy(baseUrl);

export async function withRemoteHttpResponse<T>(params: {
  url: string;
  init?: RequestInit;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  fetchWithSsrFGuardImpl?: MemoryHostGuardedFetch;
  shouldUseEnvHttpProxyForUrlImpl?: (url: string) => boolean;
  auditContext?: string;
  onResponse: (response: Response) => Promise<T>;
}): Promise<T> {
  const services = getMemoryHostServices().network;
  const guardedFetch = params.fetchWithSsrFGuardImpl ?? services.fetchWithSsrFGuard;
  const shouldUseEnvProxy =
    params.shouldUseEnvHttpProxyForUrlImpl ??
    ((url: string) => services.shouldUseEnvHttpProxyForUrl(url));
  const guardedResponse = await guardedFetch({
    url: params.url,
    fetchImpl: params.fetchImpl,
    init: params.init,
    policy: params.ssrfPolicy,
    auditContext: params.auditContext ?? "memory-remote",
    ...(shouldUseEnvProxy(params.url) ? { mode: MEMORY_REMOTE_TRUSTED_ENV_PROXY_MODE } : {}),
  });
  try {
    return await params.onResponse(guardedResponse.response);
  } finally {
    await guardedResponse.release();
  }
}
