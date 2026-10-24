import type { ApiClientOptions } from "grammy";
import { captureEffectAuthority, responseWithRelease } from "openclaw/plugin-sdk/fetch-runtime";
import { extractTelegramApiMethod } from "./api-root.js";
import type { TelegramTransport } from "./fetch.js";
import {
  isTelegramMisdirectedRequestError,
  TelegramRequestNotStartedError,
} from "./network-errors.js";
import {
  assertTelegramRequestAuthority,
  findTelegramRequestAuthorityError,
  getTelegramRequestAuthority,
  withoutTelegramRequestAuthority,
} from "./request-authority.js";
import { getTelegramUploadBytes, resolveTelegramRequestTimeoutMs } from "./request-timeouts.js";

type TelegramFetchInput = Parameters<NonNullable<ApiClientOptions["fetch"]>>[0];
type TelegramFetchInit = Parameters<NonNullable<ApiClientOptions["fetch"]>>[1];
type TelegramClientFetch = NonNullable<ApiClientOptions["fetch"]>;
type TelegramCompatFetch = (
  input: TelegramFetchInput,
  init?: TelegramFetchInit,
) => Promise<Response>;
type TelegramAbortSignalLike = {
  aborted: boolean;
  reason?: unknown;
  addEventListener: (type: "abort", listener: () => void, options?: { once?: boolean }) => void;
  removeEventListener: (type: "abort", listener: () => void) => void;
};

export function asTelegramClientFetch(
  fetchImpl: TelegramCompatFetch | typeof globalThis.fetch,
): TelegramClientFetch {
  return fetchImpl as unknown as TelegramClientFetch;
}

function isTelegramAbortSignalLike(value: unknown): value is TelegramAbortSignalLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "aborted" in value &&
    typeof (value as { aborted?: unknown }).aborted === "boolean" &&
    typeof (value as { addEventListener?: unknown }).addEventListener === "function" &&
    typeof (value as { removeEventListener?: unknown }).removeEventListener === "function"
  );
}

const TELEGRAM_TIMEOUT_FALLBACK_METHODS = new Set([
  "deletemycommands",
  "deletewebhook",
  "getme",
  "sendchataction",
  "setmycommands",
  "setwebhook",
]);

export function createTelegramClientFetch(params: {
  fetchImpl: TelegramClientFetch;
  timeoutSeconds?: unknown;
  shutdownSignal?: unknown;
  transport?: Partial<Pick<TelegramTransport, "forceFallback" | "sourceFetch">>;
}): TelegramCompatFetch {
  const callFetch = params.fetchImpl as unknown as TelegramCompatFetch;
  const isRawSourceFetch =
    params.transport?.sourceFetch !== undefined &&
    params.fetchImpl === asTelegramClientFetch(params.transport.sourceFetch);
  return async (input: TelegramFetchInput, init?: TelegramFetchInit) => {
    const effect = captureEffectAuthority();
    const assertCurrent = getTelegramRequestAuthority(init);
    const method = extractTelegramApiMethod(input);
    const requestTimeoutMs = resolveTelegramRequestTimeoutMs(
      method,
      params.timeoutSeconds,
      getTelegramUploadBytes(),
    );
    const shutdownSignal = isTelegramAbortSignalLike(params.shutdownSignal)
      ? params.shutdownSignal
      : undefined;
    const requestSignal = isTelegramAbortSignalLike(init?.signal) ? init.signal : undefined;

    const canForceTransportFallback = (reason: string) =>
      !shutdownSignal?.aborted &&
      !requestSignal?.aborted &&
      params.transport?.forceFallback?.(reason) === true;

    const runFetch = async (allowMisdirectedFallback = false): Promise<Response> => {
      assertTelegramRequestAuthority(assertCurrent);
      const controller = new AbortController();
      let requestTimeout: ReturnType<typeof setTimeout> | undefined;
      let requestTimedOut = false;
      const timeoutError =
        requestTimeoutMs !== undefined
          ? new Error(`Telegram ${method} timed out after ${requestTimeoutMs}ms`)
          : undefined;

      const abortListeners = [shutdownSignal, requestSignal].flatMap((signal) => {
        if (!signal) {
          return [];
        }
        const abort = () => controller.abort(signal.reason);
        if (signal.aborted) {
          abort();
        } else {
          signal.addEventListener("abort", abort, { once: true });
        }
        return [{ signal, abort }];
      });
      if (requestTimeoutMs && timeoutError) {
        requestTimeout = setTimeout(() => {
          requestTimedOut = true;
          controller.abort(timeoutError);
        }, requestTimeoutMs);
        requestTimeout.unref?.();
      }

      const releaseRequest = async () => {
        if (requestTimeout) {
          clearTimeout(requestTimeout);
        }
        for (const { signal, abort } of abortListeners) {
          signal.removeEventListener("abort", abort);
        }
      };

      try {
        const request = () => {
          assertTelegramRequestAuthority(assertCurrent);
          controller.signal.throwIfAborted();
          return callFetch(input, {
            ...(isRawSourceFetch ? withoutTelegramRequestAuthority(init) : init),
            signal: controller.signal,
          });
        };
        const response = await (isRawSourceFetch ? effect.initiate(request) : request());
        if (response.status === 421) {
          const retry =
            allowMisdirectedFallback && canForceTransportFallback("misdirected-request");
          // HTTP 421 permits retrying a non-idempotent request;
          // arbitrary thrown 421 shapes do not own that fact.
          await response.body?.cancel().catch(() => undefined);
          if (retry) {
            await releaseRequest();
            return runFetch();
          }
          throw new TelegramRequestNotStartedError();
        }
        // grammY consumes JSON after fetch resolves; keep its deadline and
        // cancellation linked until the response body settles.
        return responseWithRelease(response, releaseRequest);
      } catch (err) {
        await releaseRequest();
        if (requestTimedOut && timeoutError) {
          throw timeoutError;
        }
        throw err;
      }
    };

    try {
      return await runFetch(true);
    } catch (err) {
      if (findTelegramRequestAuthorityError(err)) {
        throw err;
      }
      if (
        (requestTimeoutMs &&
          method !== null &&
          TELEGRAM_TIMEOUT_FALLBACK_METHODS.has(method) &&
          canForceTransportFallback("request-timeout")) ||
        (isTelegramMisdirectedRequestError(err) && canForceTransportFallback("misdirected-request"))
      ) {
        return await runFetch();
      }
      throw err;
    }
  };
}
