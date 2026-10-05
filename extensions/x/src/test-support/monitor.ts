import type {
  ChannelIngressQueue,
  ChannelIngressQueueClaim,
  ChannelIngressQueueRecord,
} from "openclaw/plugin-sdk/channel-outbound";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

// Host boundary double: retains rows across monitor instances, but does not claim SQLite proof.
export function createQueue<T>(
  options: {
    beforeEnqueue?: (id: string) => Promise<void>;
    onEnqueued?: (id: string) => void;
    onCompleted?: (id: string) => void;
    onReleased?: (id: string) => void;
  } = {},
): ChannelIngressQueue<T> {
  const scope = { channelId: "x", accountId: "default", queueName: "x:default" };
  const pending = new Map<string, ChannelIngressQueueRecord<T>>();
  const claims = new Map<string, ChannelIngressQueueClaim<T>>();
  const completed = new Map<string, typeof scope & { id: string; completedAt: number }>();
  let sequence = 0;
  const queue: ChannelIngressQueue<T> = {
    async enqueue(id, payload, params) {
      await options.beforeEnqueue?.(id);
      const done = completed.get(id);
      if (done) {
        return { kind: "completed", duplicate: true, record: done };
      }
      const claimed = claims.get(id);
      if (claimed) {
        return { kind: "claimed", duplicate: true, record: claimed };
      }
      const existing = pending.get(id);
      if (existing) {
        return { kind: "pending", duplicate: true, record: existing };
      }
      const record = {
        ...scope,
        id,
        payload,
        receivedAt: params?.receivedAt ?? Date.now(),
        updatedAt: Date.now(),
        attempts: 0,
        laneKey: params?.laneKey,
        metadata: params?.metadata,
      };
      pending.set(id, record);
      options.onEnqueued?.(id);
      return { kind: "accepted", duplicate: false, record };
    },
    async listPending() {
      return [...pending.values()];
    },
    async listClaims() {
      return [...claims.values()];
    },
    async claim(id, params) {
      const record = pending.get(id);
      if (!record) {
        return null;
      }
      pending.delete(id);
      const claim = {
        ...record,
        claim: {
          token: String(++sequence),
          ownerId: params?.ownerId ?? "fixture",
          claimedAt: Date.now(),
        },
      };
      claims.set(id, claim);
      return claim;
    },
    async claimNext(params) {
      const blocked = new Set(params?.blockedLaneKeys);
      const candidates = params?.candidateIds ? new Set(params.candidateIds) : undefined;
      const record = [...pending.values()].find(
        (row) =>
          (!row.laneKey || !blocked.has(row.laneKey)) && (!candidates || candidates.has(row.id)),
      );
      return record ? queue.claim(record.id, params) : null;
    },
    async refreshClaim(ref) {
      return claims.get(ref.id)?.claim.token === ref.claim.token;
    },
    async complete(ref) {
      const id = typeof ref === "string" ? ref : ref.id;
      if (typeof ref !== "string" && claims.get(id)?.claim.token !== ref.claim.token) {
        return false;
      }
      pending.delete(id);
      claims.delete(id);
      completed.set(id, { ...scope, id, completedAt: Date.now() });
      options.onCompleted?.(id);
      return true;
    },
    async release(ref, params) {
      const id = typeof ref === "string" ? ref : ref.id;
      const claimed = claims.get(id);
      if (!claimed || (typeof ref !== "string" && claimed.claim.token !== ref.claim.token)) {
        return false;
      }
      claims.delete(id);
      const { claim: _claim, ...record } = claimed;
      pending.set(id, {
        ...record,
        ...(params?.recordAttempt === false
          ? {}
          : { attempts: record.attempts + 1, lastAttemptAt: Date.now() }),
        ...(params?.lastError ? { lastError: params.lastError } : {}),
      });
      options.onReleased?.(id);
      return true;
    },
    async fail(ref) {
      return queue.delete(ref);
    },
    async delete(ref) {
      const id = typeof ref === "string" ? ref : ref.id;
      const removedPending = pending.delete(id);
      const removedClaim = claims.delete(id);
      const removedCompleted = completed.delete(id);
      return removedPending || removedClaim || removedCompleted;
    },
    async recoverStaleClaims() {
      return 0;
    },
    async prune() {
      return 0;
    },
    async purge() {
      const count = pending.size + claims.size + completed.size;
      pending.clear();
      claims.clear();
      completed.clear();
      return count;
    },
  };
  return queue;
}

export function createKeyedState(onRegister?: (namespace: string, value: unknown) => void) {
  const namespaces = new Map<string, Map<string, string>>();
  return <T>({ namespace }: { namespace: string }): PluginStateKeyedStore<T> => {
    let data = namespaces.get(namespace);
    if (!data) {
      data = new Map();
      namespaces.set(namespace, data);
    }
    const rows = data;
    const read = (key: string): T | undefined => {
      const serialized = rows.get(key);
      // The host store's JSON boundary is represented without sharing mutable fixture objects.
      return serialized === undefined ? undefined : (JSON.parse(serialized) as T);
    };
    return {
      async register(key, value, options) {
        options?.assertCurrent?.();
        rows.set(key, JSON.stringify(value));
        onRegister?.(namespace, value);
      },
      async registerIfAbsent(key, value) {
        if (rows.has(key)) {
          return false;
        }
        rows.set(key, JSON.stringify(value));
        return true;
      },
      async lookup(key) {
        return read(key);
      },
      async consume(key) {
        const value = read(key);
        rows.delete(key);
        return value;
      },
      async delete(key, options) {
        options?.assertCurrent?.();
        return rows.delete(key);
      },
      async entries() {
        return [...rows].map(([key, value]) => ({
          key,
          value: JSON.parse(value) as T,
          createdAt: 0,
        }));
      },
      async clear() {
        rows.clear();
      },
    };
  };
}
