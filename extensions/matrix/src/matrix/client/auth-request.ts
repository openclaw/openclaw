import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { retryAsync } from "openclaw/plugin-sdk/retry-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import type { PinnedDispatcherPolicy } from "openclaw/plugin-sdk/ssrf-dispatcher";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MatrixResolvedConfig } from "./types.js";

export const loadMatrixAuthClientDeps = createLazyRuntimeModule(() =>
  Promise.all([import("../sdk.js"), import("./logging.js")]).then(([sdkModule, loggingModule]) => ({
    MatrixClient: sdkModule.MatrixClient,
    ensureMatrixSdkLoggingConfigured: loggingModule.ensureMatrixSdkLoggingConfigured,
  })),
);
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

export class MatrixWhoamiCleanupError extends AggregateError {}

export async function fetchMatrixWhoamiIdentity(params: {
  homeserver: string;
  accessToken: string;
  userId?: string;
  ssrfPolicy?: MatrixResolvedConfig["ssrfPolicy"];
  dispatcherPolicy?: PinnedDispatcherPolicy;
  signal?: AbortSignal;
}): Promise<MatrixWhoamiIdentity> {
  const { MatrixClient, ensureMatrixSdkLoggingConfigured } = await loadMatrixAuthClientDeps();
  params.signal?.throwIfAborted();
  ensureMatrixSdkLoggingConfigured();
  const tempClient = new MatrixClient(params.homeserver, params.accessToken, {
    userId: params.userId,
    ssrfPolicy: params.ssrfPolicy,
    dispatcherPolicy: params.dispatcherPolicy,
  });
  let stopping: Promise<void> | undefined;
  const stop = () => (stopping ??= tempClient.stopWithoutPersist());
  const onAbort = () => {
    // The finally path joins the same disposal and reports cleanup failures.
    void stop().catch(() => {});
  };
  params.signal?.addEventListener("abort", onAbort, { once: true });
  let outcome: { ok: true; value: MatrixWhoamiIdentity } | { ok: false; error: unknown };
  let cleanupFailure: { error: unknown } | undefined;
  try {
    params.signal?.throwIfAborted();
    const value = await retryMatrixAuthRequest(
      "matrix auth whoami",
      async () => {
        const identity = await tempClient.doRequest("GET", "/_matrix/client/v3/account/whoami");
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
    outcome = { ok: true, value };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    params.signal?.removeEventListener("abort", onAbort);
    try {
      await stop();
    } catch (error) {
      cleanupFailure = { error };
    }
  }
  if (cleanupFailure) {
    throw new MatrixWhoamiCleanupError(
      outcome.ok ? [cleanupFailure.error] : [outcome.error, cleanupFailure.error],
      "Matrix identity request cleanup failed",
      { cause: outcome.ok ? cleanupFailure.error : outcome.error },
    );
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}
