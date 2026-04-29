import { postJson } from "./post-json.js";
import { resolveRemoteHttpTimeoutMs, type RemoteHttpTimeoutMs } from "./remote-http.js";
import { retryAsync } from "./retry-utils.js";
import type { SsrFPolicy } from "./ssrf-policy.js";

const RETRY_ATTEMPTS = 3;
const RETRY_MIN_DELAY_MS = 300;
const RETRY_MAX_DELAY_MS = 2000;
const RETRY_JITTER = 0.2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryHttpStatus(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  return status === 429 || (typeof status === "number" && status >= 500);
}

function applyRetryJitter(delayMs: number): number {
  const offset = (Math.random() * 2 - 1) * RETRY_JITTER;
  return Math.max(0, Math.round(delayMs * (1 + offset)));
}

export async function postJsonWithRetry<T>(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  retryImpl?: typeof retryAsync;
  timeoutMs?: RemoteHttpTimeoutMs;
  signal?: AbortSignal;
  body: unknown;
  errorPrefix: string;
}): Promise<T> {
  const runPostJson = async () => {
    return await postJson<T>({
      url: params.url,
      headers: params.headers,
      ssrfPolicy: params.ssrfPolicy,
      fetchImpl: params.fetchImpl,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
      body: params.body,
      errorPrefix: params.errorPrefix,
      attachStatus: true,
      parse: async (payload) => payload as T,
    });
  };

  if (
    params.timeoutMs !== undefined &&
    !params.retryImpl &&
    resolveRemoteHttpTimeoutMs(params.timeoutMs) !== undefined
  ) {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
      resolveRemoteHttpTimeoutMs(params.timeoutMs);
      try {
        return await runPostJson();
      } catch (err) {
        lastErr = err;
        if (attempt >= RETRY_ATTEMPTS || !shouldRetryHttpStatus(err)) {
          break;
        }
        const remainingMs = resolveRemoteHttpTimeoutMs(params.timeoutMs);
        if (remainingMs === undefined) {
          break;
        }
        const baseDelay = Math.min(RETRY_MIN_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
        const delayMs = Math.min(applyRetryJitter(baseDelay), Math.max(0, remainingMs - 1));
        if (delayMs <= 0) {
          break;
        }
        await sleep(delayMs);
      }
    }
    throw lastErr ?? new Error("Retry failed");
  }

  const retry = params.retryImpl ?? retryAsync;
  return await retry(runPostJson, {
    attempts: RETRY_ATTEMPTS,
    minDelayMs: RETRY_MIN_DELAY_MS,
    maxDelayMs: RETRY_MAX_DELAY_MS,
    jitter: RETRY_JITTER,
    shouldRetry: shouldRetryHttpStatus,
  });
}
