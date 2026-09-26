/**
 * Per-room group chat history tracking for Matrix.
 *
 * Maintains a shared per-room message queue and per-(agentId, roomId) watermarks so
 * each agent independently tracks which messages it has already consumed. This design
 * lets multiple agents in the same room see independent history windows:
 *
 * - dev replies to @dev msgB (watermark advances to B) → room queue still has [A, B]
 * - spark replies to @spark msgC → spark watermark starts at 0 and sees [A, B, C]
 *
 * Race-condition safety: the watermark only advances to the snapshot index taken at
 * dispatch time, NOT to the queue's end at reply time.  Messages that land in the queue
 * while the agent is processing stay visible to the next trigger for that agent.
 *
 * Thread-scoped history uses a separate sub-queue per Matrix thread root. Main-room
 * history and thread history must not share watermarks or pending context.
 */

import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { setBoundedMap } from "./bounded-cache.js";

/** Maximum entries retained per room (hard cap to bound memory). */
const DEFAULT_MAX_QUEUE_SIZE = 200;
/** Maximum number of rooms to retain queues for (FIFO eviction beyond this). */
const DEFAULT_MAX_ROOM_QUEUES = 1000;
/** Maximum number of (agentId, roomId) watermark entries to retain. */
const MAX_WATERMARK_ENTRIES = 5000;
/** Maximum prepared trigger snapshots retained per room for retry reuse. */
const MAX_PREPARED_TRIGGER_ENTRIES = 500;
/** Maximum thread queues retained per room (FIFO eviction beyond this). */
const MAX_THREAD_QUEUES_PER_ROOM = 200;

export type { HistoryEntry };

type HistorySnapshotToken = {
  snapshotIdx: number;
  queueGeneration: number;
};

export type ReservedHistorySlot = HistorySnapshotToken & {
  slotIdx: number;
  watermarkIdx?: number;
};

type QueuedHistoryEntry = HistoryEntry & {
  discarded?: true;
  reserved?: true;
  consumedBy?: Set<string>;
};

type PreparedTriggerResult = {
  history: HistoryEntry[];
} & HistorySnapshotToken;

type HistoryQueue = {
  entries: QueuedHistoryEntry[];
  /** Absolute index of entries[0] — increases as old entries are trimmed. */
  baseIndex: number;
  generation: number;
  preparedTriggers: Map<string, PreparedTriggerResult>;
};

type RoomQueue = HistoryQueue & {
  threadQueues: Map<string, HistoryQueue>;
};

export function createRoomHistoryTracker(
  maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
  maxRoomQueues = DEFAULT_MAX_ROOM_QUEUES,
  maxWatermarkEntries = MAX_WATERMARK_ENTRIES,
  maxPreparedTriggerEntries = MAX_PREPARED_TRIGGER_ENTRIES,
) {
  const roomQueues = new Map<string, RoomQueue>();
  /** Maps `{agentId, roomId, scope}` → absolute consumed-up-to index */
  const agentWatermarks = new Map<string, number>();
  let nextQueueGeneration = 1;

  function clearWatermarks(roomId: string, threadRootId?: string): void {
    for (const key of agentWatermarks.keys()) {
      const parsed = JSON.parse(key) as { roomId?: string; scope?: string } | null;
      if (
        parsed?.roomId === roomId &&
        (threadRootId === undefined || parsed.scope === threadRootId)
      ) {
        agentWatermarks.delete(key);
      }
    }
  }

  function createHistoryQueue(): HistoryQueue {
    return {
      entries: [],
      baseIndex: 0,
      generation: nextQueueGeneration++,
      preparedTriggers: new Map(),
    };
  }

  function getOrCreateQueue(roomId: string): RoomQueue {
    let queue = roomQueues.get(roomId);
    if (!queue) {
      queue = {
        ...createHistoryQueue(),
        threadQueues: new Map(),
      };
      roomQueues.set(roomId, queue);
      // FIFO eviction to prevent unbounded growth across many rooms
      if (roomQueues.size > maxRoomQueues) {
        const oldest = roomQueues.keys().next().value;
        if (oldest !== undefined) {
          roomQueues.delete(oldest);
          clearWatermarks(oldest);
        }
      }
    }
    return queue;
  }

  function getOrCreateThreadQueue(
    roomId: string,
    roomQueue: RoomQueue,
    threadRootId: string,
  ): HistoryQueue {
    let queue = roomQueue.threadQueues.get(threadRootId);
    if (!queue) {
      queue = createHistoryQueue();
      roomQueue.threadQueues.set(threadRootId, queue);
      if (roomQueue.threadQueues.size > MAX_THREAD_QUEUES_PER_ROOM) {
        const oldest = roomQueue.threadQueues.keys().next().value;
        if (oldest !== undefined) {
          roomQueue.threadQueues.delete(oldest);
          clearWatermarks(roomId, oldest);
        }
      }
    }
    return queue;
  }

  function getScopedQueue(roomId: string, threadRootId?: string): HistoryQueue {
    const roomQueue = getOrCreateQueue(roomId);
    return threadRootId ? getOrCreateThreadQueue(roomId, roomQueue, threadRootId) : roomQueue;
  }

  function findScopedQueue(roomId: string, threadRootId?: string): HistoryQueue | undefined {
    const roomQueue = roomQueues.get(roomId);
    if (!roomQueue) {
      return undefined;
    }
    return threadRootId ? roomQueue.threadQueues.get(threadRootId) : roomQueue;
  }

  function appendToQueue(queue: HistoryQueue, entry: QueuedHistoryEntry): HistorySnapshotToken {
    queue.entries.push(entry);
    if (queue.entries.length > maxQueueSize) {
      const overflow = queue.entries.length - maxQueueSize;
      queue.entries.splice(0, overflow);
      queue.baseIndex += overflow;
    }
    return {
      snapshotIdx: queue.baseIndex + queue.entries.length,
      queueGeneration: queue.generation,
    };
  }

  function wmKey(agentId: string, roomId: string, threadRootId?: string): string {
    return JSON.stringify({
      agentId,
      roomId,
      scope: threadRootId ?? "main",
    });
  }

  function preparedTriggerKey(agentId: string, messageId?: string): string | null {
    if (!messageId?.trim()) {
      return null;
    }
    return `${agentId}:${messageId.trim()}`;
  }

  function rememberWatermark(key: string, snapshotIdx: number): void {
    const nextSnapshotIdx = Math.max(agentWatermarks.get(key) ?? 0, snapshotIdx);
    if (agentWatermarks.has(key)) {
      // Refresh insertion order so capped-map eviction removes the stalest pair, not an active one.
      agentWatermarks.delete(key);
    }
    setBoundedMap(agentWatermarks, key, nextSnapshotIdx, maxWatermarkEntries);
  }

  function markConsumedAfterReservedGap(
    queue: HistoryQueue,
    key: string,
    firstReservedRel: number,
    snapshotIdx: number,
  ): void {
    const endRel = Math.min(snapshotIdx - queue.baseIndex, queue.entries.length);
    for (let rel = firstReservedRel + 1; rel < endRel; rel += 1) {
      const entry = queue.entries[rel];
      if (!entry || entry.reserved || entry.discarded) {
        continue;
      }
      entry.consumedBy ??= new Set<string>();
      entry.consumedBy.add(key);
    }
  }

  function rememberPreparedTrigger(
    queue: HistoryQueue,
    retryKey: string,
    prepared: PreparedTriggerResult,
  ): PreparedTriggerResult {
    if (queue.preparedTriggers.has(retryKey)) {
      // Refresh insertion order so capped eviction keeps actively retried events hot.
      queue.preparedTriggers.delete(retryKey);
    }
    setBoundedMap(queue.preparedTriggers, retryKey, prepared, maxPreparedTriggerEntries);
    return prepared;
  }

  function computePendingHistory(
    queue: HistoryQueue,
    agentId: string,
    roomId: string,
    limit: number,
    endAbsExclusive = queue.baseIndex + queue.entries.length,
    startAbsOverride?: number,
    threadRootId?: string,
  ): HistoryEntry[] {
    if (limit <= 0 || queue.entries.length === 0) {
      return [];
    }
    const key = wmKey(agentId, roomId, threadRootId);
    const wm = startAbsOverride ?? agentWatermarks.get(key) ?? 0;
    // startAbs: the first absolute index the agent hasn't seen yet
    const startAbs = Math.max(wm, queue.baseIndex);
    const startRel = startAbs - queue.baseIndex;
    const endRel = Math.max(
      startRel,
      Math.min(endAbsExclusive - queue.baseIndex, queue.entries.length),
    );
    const available = queue.entries
      .slice(startRel, endRel)
      .filter((entry) => !entry.discarded && !entry.reserved && !entry.consumedBy?.has(key));
    return available.length > limit ? available.slice(-limit) : available;
  }

  function prepareTrigger(
    agentId: string,
    roomId: string,
    limit: number,
    entry: HistoryEntry,
    threadRootId?: string,
    slot?: ReservedHistorySlot,
  ): PreparedTriggerResult {
    const queue = getScopedQueue(roomId, threadRootId);
    if (slot) {
      const rel = slot.slotIdx - queue.baseIndex;
      if (queue.generation !== slot.queueGeneration || rel < 0 || rel >= queue.entries.length) {
        slot = undefined;
      }
    }
    const retryKey = preparedTriggerKey(agentId, entry.messageId);
    if (retryKey) {
      const prepared = queue.preparedTriggers.get(retryKey);
      if (prepared) {
        if (slot) {
          discardPending(roomId, slot, threadRootId);
        }
        return rememberPreparedTrigger(queue, retryKey, prepared);
      }
    }
    if (slot) {
      queue.entries[slot.slotIdx - queue.baseIndex] = entry;
    }
    const prepared = {
      history: computePendingHistory(
        queue,
        agentId,
        roomId,
        limit,
        slot?.slotIdx,
        slot?.watermarkIdx,
        threadRootId,
      ),
      ...(slot
        ? { snapshotIdx: slot.slotIdx + 1, queueGeneration: queue.generation }
        : appendToQueue(queue, entry)),
    };
    if (retryKey) {
      return rememberPreparedTrigger(queue, retryKey, prepared);
    }
    return prepared;
  }

  function finalizePending(
    roomId: string,
    slot: ReservedHistorySlot,
    entry: QueuedHistoryEntry,
    threadRootId?: string,
  ): void {
    const queue = findScopedQueue(roomId, threadRootId);
    if (!queue || queue.generation !== slot.queueGeneration) {
      return;
    }
    const rel = slot.slotIdx - queue.baseIndex;
    if (rel < 0 || rel >= queue.entries.length) {
      return;
    }
    queue.entries[rel] = entry;
  }

  function discardPending(roomId: string, slot: ReservedHistorySlot, threadRootId?: string) {
    finalizePending(
      roomId,
      slot,
      { sender: "", body: "", messageId: undefined, discarded: true },
      threadRootId,
    );
  }

  return {
    recordPending(roomId: string, entry: HistoryEntry, threadRootId?: string) {
      const queue = getScopedQueue(roomId, threadRootId);
      appendToQueue(queue, entry);
    },

    reservePending(agentId: string, roomId: string, entry: HistoryEntry, threadRootId?: string) {
      const queue = getScopedQueue(roomId, threadRootId);
      const snapshot = appendToQueue(queue, { ...entry, reserved: true });
      return {
        ...snapshot,
        slotIdx: snapshot.snapshotIdx - 1,
        watermarkIdx: agentWatermarks.get(wmKey(agentId, roomId, threadRootId)) ?? 0,
      };
    },

    finalizePending,

    discardPending,
    prepareTrigger,

    consumeHistory(
      agentId: string,
      roomId: string,
      snapshot: HistorySnapshotToken,
      messageId?: string,
      threadRootId?: string,
    ) {
      const key = wmKey(agentId, roomId, threadRootId);
      const queue = findScopedQueue(roomId, threadRootId);
      if (!queue) {
        // The room or thread was evicted while this trigger was in flight. Keep eviction
        // authoritative so a late completion cannot recreate a stale watermark.
        agentWatermarks.delete(key);
        return;
      }
      if (queue.generation !== snapshot.queueGeneration) {
        // The room was evicted and recreated before this trigger completed. Reject the stale
        // snapshot so it cannot advance or erase state for the new queue generation.
        return;
      }
      const firstReservedRel = queue.entries.findIndex(
        (entry, index) => entry.reserved === true && queue.baseIndex + index < snapshot.snapshotIdx,
      );
      if (firstReservedRel >= 0) {
        markConsumedAfterReservedGap(queue, key, firstReservedRel, snapshot.snapshotIdx);
      }
      const consumableSnapshotIdx =
        firstReservedRel >= 0 ? queue.baseIndex + firstReservedRel : snapshot.snapshotIdx;
      // Monotone write: never regress an already-advanced watermark.
      // Guards against out-of-order completion when two triggers for the same
      // (agentId, roomId) are in-flight concurrently.
      rememberWatermark(key, consumableSnapshotIdx);
      const retryKey = preparedTriggerKey(agentId, messageId);
      if (retryKey) {
        queue.preparedTriggers.delete(retryKey);
      }
    },
  };
}
