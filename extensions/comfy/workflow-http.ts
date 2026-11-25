import { resolvePositiveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import {
  assertOkOrThrowHttpError,
  readProviderJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";

type ComfyDispatcherPolicy = Parameters<typeof fetchWithSsrFGuard>[0]["dispatcherPolicy"];

export async function readJsonResponse<T>(params: {
  url: string;
  init?: RequestInit;
  timeoutMs: number;
  deadline: number;
  policy?: SsrFPolicy;
  dispatcherPolicy?: ComfyDispatcherPolicy;
  auditContext: string;
  errorPrefix: string;
}): Promise<T> {
  const { errorPrefix, deadline, timeoutMs, ...request } = params;
  const remainingMs = () => resolveComfyRemainingMs(deadline, timeoutMs);
  const { response, release } = await fetchWithSsrFGuard({ ...request, timeoutMs: remainingMs() });
  try {
    const requestHeaders = params.init?.headers;
    await assertOkOrThrowHttpError(response, errorPrefix, {
      requestHeaders,
      bodyTimeoutMs: remainingMs,
      onBodyTimeout: () => createComfyTimeoutError(timeoutMs),
    });
    return await readProviderJsonResponse<T>(response, errorPrefix, {
      requestHeaders,
      timeoutMs: remainingMs,
      onTimeout: () => createComfyTimeoutError(timeoutMs),
    });
  } finally {
    await release();
  }
}

export function createComfyTimeoutError(timeoutMs: number) {
  return new Error(`Comfy workflow did not finish within ${Math.ceil(timeoutMs / 1000)}s`);
}

export function resolveComfyRemainingMs(
  deadline: number,
  timeoutMs: number,
  defaultTimeoutMs = timeoutMs,
) {
  const defaultMs = resolvePositiveTimerTimeoutMs(defaultTimeoutMs, 1);
  const remainingMs = deadline - performance.now();
  if (remainingMs <= 0) {
    throw createComfyTimeoutError(timeoutMs);
  }
  return Math.max(1, Math.min(defaultMs, remainingMs));
}
