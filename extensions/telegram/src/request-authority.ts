import type { ApiClientOptions } from "grammy";
import { collectErrorGraphCandidates } from "openclaw/plugin-sdk/error-runtime";
import type { Dispatcher } from "undici";

const requestAuthority = Symbol("telegram.requestAuthority");
type RequestAuthority = { [requestAuthority]?: () => void };
type TelegramClientFetch = NonNullable<ApiClientOptions["fetch"]>;
type RequestInitWithDispatcher = RequestInit & { dispatcher?: Dispatcher };

/** Distinguish a local rejection from a network error wrapped by grammY. */
class TelegramRequestAuthorityError extends Error {
  readonly originalError: unknown;

  constructor(error: unknown) {
    super("Telegram request authority rejected");
    // Network classifiers must not treat the owner's rejection as a transport cause.
    this.originalError = error;
  }
}

export function findTelegramRequestAuthorityError(
  error: unknown,
): TelegramRequestAuthorityError | undefined {
  return collectErrorGraphCandidates(error, (current) => [current.cause, current.error]).find(
    (candidate) => candidate instanceof TelegramRequestAuthorityError,
  );
}

export function assertTelegramRequestAuthority(assertCurrent: (() => void) | undefined): void {
  try {
    assertCurrent?.();
  } catch (error) {
    throw new TelegramRequestAuthorityError(error);
  }
}

/** Keep the selected transport and guard every request, including Undici's HTTP 421 retry. */
export function bindTelegramTransportAuthority(
  fetchImpl: typeof fetch,
  assertCurrent: (() => void) | undefined,
): (
  input: RequestInfo | URL,
  init?: RequestInit,
  defaultDispatcher?: Dispatcher,
) => Promise<Response> {
  return (input, init, defaultDispatcher) => {
    // SAFETY: Caller-provided transport dispatchers follow Undici's Dispatcher contract.
    const callerDispatcher = (init as RequestInitWithDispatcher | undefined)?.dispatcher;
    let requestInit: RequestInitWithDispatcher | undefined = withoutTelegramRequestAuthority(init);
    if (!callerDispatcher && defaultDispatcher) {
      requestInit = { ...requestInit, dispatcher: defaultDispatcher };
    }
    if (!assertCurrent) {
      return fetchImpl(input, requestInit);
    }
    assertTelegramRequestAuthority(assertCurrent);
    const dispatcher = callerDispatcher ?? defaultDispatcher;
    if (dispatcher) {
      requestInit = {
        ...requestInit,
        dispatcher: dispatcher.compose((dispatch) => (options, handler) => {
          assertTelegramRequestAuthority(assertCurrent);
          return dispatch(options, handler);
        }),
      };
    }
    return fetchImpl(input, requestInit).catch((error: unknown) => {
      // Restore our rejection before transport or grammY classifies the fetch error.
      throw findTelegramRequestAuthorityError(error) ?? error;
    });
  };
}

/** Keep operation authority off the shared client's cached fetch options. */
export function bindTelegramRequestAuthority(
  fetchImpl: TelegramClientFetch,
  assertCurrent: () => void,
): TelegramClientFetch {
  const guardedFetch = (
    input: Parameters<TelegramClientFetch>[0],
    init?: Parameters<TelegramClientFetch>[1],
  ) => {
    const guardedInit = { ...init, [requestAuthority]: assertCurrent };
    return fetchImpl(input, guardedInit);
  };
  return Object.assign(guardedFetch, fetchImpl);
}

export function getTelegramRequestAuthority(init: object | undefined): (() => void) | undefined {
  // SAFETY: Only bindTelegramRequestAuthority writes this module-private symbol.
  return (init as RequestAuthority | undefined)?.[requestAuthority];
}

/** The private callback travels between our retry layers, never to the HTTP client. */
export function withoutTelegramRequestAuthority<T extends object>(
  init: T | undefined,
): T | undefined {
  if (!init || !(requestAuthority in init)) {
    return init;
  }
  const requestInit: T & Partial<Record<typeof requestAuthority, unknown>> = { ...init };
  delete requestInit[requestAuthority];
  return requestInit;
}
