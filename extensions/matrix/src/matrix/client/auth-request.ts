import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { retryAsync } from "openclaw/plugin-sdk/retry-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import type { PinnedDispatcherPolicy } from "openclaw/plugin-sdk/ssrf-dispatcher";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMatrixLocalTimeoutMs } from "../sdk/client-support.js";
import type { MatrixResolvedConfig } from "./types.js";

const MATRIX_AUTH_REQUEST_RETRY_RE =
  /\b(fetch failed|econnreset|econnrefused|enotfound|etimedout|ehostunreach|enetunreach|eai_again|und_err_|socket hang up|network|headers timeout|body timeout|connect timeout)\b/i;

export async function retryMatrixAuthRequest<T>(
  label: string,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return await retryAsync(run, {
    attempts: 3,
    minDelayMs: 250,
    maxDelayMs: 1_500,
    jitter: 0.1,
    label,
    shouldRetry: (err) => MATRIX_AUTH_REQUEST_RETRY_RE.test(formatErrorMessage(err)),
    sleep: (ms) => sleepWithAbort(ms, signal),
  });
}

type MatrixWhoamiIdentity = { user_id?: string; device_id?: string };

export async function fetchMatrixWhoamiIdentity(params: {
  homeserver: string;
  accessToken: string;
  ssrfPolicy?: MatrixResolvedConfig["ssrfPolicy"];
  dispatcherPolicy?: PinnedDispatcherPolicy;
  signal?: AbortSignal;
}): Promise<MatrixWhoamiIdentity> {
  const { MatrixAuthedHttpClient } = await import("../sdk/http-client.js");
  params.signal?.throwIfAborted();
  const client = new MatrixAuthedHttpClient({
    homeserver: params.homeserver,
    accessToken: params.accessToken,
    ssrfPolicy: params.ssrfPolicy,
    dispatcherPolicy: params.dispatcherPolicy,
    signal: params.signal,
  });
  return await retryMatrixAuthRequest(
    "matrix auth whoami",
    async () => {
      const identity = await client.requestJson({
        method: "GET",
        endpoint: "/_matrix/client/v3/account/whoami",
        timeoutMs: resolveMatrixLocalTimeoutMs(undefined),
      });
      if (!isRecord(identity)) {
        throw new Error("Matrix whoami returned an invalid identity");
      }
      const userId = identity.user_id ?? undefined;
      const deviceId = identity.device_id ?? undefined;
      if (
        (userId !== undefined && typeof userId !== "string") ||
        (deviceId !== undefined && typeof deviceId !== "string")
      ) {
        throw new Error("Matrix whoami returned an invalid identity");
      }
      return { user_id: userId, device_id: deviceId };
    },
    params.signal,
  );
}
