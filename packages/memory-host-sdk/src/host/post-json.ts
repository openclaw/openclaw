import { createProviderHttpError, type SsrFPolicy } from "./openclaw-runtime-network.js";
import { withRemoteHttpResponse } from "./remote-http.js";
import { readResponseJsonWithLimit } from "./response-snippet.js";

// Shared JSON POST helper for guarded remote memory provider calls.

/** POST JSON, parse bounded response JSON, and preserve provider error metadata. */
export async function postJson<T>(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  body: unknown;
  errorPrefix: string;
  maxResponseBytes?: number;
  parse: (payload: unknown) => T | Promise<T>;
}): Promise<T> {
  return await withRemoteHttpResponse({
    url: params.url,
    ssrfPolicy: params.ssrfPolicy,
    fetchImpl: params.fetchImpl,
    signal: params.signal,
    init: {
      method: "POST",
      headers: params.headers,
      body: JSON.stringify(params.body),
    },
    onResponse: async (res) => {
      if (!res.ok) {
        throw await createProviderHttpError(res, params.errorPrefix, {
          requestHeaders: params.headers,
          signal: params.signal,
          maxBodyBytes: 8 * 1024,
        });
      }
      const payload = await readResponseJsonWithLimit(res, {
        errorPrefix: params.errorPrefix,
        maxBytes: params.maxResponseBytes,
        signal: params.signal,
      });
      return await params.parse(payload);
    },
  });
}
