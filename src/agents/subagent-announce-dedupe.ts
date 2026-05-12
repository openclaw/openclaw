import { defaultRuntime } from "../runtime.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";

// Defense-in-depth dedup for `deliverSubagentAnnouncement`. The gateway already
// dedupes agent runs by `agent:${idempotencyKey}` and the run registry guards
// re-announce with `completionAnnouncedAt`, but those guards can be bypassed
// when concurrent lifecycle/retry paths race for the same announce or when the
// gateway dedup window has rolled over. Without a process-local guard each
// race produces a second user-facing post in the requester's channel.
//
// Keyed by `directIdempotencyKey` (built from the child session+run, so it is
// stable across retries for the same announce). In-flight promises are
// coalesced so concurrent callers share a single dispatch. Only delivered
// results are cached; failed dispatches stay retryable.

const DEFAULT_TTL_MS = 5 * 60_000;

type CachedResult = {
  result: SubagentAnnounceDeliveryResult;
  ts: number;
};

type AnnounceDedupeState = {
  ttlMs: number;
  delivered: Map<string, CachedResult>;
  inflight: Map<string, Promise<SubagentAnnounceDeliveryResult>>;
};

function createState(ttlMs = DEFAULT_TTL_MS): AnnounceDedupeState {
  return {
    ttlMs,
    delivered: new Map(),
    inflight: new Map(),
  };
}

let state = createState();

function isExpired(entry: CachedResult, now: number, ttlMs: number): boolean {
  return ttlMs <= 0 || now - entry.ts >= ttlMs;
}

function getCachedDelivered(key: string): SubagentAnnounceDeliveryResult | undefined {
  const entry = state.delivered.get(key);
  if (!entry) {
    return undefined;
  }
  if (isExpired(entry, Date.now(), state.ttlMs)) {
    state.delivered.delete(key);
    return undefined;
  }
  return entry.result;
}

// Namespace caller keys so different call sites (lifecycle announce vs.
// media-generate vs. orphan recovery) cannot collide even if a future tool
// happens to produce a key string that overlaps with another path's shape.
const KEY_NAMESPACE = "deliverSubagentAnnouncement:";

function namespaceKey(key: string): string {
  return `${KEY_NAMESPACE}${key}`;
}

export async function runDedupedAnnounceDelivery(
  key: string | undefined,
  run: () => Promise<SubagentAnnounceDeliveryResult>,
): Promise<SubagentAnnounceDeliveryResult> {
  if (!key) {
    return run();
  }
  const namespaced = namespaceKey(key);
  const cached = getCachedDelivered(namespaced);
  if (cached) {
    defaultRuntime.log(
      `[subagent-announce] dedup cache hit for ${key}; suppressed duplicate dispatch (path=${cached.path})`,
    );
    return cached;
  }
  const existing = state.inflight.get(namespaced);
  if (existing) {
    defaultRuntime.log(`[subagent-announce] dedup coalesce for ${key}; joining in-flight dispatch`);
    return existing;
  }
  const promise = (async () => {
    try {
      const result = await run();
      if (result.delivered && state.ttlMs > 0) {
        state.delivered.set(namespaced, { result, ts: Date.now() });
      }
      return result;
    } finally {
      state.inflight.delete(namespaced);
    }
  })();
  state.inflight.set(namespaced, promise);
  return promise;
}

export const __testing = {
  resetAnnounceDeliveryDedupForTests(ttlMs = DEFAULT_TTL_MS) {
    state = createState(ttlMs);
  },
  peekCachedDelivered(key: string): SubagentAnnounceDeliveryResult | undefined {
    return getCachedDelivered(namespaceKey(key));
  },
  hasInflight(key: string): boolean {
    return state.inflight.has(namespaceKey(key));
  },
};
