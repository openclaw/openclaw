// Notification dedup for the mail-wake plugin. Graph delivers at-least-once,
// so identical notifications are claimed once: the leader schedules the wake,
// concurrent followers attach to the leader's completion, and successful
// completions are remembered only for a bounded TTL — a permanent record
// would suppress legitimate repeated updates to the same message.
export const GRAPH_WAKE_DEDUP_COMPLETED_TTL_MS = 5 * 60_000;
export const GRAPH_WAKE_DEDUP_MAX_COMPLETED_ENTRIES = 1000;

// Durable replay claims and successful completion keys are intentionally
// deferred to a separately reviewed follow-up. Current behavior matches the
// Gmail hook bar: bounded process-local replay protection, not exactly-once.

export type GraphWakeDedupeOutcome = {
  wakeId?: string;
};

export type GraphWakeDedupeClaim =
  | {
      kind: "leader";
      complete: (outcome: GraphWakeDedupeOutcome) => void;
      fail: () => void;
    }
  | { kind: "shared"; completion: Promise<GraphWakeDedupeOutcome | null> }
  | { kind: "duplicate"; wakeId?: string };

export type GraphWakeDedupe = {
  claim: (key: string) => GraphWakeDedupeClaim;
};

export function createGraphWakeDedupe(params?: {
  ttlMs?: number;
  now?: () => number;
}): GraphWakeDedupe {
  const ttlMs = params?.ttlMs ?? GRAPH_WAKE_DEDUP_COMPLETED_TTL_MS;
  const now = params?.now ?? (() => Date.now());
  const inFlight = new Map<string, Promise<GraphWakeDedupeOutcome | null>>();
  const completed = new Map<string, { wakeId?: string; expiresAt: number }>();

  const readCompleted = (key: string): { wakeId?: string } | undefined => {
    const entry = completed.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= now()) {
      completed.delete(key);
      return undefined;
    }
    return entry.wakeId ? { wakeId: entry.wakeId } : {};
  };

  return {
    claim: (key) => {
      const previous = readCompleted(key);
      if (previous) {
        return { kind: "duplicate", ...(previous.wakeId ? { wakeId: previous.wakeId } : {}) };
      }
      const pending = inFlight.get(key);
      if (pending) {
        return { kind: "shared", completion: pending };
      }

      let settle: (outcome: GraphWakeDedupeOutcome | null) => void = () => {};
      const completion = new Promise<GraphWakeDedupeOutcome | null>((resolve) => {
        settle = resolve;
      });
      inFlight.set(key, completion);

      return {
        kind: "leader",
        complete: (outcome) => {
          inFlight.delete(key);
          if (completed.size >= GRAPH_WAKE_DEDUP_MAX_COMPLETED_ENTRIES) {
            const oldest = completed.keys().next();
            if (!oldest.done) {
              completed.delete(oldest.value);
            }
          }
          completed.set(key, {
            ...(outcome.wakeId ? { wakeId: outcome.wakeId } : {}),
            expiresAt: now() + ttlMs,
          });
          settle(outcome);
        },
        fail: () => {
          // A failed attempt records nothing: the next delivery becomes the
          // leader and retries the wake instead of deduping against a wake
          // that never happened.
          inFlight.delete(key);
          settle(null);
        },
      };
    },
  };
}
