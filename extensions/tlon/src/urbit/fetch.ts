// Tlon plugin module implements fetch behavior.

import { fetchWithResponseRelease } from "openclaw/plugin-sdk/fetch-runtime";
import { resolvePinnedHostnameWithPolicy } from "openclaw/plugin-sdk/security-runtime";
import type { LookupFn, NetworkTargetPolicy } from "openclaw/plugin-sdk/security-runtime";
import { validateUrbitBaseUrl } from "./base-url.js";
import { UrbitUrlError } from "./errors.js";

type UrbitFetchOptions = {
  baseUrl: string;
  path: string;
  init?: RequestInit;
  ssrfPolicy?: NetworkTargetPolicy;
  lookupFn?: LookupFn;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
};

export async function urbitFetch(params: UrbitFetchOptions) {
  const validated = validateUrbitBaseUrl(params.baseUrl);
  if (!validated.ok) {
    throw new UrbitUrlError(validated.error);
  }

  const url = new URL(params.path, validated.baseUrl).toString();
  const validateUrl = async (nextUrl: URL) => {
    await resolvePinnedHostnameWithPolicy(nextUrl.hostname, {
      lookupFn: params.lookupFn,
      policy: params.ssrfPolicy,
    });
  };
  return await fetchWithResponseRelease({
    url,
    fetchImpl: params.fetchImpl,
    init: params.init,
    maxRedirects: params.maxRedirects,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
    validateUrl,
  });
}
