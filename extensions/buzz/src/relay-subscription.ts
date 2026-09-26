import type { Event, Filter, Relay } from "nostr-tools";

type BuzzRelaySubscriptionParams = Omit<Parameters<Relay["prepareSubscription"]>[1], "abort">;

// NIP-01 gives CLOSED a machine-readable prefix. `rate-limited:` is the one the
// relay uses to refuse a request it invites the client to repeat, and Buzz appends
// its own hint: "rate-limited: quota exceeded; retry in 2s".
const BUZZ_RELAY_RATE_LIMITED_PREFIX = "rate-limited:";
const BUZZ_RELAY_RETRY_HINT = /retry in (\d+(?:\.\d+)?)\s*(ms|s|m)\b/i;
const BUZZ_RELAY_RETRY_HINT_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
};
const BUZZ_RELAY_RATE_LIMIT_DEFAULT_RETRY_MS = 2_000;
// Retrying before the relay's own window clears only spends the retry budget, so honor
// the hint. The ceiling guards against a malformed hint parking catch-up for hours;
// callers wait on an abortable timer, so closing the bus never waits this long.
const BUZZ_RELAY_RATE_LIMIT_MAX_RETRY_MS = 5 * 60_000;

/** A relay CLOSED frame for one subscription. The connection itself stays up. */
class BuzzRelaySubscriptionClosedError extends Error {
  readonly reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = "BuzzRelaySubscriptionClosedError";
    this.reason = reason;
  }
}

/**
 * How long a rate-limited close asks the caller to wait, or undefined when the close
 * is not retryable. A relay that names its own delay is asking for the request again,
 * not reporting a broken connection.
 */
export function resolveBuzzRelayRetryDelayMs(error: unknown): number | undefined {
  if (!(error instanceof BuzzRelaySubscriptionClosedError)) {
    return undefined;
  }
  const reason = error.reason.trim().toLowerCase();
  if (!reason.startsWith(BUZZ_RELAY_RATE_LIMITED_PREFIX)) {
    return undefined;
  }
  const hint = BUZZ_RELAY_RETRY_HINT.exec(reason);
  if (!hint?.[1] || !hint[2]) {
    return BUZZ_RELAY_RATE_LIMIT_DEFAULT_RETRY_MS;
  }
  const delayMs = Number(hint[1]) * (BUZZ_RELAY_RETRY_HINT_UNIT_MS[hint[2]] ?? 1_000);
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return BUZZ_RELAY_RATE_LIMIT_DEFAULT_RETRY_MS;
  }
  return Math.min(delayMs, BUZZ_RELAY_RATE_LIMIT_MAX_RETRY_MS);
}

type BuzzRelaySnapshotParams<TResult> = {
  relay: Relay;
  filters: Filter[];
  signal?: AbortSignal;
  timeoutMs?: number;
  timeoutMessage: string;
  abortMessage: string;
  failureMessage: string;
  closeReason: string;
  closeMessage: (reason: string) => string;
  onEvent: (event: Event) => void;
  result: () => TResult;
  onTimeout?: (error: Error) => void;
  closeRelayOnTimeout?: boolean;
  checkAbortAfterSubscribe?: boolean;
};

export function openBuzzRelaySubscription(
  relay: Relay,
  filters: Filter[],
  params: BuzzRelaySubscriptionParams,
  requestFilters: Filter[] = filters,
): ReturnType<Relay["prepareSubscription"]> {
  // Relay.subscribe() synthesizes EOSE after 4.4 seconds. Buzz needs the relay's
  // real EOSE before replacing or closing subscriptions, otherwise an async REQ
  // can register after CLOSE and remain orphaned on the server.
  relay.idleSince = undefined;
  relay.ongoingOperations += 1;

  let subscription: ReturnType<Relay["prepareSubscription"]>;
  try {
    subscription = relay.prepareSubscription(filters, params);
  } catch (error) {
    relay.ongoingOperations -= 1;
    if (relay.ongoingOperations === 0) {
      relay.idleSince = Date.now();
      relay.scheduleIdleClose();
    }
    throw error;
  }

  // Buzz can route on stored channel metadata absent from signed event tags.
  // Gateway owns reconnects; nostr-tools automatic refires must stay disabled
  // so fresh sessions keep these wire filters separate from client validation.
  const frame = JSON.stringify(["REQ", subscription.id, ...requestFilters]);
  void relay.send(frame).catch((error: unknown) => {
    if (subscription.closed || relay.openSubs.get(subscription.id) !== subscription) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    subscription.close(`Buzz relay subscription request failed: ${message}`);
  });
  return subscription;
}

export async function queryBuzzRelaySnapshot<TResult>(
  params: BuzzRelaySnapshotParams<TResult>,
): Promise<TResult> {
  return await new Promise<TResult>((resolve, reject) => {
    let settled = false;
    let receivedEose = false;
    let subscriptionClosed = false;
    let subscription: ReturnType<Relay["prepareSubscription"]> | undefined;
    const timeout = setTimeout(() => {
      const error = new Error(params.timeoutMessage);
      finish(error);
      params.onTimeout?.(error);
      if (params.closeRelayOnTimeout !== false) {
        params.relay.close();
      }
    }, params.timeoutMs ?? 10_000);
    const closeAfterRealEose = () => {
      if (receivedEose && subscription && !subscriptionClosed) {
        subscriptionClosed = true;
        subscription.close(params.closeReason);
      }
    };
    const finish = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", onAbort);
      closeAfterRealEose();
      if (error === undefined) {
        resolve(params.result());
      } else {
        reject(error instanceof Error ? error : new Error(params.failureMessage, { cause: error }));
      }
    };
    const onAbort = () => finish(params.signal?.reason ?? new Error(params.abortMessage));
    params.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      subscription = openBuzzRelaySubscription(params.relay, params.filters, {
        onevent: params.onEvent,
        oneose: () => {
          receivedEose = true;
          if (settled) {
            closeAfterRealEose();
          } else {
            finish();
          }
        },
        onclose: (reason) => {
          if (reason !== params.closeReason) {
            finish(new BuzzRelaySubscriptionClosedError(params.closeMessage(reason), reason));
          }
        },
      });
    } catch (error) {
      finish(error);
      return;
    }
    closeAfterRealEose();
    if (params.checkAbortAfterSubscribe && params.signal?.aborted) {
      onAbort();
    }
  });
}
