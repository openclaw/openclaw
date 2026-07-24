// Memory Host SDK module implements post json behavior.
import { withRemoteHttpResponse } from "./remote-http.js";
import {
  readMemoryHostResponseTextSnippet,
  readResponseJsonWithLimit,
} from "./response-snippet.js";
import type { SsrFPolicy } from "./ssrf-policy.js";

// Shared JSON POST helper for guarded remote memory provider calls.

/**
 * Parses a Retry-After header value into delay-seconds.
 *
 * RFC 9110 § 10.2.3 defines two formats:
 * - delay-seconds: a non-negative decimal integer (e.g. "120")
 * - HTTP-date: an IMF-fixdate (e.g. "Wed, 21 Oct 2015 07:28:00 GMT")
 *
 * Returns 0 when the value is unparseable, not yet reached, or non-positive.
 */
function parseRetryAfterValue(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return 0;
  }

  // delay-seconds ("120")
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && /^\d+$/.test(trimmed)) {
    return Math.max(0, Math.floor(numeric));
  }

  // HTTP-date ("Wed, 21 Oct 2015 07:28:00 GMT")
  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) {
    return 0;
  }
  const delta = Math.ceil((dateMs - Date.now()) / 1000);
  return Math.max(0, delta);
}

/** POST JSON, parse bounded response JSON, and attach status metadata when requested. */
export async function postJson<T>(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  body: unknown;
  errorPrefix: string;
  attachStatus?: boolean;
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
        const text = await readMemoryHostResponseTextSnippet(res, { signal: params.signal });
        const err = new Error(`${params.errorPrefix}: ${res.status} ${text}`) as Error & {
          status?: number;
          retryAfterSeconds?: number;
        };
        if (params.attachStatus) {
          err.status = res.status;
          const retryAfter = res.headers.get("retry-after");
          if (retryAfter !== null) {
            const seconds = parseRetryAfterValue(retryAfter);
            if (seconds > 0) {
              err.retryAfterSeconds = seconds;
            }
          }
        }
        throw err;
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
