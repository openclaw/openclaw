import { MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY } from "../send/types.js";
import { resolveMatrixThreadRootId } from "./threads.js";
import {
  EventType,
  RelationType,
  type MatrixRawEvent,
  type RoomMessageEventContent,
} from "./types.js";

export type MatrixDraftFreshnessScope = { kind: "room" } | { kind: "thread"; threadRootId: string };

export type MatrixFreshnessObservationAction = "invalidate" | "ignore" | "recheck";

export type MatrixFreshnessObservationReason =
  | "room-visible-message"
  | "same-thread-visible-message"
  | "thread-irrelevant-root-message"
  | "different-thread"
  | "protected-target-redaction"
  | "reaction-noise"
  | "transport-noise"
  | "ignored-event";

export type MatrixFreshnessObservationDecision = {
  action: MatrixFreshnessObservationAction;
  reason: MatrixFreshnessObservationReason;
  eventId: string;
  eventScope?: MatrixDraftFreshnessScope;
};

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveRelationEventId(content: RoomMessageEventContent): string | undefined {
  const relates = content["m.relates_to"];
  if (!relates || typeof relates !== "object") {
    return undefined;
  }
  if ("event_id" in relates && typeof relates.event_id === "string" && relates.event_id.trim()) {
    return relates.event_id.trim();
  }
  return undefined;
}

function resolveRelationType(content: RoomMessageEventContent): string | undefined {
  const relates = content["m.relates_to"];
  if (!relates || typeof relates !== "object") {
    return undefined;
  }
  if ("rel_type" in relates && typeof relates.rel_type === "string" && relates.rel_type.trim()) {
    return relates.rel_type.trim();
  }
  return undefined;
}

function isRedactedEvent(event: MatrixRawEvent): boolean {
  return Boolean(event.unsigned?.redacted_because);
}

function toIdSet(values?: Iterable<string | null | undefined>): Set<string> {
  const out = new Set<string>();
  if (!values) {
    return out;
  }
  for (const value of values) {
    const normalized = normalizeOptionalString(value);
    if (normalized) {
      out.add(normalized);
    }
  }
  return out;
}

export function resolveMatrixDraftFreshnessScope(params: {
  threadId?: string | null;
}): MatrixDraftFreshnessScope {
  const threadRootId = normalizeOptionalString(params.threadId);
  if (threadRootId) {
    return { kind: "thread", threadRootId };
  }
  return { kind: "room" };
}

export function resolveMatrixFreshnessProtectedEventIds(params: {
  threadId?: string | null;
  replyToEventId?: string | null;
  extraEventIds?: Iterable<string | null | undefined>;
}): Set<string> {
  const protectedEventIds = toIdSet(params.extraEventIds);
  const threadRootId = normalizeOptionalString(params.threadId);
  const replyToEventId = normalizeOptionalString(params.replyToEventId);
  if (threadRootId) {
    protectedEventIds.add(threadRootId);
  }
  if (replyToEventId) {
    protectedEventIds.add(replyToEventId);
  }
  return protectedEventIds;
}

export function resolveMatrixEventFreshnessScope(
  event: MatrixRawEvent,
): MatrixDraftFreshnessScope | undefined {
  if (event.type !== EventType.RoomMessage) {
    return undefined;
  }
  const content = event.content as RoomMessageEventContent;
  const threadRootId = resolveMatrixThreadRootId({ event, content });
  if (threadRootId) {
    return { kind: "thread", threadRootId };
  }
  return { kind: "room" };
}

function isIgnoredSelfDraftEvent(params: {
  event: MatrixRawEvent;
  selfUserId?: string;
  ignoredEventIds: Set<string>;
}): boolean {
  const senderId = normalizeOptionalString(params.event.sender);
  if (!senderId || !params.selfUserId || senderId !== params.selfUserId) {
    return false;
  }
  if (params.ignoredEventIds.has(params.event.event_id)) {
    return true;
  }
  if (params.event.type !== EventType.RoomMessage) {
    return false;
  }
  const content = params.event.content as RoomMessageEventContent;
  if (content[MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY] === true) {
    return true;
  }
  const relationType = resolveRelationType(content);
  if (relationType === RelationType.Replace) {
    return true;
  }
  const relationEventId = resolveRelationEventId(content);
  return Boolean(relationEventId && params.ignoredEventIds.has(relationEventId));
}

export function evaluateMatrixFreshnessObservation(params: {
  draftScope: MatrixDraftFreshnessScope;
  event: MatrixRawEvent;
  selfUserId?: string;
  ignoredEventIds?: Iterable<string | null | undefined>;
  protectedEventIds?: Iterable<string | null | undefined>;
}): MatrixFreshnessObservationDecision {
  const eventId = normalizeOptionalString(params.event.event_id) ?? "";
  const ignoredEventIds = toIdSet(params.ignoredEventIds);
  const protectedEventIds = resolveMatrixFreshnessProtectedEventIds({
    threadId: params.draftScope.kind === "thread" ? params.draftScope.threadRootId : undefined,
    extraEventIds: params.protectedEventIds,
  });

  if (ignoredEventIds.has(eventId)) {
    return { action: "ignore", reason: "ignored-event", eventId };
  }
  if (
    isIgnoredSelfDraftEvent({
      event: params.event,
      selfUserId: params.selfUserId,
      ignoredEventIds,
    })
  ) {
    return { action: "ignore", reason: "ignored-event", eventId };
  }
  if (params.event.type === EventType.Reaction) {
    return { action: "ignore", reason: "reaction-noise", eventId };
  }
  if (params.event.type !== EventType.RoomMessage) {
    return { action: "ignore", reason: "transport-noise", eventId };
  }
  if (isRedactedEvent(params.event) && protectedEventIds.has(eventId)) {
    return { action: "recheck", reason: "protected-target-redaction", eventId };
  }

  const eventScope = resolveMatrixEventFreshnessScope(params.event);
  if (!eventScope) {
    return { action: "ignore", reason: "transport-noise", eventId };
  }
  if (params.draftScope.kind === "room") {
    if (eventScope.kind === "thread") {
      return { action: "ignore", reason: "different-thread", eventId, eventScope };
    }
    return { action: "invalidate", reason: "room-visible-message", eventId, eventScope };
  }
  if (eventScope.kind === "thread") {
    if (eventScope.threadRootId === params.draftScope.threadRootId) {
      return { action: "invalidate", reason: "same-thread-visible-message", eventId, eventScope };
    }
    return { action: "ignore", reason: "different-thread", eventId, eventScope };
  }
  return {
    action: "ignore",
    reason: "thread-irrelevant-root-message",
    eventId,
    eventScope,
  };
}

export type MatrixLatestVisibleSnapshotToken = {
  snapshotIdx: number;
  queueGeneration: number;
};

export type MatrixLatestVisibleTracker = {
  recordPending: (roomId: string, event: MatrixRawEvent) => void;
  getPendingEvents: (agentId: string, roomId: string) => MatrixRawEvent[];
  getEventsAfterSnapshot: (
    roomId: string,
    snapshot: MatrixLatestVisibleSnapshotToken,
  ) => MatrixRawEvent[];
  prepareTrigger: (
    agentId: string,
    roomId: string,
    event: MatrixRawEvent,
  ) => MatrixLatestVisibleSnapshotToken;
  consume: (agentId: string, roomId: string, snapshot: MatrixLatestVisibleSnapshotToken) => void;
};

type MatrixLatestVisibleQueue = {
  events: MatrixRawEvent[];
  baseIndex: number;
  generation: number;
};

const DEFAULT_LATEST_VISIBLE_QUEUE_SIZE = 200;
const DEFAULT_LATEST_VISIBLE_ROOM_LIMIT = 1000;
const MAX_LATEST_VISIBLE_WATERMARKS = 5000;

export function createMatrixLatestVisibleTracker(params?: {
  maxQueueSize?: number;
  maxRooms?: number;
  maxWatermarks?: number;
}): MatrixLatestVisibleTracker {
  const maxQueueSize = params?.maxQueueSize ?? DEFAULT_LATEST_VISIBLE_QUEUE_SIZE;
  const maxRooms = params?.maxRooms ?? DEFAULT_LATEST_VISIBLE_ROOM_LIMIT;
  const maxWatermarks = params?.maxWatermarks ?? MAX_LATEST_VISIBLE_WATERMARKS;
  const roomQueues = new Map<string, MatrixLatestVisibleQueue>();
  const watermarks = new Map<string, number>();
  let nextGeneration = 1;

  const watermarkKey = (agentId: string, roomId: string) => `${agentId}:${roomId}`;

  const clearRoomWatermarks = (roomId: string) => {
    const suffix = `:${roomId}`;
    for (const key of watermarks.keys()) {
      if (key.endsWith(suffix)) {
        watermarks.delete(key);
      }
    }
  };

  const getOrCreateQueue = (roomId: string): MatrixLatestVisibleQueue => {
    let queue = roomQueues.get(roomId);
    if (!queue) {
      queue = { events: [], baseIndex: 0, generation: nextGeneration++ };
      roomQueues.set(roomId, queue);
      if (roomQueues.size > maxRooms) {
        const oldest = roomQueues.keys().next().value;
        if (oldest !== undefined) {
          roomQueues.delete(oldest);
          clearRoomWatermarks(oldest);
        }
      }
    }
    return queue;
  };

  const appendToQueue = (
    queue: MatrixLatestVisibleQueue,
    event: MatrixRawEvent,
  ): MatrixLatestVisibleSnapshotToken => {
    queue.events.push(event);
    if (queue.events.length > maxQueueSize) {
      const overflow = queue.events.length - maxQueueSize;
      queue.events.splice(0, overflow);
      queue.baseIndex += overflow;
    }
    return {
      snapshotIdx: queue.baseIndex + queue.events.length,
      queueGeneration: queue.generation,
    };
  };

  const rememberWatermark = (agentId: string, roomId: string, snapshotIdx: number) => {
    const key = watermarkKey(agentId, roomId);
    const nextSnapshotIdx = Math.max(watermarks.get(key) ?? 0, snapshotIdx);
    if (watermarks.has(key)) {
      watermarks.delete(key);
    }
    watermarks.set(key, nextSnapshotIdx);
    if (watermarks.size > maxWatermarks) {
      const oldest = watermarks.keys().next().value;
      if (oldest !== undefined) {
        watermarks.delete(oldest);
      }
    }
  };

  return {
    recordPending(roomId, event) {
      appendToQueue(getOrCreateQueue(roomId), event);
    },
    getPendingEvents(agentId, roomId) {
      const queue = roomQueues.get(roomId);
      if (!queue) {
        return [];
      }
      const startAbs = Math.max(
        watermarks.get(watermarkKey(agentId, roomId)) ?? 0,
        queue.baseIndex,
      );
      const startRel = startAbs - queue.baseIndex;
      return queue.events.slice(startRel);
    },
    getEventsAfterSnapshot(roomId, snapshot) {
      const queue = roomQueues.get(roomId);
      if (!queue || queue.generation !== snapshot.queueGeneration) {
        return [];
      }
      const startAbs = Math.max(snapshot.snapshotIdx, queue.baseIndex);
      const startRel = startAbs - queue.baseIndex;
      return queue.events.slice(startRel);
    },
    prepareTrigger(agentId, roomId, event) {
      return appendToQueue(getOrCreateQueue(roomId), event);
    },
    consume(agentId, roomId, snapshot) {
      const queue = roomQueues.get(roomId);
      const key = watermarkKey(agentId, roomId);
      if (!queue) {
        watermarks.delete(key);
        return;
      }
      if (queue.generation !== snapshot.queueGeneration) {
        return;
      }
      rememberWatermark(agentId, roomId, snapshot.snapshotIdx);
    },
  };
}
