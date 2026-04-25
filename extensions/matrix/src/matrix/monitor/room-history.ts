/**
 * Per-room group chat history tracking for Matrix.
 *
 * Maintains a shared per-room message queue and per-(agentId, roomId) watermarks so
 * each agent independently tracks which messages it has already consumed. This design
 * lets multiple agents in the same room see independent history windows:
 *
 * - dev replies to @dev msgB (watermark advances to B) -> room queue still has [A, B]
 * - spark replies to @spark msgC -> spark watermark starts at 0 and sees [A, B, C]
 *
 * Thread-scoped sub-queues: when a threadRootId is provided, messages are routed into
 * a per-thread sub-queue instead of the main room queue. Each thread gets its own
 * watermark scope so agents can consume thread history independently from the main room.
 *
 * Race-condition safety: the watermark only advances to the snapshot index taken at
 * dispatch time, NOT to the queue's end at reply time. Messages that land in the queue
 * while the agent is processing stay visible to the next trigger for that agent.
 */

import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";

/** Maximum entries retained per room (hard cap to bound memory). */
const DEFAULT_MAX_QUEUE_SIZE = 200;
/** Maximum number of rooms to retain queues for (FIFO eviction beyond this). */
const DEFAULT_MAX_ROOM_QUEUES = 1000;
/** Maximum number of (agentId, roomId) watermark entries to retain. */
const MAX_WATERMARK_ENTRIES = 5000;
/** Maximum prepared trigger snapshots retained per room for retry reuse. */
const MAX_PREPARED_TRIGGER_ENTRIES = 500;
/** Maximum per-thread sub-queues retained per room (FIFO eviction beyond this). */
const MAX_THREAD_QUEUES_PER_ROOM = 50;

export type { HistoryEntry };

type HistorySnapshotToken = {
  snapshotIdx: number;
  queueGeneration: number;
};

type PreparedTriggerResult = {
  history: HistoryEntry[];
} & HistorySnapshotToken;

type RoomHistoryTracker = {
  /**
   * Record a non-trigger message for future context.
   * Call this when a room message arrives but does not mention the bot.
   */
  recordPending: (roomId: string, entry: HistoryEntry, threadRootId?: string) => void;

  /**
   * Capture pending history and append the trigger as one idempotent operation.
   * Retries of the same Matrix event reuse the original prepared history window.
   */
  prepareTrigger: (
    agentId: string,
    roomId: string,
    limit: number,
    entry: HistoryEntry,
    threadRootId?: string,
  ) => PreparedTriggerResult;

  /**
   * Advance the agent's watermark to the snapshot index returned by prepareTrigger
   * (or the lower-level recordTrigger helper used in tests).
   * Only messages appended after that snapshot remain visible on the next trigger.
   */
  consumeHistory: (
    agentId: string,
    roomId: string,
    snapshot: HistorySnapshotToken,
    messageId?: string,
    threadRootId?: string,
  ) => void;
};

type RoomHistoryTrackerTestApi = RoomHistoryTracker & {
  /**
   * Test-only helper for inspecting pending room history directly.
   */
  getPendingHistory: (
    agentId: string,
    roomId: string,
    limit: number,
    threadRootId?: string,
  ) => HistoryEntry[];

  /**
   * Test-only helper for manually appending a trigger entry and snapshot index.
   */
  recordTrigger: (
    roomId: string,
    entry: HistoryEntry,
    threadRootId?: string,
  ) => HistorySnapshotToken;
};

type RoomQueue = {
  entries: HistoryEntry[];
  /** Absolute index of entries[0] - increases as old entries are trimmed. */
  baseIndex: number;
  generation: number;
  preparedTriggers: Map<string, PreparedTriggerResult>;
  /** Per-thread sub-queues, keyed by thread root event ID. */
  threadQueues: Map<string, ThreadSubQueue>;
};

type ThreadSubQueue = {
  entries: HistoryEntry[];
  baseIndex: number;
};

function createRoomHistoryTrackerInternal(
  maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
  maxRoomQueues = DEFAULT_MAX_ROOM_QUEUES,
  maxWatermarkEntries = MAX_WATERMARK_ENTRIES,
  maxPreparedTriggerEntries = MAX_PREPARED_TRIGGER_ENTRIES,
): RoomHistoryTrackerTestApi {
  const roomQueues = new Map<string, RoomQueue>();
  type WatermarkKey = {
    agentId: string;
    roomId: string;
    scope: string;
  };

  /**
   * Maps a JSON-encoded WatermarkKey to the absolute consumed-up-to index.
   * Matrix IDs contain ":" characters, so tuple encoding is safer than splitting joined strings.
   */
  const agentWatermarks = new Map<string, number>();
  let nextQueueGeneration = 1;

  function clearRoomWatermarks(roomId: string): void {
    for (const key of agentWatermarks.keys()) {
      if (parseWatermarkKey(key)?.roomId === roomId) {
        agentWatermarks.delete(key);
      }
    }
  }

  function clearThreadWatermarks(roomId: string, threadRootId: string): void {
    for (const key of agentWatermarks.keys()) {
      const parsed = parseWatermarkKey(key);
      if (parsed?.roomId === roomId && parsed.scope === threadRootId) {
        agentWatermarks.delete(key);
      }
    }
  }

  function getOrCreateQueue(roomId: string): RoomQueue {
    let queue = roomQueues.get(roomId);
    if (!queue) {
      queue = {
        entries: [],
        baseIndex: 0,
        generation: nextQueueGeneration++,
        preparedTriggers: new Map(),
        threadQueues: new Map(),
      };
      roomQueues.set(roomId, queue);
      // FIFO eviction to prevent unbounded growth across many rooms
      if (roomQueues.size > maxRoomQueues) {
        const oldest = roomQueues.keys().next().value;
        if (oldest !== undefined) {
          roomQueues.delete(oldest);
          clearRoomWatermarks(oldest);
        }
      }
    }
    return queue;
  }

  /**
   * Get or create a thread sub-queue within a room queue.
   * Evicts the oldest thread queue if the count exceeds MAX_THREAD_QUEUES_PER_ROOM.
   */
  function getOrCreateThreadQueue(
    roomId: string,
    queue: RoomQueue,
    threadRootId: string,
  ): ThreadSubQueue {
    let subQueue = queue.threadQueues.get(threadRootId);
    if (!subQueue) {
      subQueue = {
        entries: [],
        baseIndex: 0,
      };
      queue.threadQueues.set(threadRootId, subQueue);
      if (queue.threadQueues.size > MAX_THREAD_QUEUES_PER_ROOM) {
        const oldestKey = queue.threadQueues.keys().next().value;
        if (oldestKey !== undefined) {
          queue.threadQueues.delete(oldestKey);
          clearThreadWatermarks(roomId, oldestKey);
        }
      }
    }
    return subQueue;
  }

  function appendToQueue(queue: RoomQueue, entry: HistoryEntry): HistorySnapshotToken {
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

  function appendToThreadQueue(
    subQueue: ThreadSubQueue,
    queue: RoomQueue,
    entry: HistoryEntry,
  ): HistorySnapshotToken {
    subQueue.entries.push(entry);
    if (subQueue.entries.length > maxQueueSize) {
      const overflow = subQueue.entries.length - maxQueueSize;
      subQueue.entries.splice(0, overflow);
      subQueue.baseIndex += overflow;
    }
    return {
      snapshotIdx: subQueue.baseIndex + subQueue.entries.length,
      queueGeneration: queue.generation,
    };
  }

  function wmKey(agentId: string, roomId: string, threadRootId?: string): string {
    const scope = threadRootId ?? "main";
    return JSON.stringify({ agentId, roomId, scope } satisfies WatermarkKey);
  }

  function legacyWmKey(agentId: string, roomId: string): string {
    return `${agentId}:${roomId}`;
  }

  function parseWatermarkKey(key: string): WatermarkKey | null {
    try {
      const parsed = JSON.parse(key) as Partial<WatermarkKey>;
      if (
        typeof parsed.agentId === "string" &&
        typeof parsed.roomId === "string" &&
        typeof parsed.scope === "string"
      ) {
        return parsed as WatermarkKey;
      }
    } catch {
      // Legacy pre-threading keys were colon-joined strings and are handled separately.
    }
    return null;
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
      agentWatermarks.delete(key);
    }
    agentWatermarks.set(key, nextSnapshotIdx);
    if (agentWatermarks.size > maxWatermarkEntries) {
      const oldest = agentWatermarks.keys().next().value;
      if (oldest !== undefined) {
        agentWatermarks.delete(oldest);
      }
    }
  }

  function rememberPreparedTrigger(
    queue: RoomQueue,
    retryKey: string,
    prepared: PreparedTriggerResult,
  ): PreparedTriggerResult {
    if (queue.preparedTriggers.has(retryKey)) {
      queue.preparedTriggers.delete(retryKey);
    }
    queue.preparedTriggers.set(retryKey, prepared);
    if (queue.preparedTriggers.size > maxPreparedTriggerEntries) {
      const oldest = queue.preparedTriggers.keys().next().value;
      if (oldest !== undefined) {
        queue.preparedTriggers.delete(oldest);
      }
    }
    return prepared;
  }

  function computePendingHistory(
    entries: HistoryEntry[],
    baseIndex: number,
    agentId: string,
    roomId: string,
    limit: number,
    threadRootId?: string,
  ): HistoryEntry[] {
    if (limit <= 0 || entries.length === 0) {
      return [];
    }
    const key = wmKey(agentId, roomId, threadRootId);
    let wm = agentWatermarks.get(key) ?? 0;
    if (wm === 0 && !threadRootId) {
      const legacyKey = legacyWmKey(agentId, roomId);
      const legacyWm = agentWatermarks.get(legacyKey);
      if (legacyWm !== undefined) {
        wm = legacyWm;
      }
    }
    const startAbs = Math.max(wm, baseIndex);
    const startRel = startAbs - baseIndex;
    const available = entries.slice(startRel);
    return available.length > limit ? available.slice(-limit) : available;
  }

  return {
    recordPending(roomId, entry, threadRootId) {
      const queue = getOrCreateQueue(roomId);
      if (threadRootId) {
        const subQueue = getOrCreateThreadQueue(roomId, queue, threadRootId);
        appendToThreadQueue(subQueue, queue, entry);
      } else {
        appendToQueue(queue, entry);
      }
    },

    getPendingHistory(agentId, roomId, limit, threadRootId) {
      const queue = roomQueues.get(roomId);
      if (!queue) {
        return [];
      }
      if (threadRootId) {
        const subQueue = queue.threadQueues.get(threadRootId);
        if (!subQueue) {
          return [];
        }
        return computePendingHistory(
          subQueue.entries,
          subQueue.baseIndex,
          agentId,
          roomId,
          limit,
          threadRootId,
        );
      }
      return computePendingHistory(queue.entries, queue.baseIndex, agentId, roomId, limit);
    },

    recordTrigger(roomId, entry, threadRootId) {
      const queue = getOrCreateQueue(roomId);
      if (threadRootId) {
        const subQueue = getOrCreateThreadQueue(roomId, queue, threadRootId);
        return appendToThreadQueue(subQueue, queue, entry);
      }
      return appendToQueue(queue, entry);
    },

    prepareTrigger(agentId, roomId, limit, entry, threadRootId) {
      const queue = getOrCreateQueue(roomId);
      const retryKey = preparedTriggerKey(agentId, entry.messageId);
      if (retryKey) {
        const prepared = queue.preparedTriggers.get(retryKey);
        if (prepared) {
          return rememberPreparedTrigger(queue, retryKey, prepared);
        }
      }

      let history: HistoryEntry[];
      let token: HistorySnapshotToken;

      if (threadRootId) {
        const subQueue = getOrCreateThreadQueue(roomId, queue, threadRootId);
        history = computePendingHistory(
          subQueue.entries,
          subQueue.baseIndex,
          agentId,
          roomId,
          limit,
          threadRootId,
        );
        token = appendToThreadQueue(subQueue, queue, entry);
      } else {
        history = computePendingHistory(queue.entries, queue.baseIndex, agentId, roomId, limit);
        token = appendToQueue(queue, entry);
      }

      const prepared = {
        history,
        ...token,
      };
      if (retryKey) {
        return rememberPreparedTrigger(queue, retryKey, prepared);
      }
      return prepared;
    },

    consumeHistory(agentId, roomId, snapshot, messageId, threadRootId) {
      const key = wmKey(agentId, roomId, threadRootId);
      const queue = roomQueues.get(roomId);
      if (!queue) {
        agentWatermarks.delete(key);
        return;
      }
      if (queue.generation !== snapshot.queueGeneration) {
        return;
      }
      rememberWatermark(key, snapshot.snapshotIdx);
      const retryKey = preparedTriggerKey(agentId, messageId);
      if (queue && retryKey) {
        queue.preparedTriggers.delete(retryKey);
      }
    },
  };
}

export function createRoomHistoryTracker(
  maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
  maxRoomQueues = DEFAULT_MAX_ROOM_QUEUES,
  maxWatermarkEntries = MAX_WATERMARK_ENTRIES,
  maxPreparedTriggerEntries = MAX_PREPARED_TRIGGER_ENTRIES,
): RoomHistoryTracker {
  const tracker = createRoomHistoryTrackerInternal(
    maxQueueSize,
    maxRoomQueues,
    maxWatermarkEntries,
    maxPreparedTriggerEntries,
  );
  return {
    recordPending: tracker.recordPending,
    prepareTrigger: tracker.prepareTrigger,
    consumeHistory: tracker.consumeHistory,
  };
}

export function createRoomHistoryTrackerForTests(
  maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
  maxRoomQueues = DEFAULT_MAX_ROOM_QUEUES,
  maxWatermarkEntries = MAX_WATERMARK_ENTRIES,
  maxPreparedTriggerEntries = MAX_PREPARED_TRIGGER_ENTRIES,
): RoomHistoryTrackerTestApi {
  return createRoomHistoryTrackerInternal(
    maxQueueSize,
    maxRoomQueues,
    maxWatermarkEntries,
    maxPreparedTriggerEntries,
  );
}
