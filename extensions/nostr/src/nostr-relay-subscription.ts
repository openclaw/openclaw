import type { Event, SimplePool } from "nostr-tools";

const DEFAULT_EOSE_CONFIRM_DEADLINE_MS = 10_000;
const LIBRARY_EOSE_TIMEOUT_MARGIN_MS = 1_000;
// nostr-tools gives up on a socket that errors after connecting, so the group resubscribes.
const RESUBSCRIBE_BACKOFF_MS = [10_000, 20_000, 30_000, 60_000];
type BackfillStatus = "pending" | "confirmed" | "incomplete";

/** Separates real relay EOSE frames from nostr-tools timeout/close synthesis. */
export function createNostrRelaySubscriptionGroup(options: {
  pool: SimplePool;
  relays: string[];
  filter: Parameters<SimplePool["subscribeMany"]>[1];
  /** How far before the newest live event a resubscription replays (relay lag / clock skew). */
  replayLookbackSec: number;
  abort: AbortSignal;
  onEvent: (event: Event) => void;
  onBackfillComplete: (relays: string[]) => void;
  onClose: (relay: string, reasons: string[]) => void;
}) {
  const relays = [...new Set(options.relays)];
  const subscriptions = new Map<string, ReturnType<SimplePool["subscribeMany"]>>();
  const deadlineTimers = new Set<ReturnType<typeof setTimeout>>();
  const failures = new Map<string, number>();
  const newestLive = new Map<string, number>();
  let locallyClosing = false;
  const backfillStatus = new Map<string, BackfillStatus>(
    relays.map((relay): [string, BackfillStatus] => [relay, "pending"]),
  );

  const settleBackfill = (relay: string, status: "confirmed" | "incomplete"): void => {
    if (backfillStatus.get(relay) !== "pending") {
      return;
    }
    backfillStatus.set(relay, status);
    if ([...backfillStatus.values()].some((value) => value === "pending")) {
      return;
    }
    if ([...backfillStatus.values()].every((value) => value === "confirmed")) {
      options.onBackfillComplete(relays);
    }
  };

  const clearDeadlines = (): void => {
    for (const timer of deadlineTimers) {
      clearTimeout(timer);
    }
    deadlineTimers.clear();
  };

  const subscribeRelay = (relay: string): void => {
    let relayClosed = false;
    let deadlineReached = false;
    // Stored events may arrive in any order; only events after a real EOSE move the replay point.
    let live = false;
    const deadlineTimer = setTimeout(() => {
      deadlineTimers.delete(deadlineTimer);
      deadlineReached = true;
      settleBackfill(relay, "incomplete");
    }, DEFAULT_EOSE_CONFIRM_DEADLINE_MS);
    deadlineTimer.unref?.();
    deadlineTimers.add(deadlineTimer);

    // Replay a bounded window, like startup does, so already-processed history cannot flood
    // admission; durable ingress dedupes the overlap.
    const newest = newestLive.get(relay);
    const filter =
      newest === undefined
        ? options.filter
        : {
            ...options.filter,
            since: Math.max(options.filter.since ?? 0, newest - options.replayLookbackSec),
          };
    subscriptions.set(
      relay,
      options.pool.subscribeMany([relay], filter, {
        onevent: (event) => {
          if (live) {
            const createdAt = Math.min(event.created_at, Math.floor(Date.now() / 1000));
            newestLive.set(relay, Math.max(newestLive.get(relay) ?? 0, createdAt));
          }
          options.onEvent(event);
        },
        oneose: () => {
          // Pool close is reported as EOSE first. Its onclose runs in this same turn.
          queueMicrotask(() => {
            if (!relayClosed && !deadlineReached) {
              live = true;
              clearTimeout(deadlineTimer);
              deadlineTimers.delete(deadlineTimer);
              failures.delete(relay);
              settleBackfill(relay, "confirmed");
            }
          });
        },
        onclose: (reasons) => {
          relayClosed = true;
          clearTimeout(deadlineTimer);
          deadlineTimers.delete(deadlineTimer);
          settleBackfill(relay, "incomplete");
          if (!locallyClosing && !options.abort.aborted) {
            options.onClose(
              relay,
              reasons.map(({ reason }) => reason),
            );
            scheduleResubscribe(relay);
          }
        },
        // Own earlier deadline marks synthetic library EOSE as incomplete.
        maxWait: DEFAULT_EOSE_CONFIRM_DEADLINE_MS + LIBRARY_EOSE_TIMEOUT_MARGIN_MS,
        abort: options.abort,
      }),
    );
  };

  const scheduleResubscribe = (relay: string): void => {
    const attempt = failures.get(relay) ?? 0;
    failures.set(relay, attempt + 1);
    const timer = setTimeout(
      () => {
        deadlineTimers.delete(timer);
        if (!locallyClosing && !options.abort.aborted) {
          subscribeRelay(relay);
        }
      },
      RESUBSCRIBE_BACKOFF_MS[Math.min(attempt, RESUBSCRIBE_BACKOFF_MS.length - 1)],
    );
    timer.unref?.();
    deadlineTimers.add(timer);
  };

  return {
    start: (): void => {
      for (const relay of relays) {
        subscribeRelay(relay);
      }
    },
    close: async (reason: string): Promise<void> => {
      // nostr-tools reports caller-requested closes through the same callback as relay failures.
      locallyClosing = true;
      clearDeadlines();
      await Promise.all(
        [...subscriptions.values()].map(async (subscription) => subscription.close(reason)),
      );
    },
  };
}
