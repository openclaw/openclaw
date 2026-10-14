import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  fetchWithSsrFGuard,
  shouldUseEnvHttpProxyForUrl,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "./openclaw-runtime-network.js";
import type { SsrFPolicy } from "./openclaw-runtime-network.js";

// Remote memory HTTP wrapper that applies SSRF policy and releases guarded sockets.

/** Proxy mode used only for URLs that the runtime classified as env-proxy safe. */
const MEMORY_REMOTE_TRUSTED_ENV_PROXY_MODE = "trusted_env_proxy";

/** Resolve current credentials for one request, or refresh after an expired-token rejection. */
export type RemoteEmbeddingRequestAuth = (params: {
  forceRefresh: boolean;
  signal?: AbortSignal;
}) => Promise<Record<string, string>>;

/** Build an SSRF allow policy from a configured remote base URL. */
export const buildRemoteBaseUrlPolicy: (baseUrl: string) => SsrFPolicy | undefined =
  ssrfPolicyFromHttpBaseUrlAllowedHostname;

/** Execute a remote HTTP request under SSRF guard and always release the response handle. */
export async function withRemoteHttpResponse<T>(params: {
  url: string;
  init?: RequestInit;
  signal?: AbortSignal;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  resolveRequestHeaders?: RemoteEmbeddingRequestAuth;
  fetchWithSsrFGuardImpl?: typeof fetchWithSsrFGuard;
  shouldUseEnvHttpProxyForUrlImpl?: typeof shouldUseEnvHttpProxyForUrl;
  auditContext?: string;
  onResponse: (response: Response, requestHeaders?: HeadersInit) => Promise<T>;
}): Promise<T> {
  const guardedFetch = params.fetchWithSsrFGuardImpl ?? fetchWithSsrFGuard;
  const shouldUseEnvProxy = params.shouldUseEnvHttpProxyForUrlImpl ?? shouldUseEnvHttpProxyForUrl;
  const request = async (forceRefresh: boolean): Promise<T> => {
    params.signal?.throwIfAborted();
    let init = params.init;
    if (params.resolveRequestHeaders) {
      const authHeaders = await params.resolveRequestHeaders({
        forceRefresh,
        signal: params.signal,
      });
      params.signal?.throwIfAborted();
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(authHeaders)) {
        headers.set(name, value);
      }
      init = { ...init, headers };
    }
    const { response, release, finalUrl } = await guardedFetch({
      url: params.url,
      fetchImpl: params.fetchImpl,
      init,
      signal: params.signal,
      policy: params.ssrfPolicy,
      auditContext: params.auditContext ?? "memory-remote",
      ...(shouldUseEnvProxy(params.url) ? { mode: MEMORY_REMOTE_TRUSTED_ENV_PROXY_MODE } : {}),
    });
    try {
      return await params.onResponse(response, init?.headers);
    } catch (error) {
      if (
        !params.resolveRequestHeaders ||
        forceRefresh ||
        response.status !== 401 ||
        new URL(finalUrl).origin !== new URL(params.url).origin ||
        asOptionalRecord(error)?.code !== "token_expired"
      ) {
        throw error;
      }
    } finally {
      await release();
    }
    // Release the rejected request before refreshing; never replay a batch lifecycle.
    return await request(true);
  };
  return await request(false);
}
