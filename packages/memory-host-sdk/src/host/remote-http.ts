// Memory Host SDK module implements remote http behavior.
import {
  assertHostnameAllowedWithPolicy,
  createHttp1EnvHttpProxyAgent,
  fetchWithResponseRelease,
  matchesHostnameAllowlist,
  normalizeHostname,
  normalizeHostnameAllowlist,
  shouldUseEnvHttpProxyForUrl,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "./openclaw-runtime-network.js";
import type { SsrFPolicy } from "./ssrf-policy.js";

// Remote memory HTTP wrapper that releases response bodies after callers finish reading.

/** Build an SSRF allow policy from a configured remote base URL. */
export const buildRemoteBaseUrlPolicy: (baseUrl: string) => SsrFPolicy | undefined =
  ssrfPolicyFromHttpBaseUrlAllowedHostname;

function assertRemoteUrlAllowedByPolicy(url: URL, policy: SsrFPolicy): void {
  const hostnameAllowlist = normalizeHostnameAllowlist([
    ...(policy.allowedHostnames ?? []),
    ...(policy.hostnameAllowlist ?? []),
  ]);
  if (hostnameAllowlist.length > 0) {
    const hostname = normalizeHostname(url.hostname);
    if (!matchesHostnameAllowlist(hostname, hostnameAllowlist)) {
      throw new Error(`Blocked hostname (not in allowlist): ${url.hostname}`);
    }
  }
  assertHostnameAllowedWithPolicy(url.hostname, policy);
}

type CloseableRemoteHttpDispatcher = {
  close?: () => Promise<void> | void;
};

function hasRequestDispatcher(init: RequestInit | undefined): boolean {
  return Boolean(init && "dispatcher" in init && (init as { dispatcher?: unknown }).dispatcher);
}

async function closeRemoteHttpDispatcher(
  dispatcher: CloseableRemoteHttpDispatcher | undefined,
): Promise<void> {
  await dispatcher?.close?.();
}

/** Execute a remote HTTP request and always release the response handle. */
export async function withRemoteHttpResponse<T>(params: {
  url: string;
  init?: RequestInit;
  signal?: AbortSignal;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  auditContext?: string;
  onResponse: (response: Response) => Promise<T>;
}): Promise<T> {
  const policy = params.ssrfPolicy;
  const validateUrl = policy
    ? (parsed: URL) => {
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error("Remote memory HTTP only supports http and https URLs");
        }
        assertRemoteUrlAllowedByPolicy(parsed, policy);
      }
    : undefined;
  if (validateUrl) {
    validateUrl(new URL(params.url));
  }
  const dispatcher =
    !hasRequestDispatcher(params.init) && shouldUseEnvHttpProxyForUrl(params.url)
      ? createHttp1EnvHttpProxyAgent()
      : undefined;
  let result: Awaited<ReturnType<typeof fetchWithResponseRelease>>;
  try {
    result = await fetchWithResponseRelease({
      url: params.url,
      fetchImpl: params.fetchImpl,
      init: dispatcher ? ({ ...params.init, dispatcher } as RequestInit) : params.init,
      signal: params.signal,
      validateUrl,
    });
  } catch (error) {
    await closeRemoteHttpDispatcher(dispatcher);
    throw error;
  }
  const { response, release } = result;
  try {
    return await params.onResponse(response);
  } finally {
    await release();
    await closeRemoteHttpDispatcher(dispatcher);
  }
}
