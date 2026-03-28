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
 */

import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";

/** Maximum entries retained per room (hard cap to bound memory). */
const DEFAULT_MAX_QUEUE_SIZE = 200;
/** Maximum number of rooms to retain queues for (FIFO eviction beyond this). */
const DEFAULT_MAX_ROOM_QUEUES = 1000;
/** Maximum number of (agentId, roomId) watermark entries to retain. */
const MAX_WATERMARK_ENTRIES = 5000;

export type { HistoryEntry };

export type RoomHistoryTracker = {
  /**
   * Record a non-trigger message for future context.
   * Call this when a room message arrives but does not mention the bot.
   */
  recordPending: (roomId: string, entry: HistoryEntry) => void;

  /**
   * Get pending history for an agent: all messages in the room since the
   * agent's last watermark, capped at `limit` most-recent entries.
   * Call this BEFORE recordTrigger so the trigger itself is not included.
   */
  getPendingHistory: (agentId: string, roomId: string, limit: number) => HistoryEntry[];

  /**
   * Append the trigger message to the room queue and return a snapshot index.
   * The snapshot index must be passed to consumeHistory after the agent replies.
   */
  recordTrigger: (roomId: string, entry: HistoryEntry) => number;

  /**
   * Advance the agent's watermark to the snapshot index returned by recordTrigger.
   * Only messages appended after that snapshot remain visible on the next trigger.
   */
  consumeHistory: (agentId: string, roomId: string, snapshotIdx: number) => void;
};

type RoomQueue = {
  entries: HistoryEntry[];
  /** Absolute index of entries[0] — increases as old entries are trimmed. */
  baseIndex: number;
};

export function createRoomHistoryTracker(
  maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
  maxRoomQueues = DEFAULT_MAX_ROOM_QUEUES,
): RoomHistoryTracker {
  const roomQueues = new Map<string, RoomQueue>();
  /** Maps `${agentId}:${roomId}` → absolute consumed-up-to index */
  const agentWatermarks = new Map<string, number>();

  function clearRoomWatermarks(roomId: string): void {
    const roomSuffix = `:${roomId}`;
    for (const key of agentWatermarks.keys()) {
      if (key.endsWith(roomSuffix)) {
        agentWatermarks.delete(key);
      }
    }
  }

  function getOrCreateQueue(roomId: string): RoomQueue {
    let queue = roomQueues.get(roomId);
    if (!queue) {
      queue = { entries: [], baseIndex: 0 };
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

  function appendToQueue(queue: RoomQueue, entry: HistoryEntry): number {
    queue.entries.push(entry);
    if (queue.entries.length > maxQueueSize) {
      const overflow = queue.entries.length - maxQueueSize;
      queue.entries.splice(0, overflow);
      queue.baseIndex += overflow;
    }
    return queue.baseIndex + queue.entries.length;
  }

  function wmKey(agentId: string, roomId: string): string {
    return `${agentId}:${roomId}`;
  }

  return {
    recordPending(roomId, entry) {
      const queue = getOrCreateQueue(roomId);
      appendToQueue(queue, entry);
    },

    getPendingHistory(agentId, roomId, limit) {
      if (limit <= 0) return [];
      const queue = roomQueues.get(roomId);
      if (!queue || queue.entries.length === 0) return [];
      const wm = agentWatermarks.get(wmKey(agentId, roomId)) ?? 0;
      // startAbs: the first absolute index the agent hasn't seen yet
      const startAbs = Math.max(wm, queue.baseIndex);
      const startRel = startAbs - queue.baseIndex;
      const available = queue.entries.slice(startRel);
      // Cap to the last `limit` entries
      return limit > 0 && available.length > limit ? available.slice(-limit) : available;
    },

    recordTrigger(roomId, entry) {
      const queue = getOrCreateQueue(roomId);
      return appendToQueue(queue, entry);
    },

    consumeHistory(agentId, roomId, snapshotIdx) {
      const key = wmKey(agentId, roomId);
      // Monotone write: never regress an already-advanced watermark.
      // Guards against out-of-order completion when two triggers for the same
      // (agentId, roomId) are in-flight concurrently.
      agentWatermarks.set(key, Math.max(agentWatermarks.get(key) ?? 0, snapshotIdx));
      // LRU-style eviction to prevent unbounded growth
      if (agentWatermarks.size > MAX_WATERMARK_ENTRIES) {
        const oldest = agentWatermarks.keys().next().value;
        if (oldest !== undefined) {
          agentWatermarks.delete(oldest);
        }
      }
    },
  };
}
