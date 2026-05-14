import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { fetchMatrixPollMessageSummary, resolveMatrixPollRootEventId } from "../poll-summary.js";
import { isPollEventType } from "../poll-types.js";
import { editMessageMatrix, sendMessageMatrix } from "../send.js";
import { withResolvedRoomAction } from "./client.js";
import { resolveMatrixActionLimit } from "./limits.js";
import { summarizeMatrixRawEvent } from "./summary.js";
import {
  EventType,
  type MatrixActionClientOpts,
  type MatrixMessageSummary,
  type MatrixRawEvent,
} from "./types.js";

const MATRIX_THREAD_RELATION_TYPE = "m.thread";
const MAX_MAIN_TIMELINE_FETCH_PAGES = 3;
const MAX_THREAD_PARENT_LOOKUP_DEPTH = 4;

type MatrixMessagesPage = {
  chunk: MatrixRawEvent[];
  start?: string;
  end?: string;
};

type MatrixRelationsPage = {
  chunk: MatrixRawEvent[];
  next_batch?: string;
  prev_batch?: string;
};

function relationRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function relationEventId(value: unknown): string | null {
  const relation = relationRecord(value);
  const eventId = relation?.event_id;
  return typeof eventId === "string" && eventId.trim() ? eventId : null;
}

function threadRootFromRelation(value: unknown): string | null {
  const relation = relationRecord(value);
  if (relation?.rel_type !== MATRIX_THREAD_RELATION_TYPE) {
    return null;
  }
  return relationEventId(relation);
}

function threadRootFromEvent(event: MatrixRawEvent): string | null {
  const rootId = threadRootFromRelation(event.content?.["m.relates_to"]);
  if (rootId) {
    return rootId;
  }
  const newContent = relationRecord(event.content?.["m.new_content"]);
  return threadRootFromRelation(newContent?.["m.relates_to"]);
}

function relationParentIds(event: MatrixRawEvent): string[] {
  const parentIds = new Set<string>();
  const rootId = threadRootFromEvent(event);
  const parentId = relationEventId(event.content?.["m.relates_to"]);
  if (parentId && parentId !== rootId) {
    parentIds.add(parentId);
  }
  const newContent = relationRecord(event.content?.["m.new_content"]);
  const newContentParentId = relationEventId(newContent?.["m.relates_to"]);
  if (newContentParentId && newContentParentId !== rootId) {
    parentIds.add(newContentParentId);
  }
  return [...parentIds];
}

function createEventResolver(
  roomId: string,
  client: MatrixActionClientOpts["client"],
  knownEvents: MatrixRawEvent[],
) {
  const cache = new Map<string, Promise<MatrixRawEvent | null>>();
  for (const event of knownEvents) {
    if (event.event_id) {
      cache.set(event.event_id, Promise.resolve(event));
    }
  }

  return async (eventId: string): Promise<MatrixRawEvent | null> => {
    const cached = cache.get(eventId);
    if (cached) {
      return await cached;
    }
    const loaded = client
      ? client
          .getEvent(roomId, eventId)
          .then((event) => event as MatrixRawEvent | null)
          .catch(() => null)
      : Promise.resolve(null);
    cache.set(eventId, loaded);
    return await loaded;
  };
}

async function eventBelongsToAnyThread(
  event: MatrixRawEvent,
  resolveEvent: (eventId: string) => Promise<MatrixRawEvent | null>,
  depth = 0,
  visited = new Set<string>(),
): Promise<boolean> {
  if (threadRootFromEvent(event)) {
    return true;
  }
  if (depth >= MAX_THREAD_PARENT_LOOKUP_DEPTH) {
    return false;
  }
  for (const parentId of relationParentIds(event)) {
    if (visited.has(parentId)) {
      continue;
    }
    visited.add(parentId);
    const parent = await resolveEvent(parentId);
    if (parent && (await eventBelongsToAnyThread(parent, resolveEvent, depth + 1, visited))) {
      return true;
    }
  }
  return false;
}

async function eventBelongsToThread(
  event: MatrixRawEvent,
  threadRootId: string,
  resolveEvent: (eventId: string) => Promise<MatrixRawEvent | null>,
  depth = 0,
  visited = new Set<string>(),
): Promise<boolean> {
  if (event.event_id === threadRootId) {
    return true;
  }
  const rootId = threadRootFromEvent(event);
  if (rootId) {
    return rootId === threadRootId;
  }
  if (depth >= MAX_THREAD_PARENT_LOOKUP_DEPTH) {
    return false;
  }
  for (const parentId of relationParentIds(event)) {
    if (parentId === threadRootId || visited.has(parentId)) {
      continue;
    }
    visited.add(parentId);
    const parent = await resolveEvent(parentId);
    if (
      parent &&
      (await eventBelongsToThread(parent, threadRootId, resolveEvent, depth + 1, visited))
    ) {
      return true;
    }
  }
  return false;
}

async function filterThreadEvents(
  events: MatrixRawEvent[],
  threadRootId: string,
  roomId: string,
  client: MatrixActionClientOpts["client"],
): Promise<MatrixRawEvent[]> {
  const resolveEvent = createEventResolver(roomId, client, events);
  const filtered: MatrixRawEvent[] = [];
  for (const event of events) {
    if (await eventBelongsToThread(event, threadRootId, resolveEvent)) {
      filtered.push(event);
    }
  }
  return filtered;
}

async function filterMainTimelineEvents(
  events: MatrixRawEvent[],
  roomId: string,
  client: MatrixActionClientOpts["client"],
): Promise<MatrixRawEvent[]> {
  const resolveEvent = createEventResolver(roomId, client, events);
  const filtered: MatrixRawEvent[] = [];
  for (const event of events) {
    if (!(await eventBelongsToAnyThread(event, resolveEvent))) {
      filtered.push(event);
    }
  }
  return filtered;
}

function appendUniqueEvent(
  events: MatrixRawEvent[],
  event: MatrixRawEvent | null | undefined,
): void {
  if (!event) {
    return;
  }
  const eventId = event.event_id;
  if (eventId && events.some((existing) => existing.event_id === eventId)) {
    return;
  }
  events.push(event);
}

export async function sendMatrixMessage(
  to: string,
  content: string | undefined,
  opts: MatrixActionClientOpts & {
    mediaUrl?: string;
    replyToId?: string;
    threadId?: string;
    audioAsVoice?: boolean;
  } = {},
) {
  if (!opts.cfg) {
    throw new Error("Matrix message actions require a resolved runtime config.");
  }
  return await sendMessageMatrix(to, content, {
    cfg: opts.cfg,
    mediaUrl: opts.mediaUrl,
    mediaLocalRoots: opts.mediaLocalRoots,
    replyToId: opts.replyToId,
    threadId: opts.threadId,
    audioAsVoice: opts.audioAsVoice,
    accountId: opts.accountId ?? undefined,
    client: opts.client,
    timeoutMs: opts.timeoutMs,
  });
}

export async function editMatrixMessage(
  roomId: string,
  messageId: string,
  content: string,
  opts: MatrixActionClientOpts = {},
) {
  if (!opts.cfg) {
    throw new Error("Matrix message actions require a resolved runtime config.");
  }
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("Matrix edit requires content");
  }
  const eventId = await editMessageMatrix(roomId, messageId, trimmed, {
    cfg: opts.cfg,
    accountId: opts.accountId ?? undefined,
    client: opts.client,
    timeoutMs: opts.timeoutMs,
  });
  return { eventId: eventId || null };
}

export async function deleteMatrixMessage(
  roomId: string,
  messageId: string,
  opts: MatrixActionClientOpts & { reason?: string } = {},
) {
  await withResolvedRoomAction(roomId, opts, async (client, resolvedRoom) => {
    await client.redactEvent(resolvedRoom, messageId, opts.reason);
  });
}

export async function readMatrixMessages(
  roomId: string,
  opts: MatrixActionClientOpts & {
    limit?: number;
    before?: string;
    after?: string;
    threadId?: string;
  } = {},
): Promise<{
  messages: MatrixMessageSummary[];
  nextBatch?: string | null;
  prevBatch?: string | null;
}> {
  return await withResolvedRoomAction(roomId, opts, async (client, resolvedRoom) => {
    const limit = resolveMatrixActionLimit(opts.limit, 20);

    let nextBatch: string | null = null;
    let prevBatch: string | null = null;
    let hydratedChunk: MatrixRawEvent[];

    if (opts.threadId) {
      const res = (await client.doRequest(
        "GET",
        `/_matrix/client/v1/rooms/${encodeURIComponent(resolvedRoom)}/relations/${encodeURIComponent(opts.threadId)}`,
        {
          dir: opts.after ? "f" : "b",
          limit,
          from: normalizeOptionalString(opts.before) ?? normalizeOptionalString(opts.after),
          recurse: true,
        },
      )) as MatrixRelationsPage;
      nextBatch = res.next_batch ?? null;
      prevBatch = res.prev_batch ?? null;
      const rawThreadEvents: MatrixRawEvent[] = [];
      if (!opts.before && !opts.after) {
        appendUniqueEvent(
          rawThreadEvents,
          (await client.getEvent(resolvedRoom, opts.threadId)) as MatrixRawEvent | null,
        );
      }
      for (const event of res.chunk) {
        appendUniqueEvent(rawThreadEvents, event);
      }
      hydratedChunk = await filterThreadEvents(
        await client.hydrateEvents(resolvedRoom, rawThreadEvents),
        opts.threadId,
        resolvedRoom,
        client,
      );
    } else {
      let token = normalizeOptionalString(opts.before) ?? normalizeOptionalString(opts.after);
      const dir = opts.after ? "f" : "b";
      const mainEvents: MatrixRawEvent[] = [];
      let res: MatrixMessagesPage = { chunk: [], start: token, end: token };
      for (
        let page = 0;
        page < MAX_MAIN_TIMELINE_FETCH_PAGES && mainEvents.length < limit;
        page += 1
      ) {
        const fetchLimit = Math.max(1, limit - mainEvents.length);
        res = (await client.doRequest(
          "GET",
          `/_matrix/client/v3/rooms/${encodeURIComponent(resolvedRoom)}/messages`,
          {
            dir,
            limit: fetchLimit,
            from: token,
          },
        )) as MatrixMessagesPage;
        const hydratedPage = await client.hydrateEvents(resolvedRoom, res.chunk);
        for (const event of await filterMainTimelineEvents(hydratedPage, resolvedRoom, client)) {
          mainEvents.push(event);
        }
        if (
          !res.end ||
          res.end === token ||
          res.chunk.length === 0 ||
          res.chunk.length < fetchLimit
        ) {
          break;
        }
        token = res.end;
      }
      nextBatch = res.end ?? null;
      prevBatch = res.start ?? null;
      hydratedChunk = mainEvents;
    }

    const processedChunk = hydratedChunk.slice(0, limit);

    const seenPollRoots = new Set<string>();
    const messages: MatrixMessageSummary[] = [];
    for (const event of processedChunk) {
      if (event.unsigned?.redacted_because) {
        continue;
      }
      if (event.type === EventType.RoomMessage) {
        messages.push(summarizeMatrixRawEvent(event));
        continue;
      }
      if (!isPollEventType(event.type)) {
        continue;
      }
      const pollRootId = resolveMatrixPollRootEventId(event);
      if (!pollRootId || seenPollRoots.has(pollRootId)) {
        continue;
      }
      seenPollRoots.add(pollRootId);
      const pollSummary = await fetchMatrixPollMessageSummary(client, resolvedRoom, event);
      if (pollSummary) {
        messages.push(pollSummary);
      }
    }
    return {
      messages,
      nextBatch,
      prevBatch,
    };
  });
}
