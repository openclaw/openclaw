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

function isThreadEvent(event: MatrixRawEvent): boolean {
  const relatesTo = event.content?.["m.relates_to"];
  return (
    typeof relatesTo === "object" &&
    relatesTo !== null &&
    "rel_type" in relatesTo &&
    relatesTo.rel_type === MATRIX_THREAD_RELATION_TYPE
  );
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

    let res: { chunk: MatrixRawEvent[]; start?: string; end?: string };
    let hydratedChunk: MatrixRawEvent[];

    if (opts.threadId) {
      res = (await client.doRequest(
        "GET",
        `/_matrix/client/v3/rooms/${encodeURIComponent(resolvedRoom)}/relations/${encodeURIComponent(opts.threadId)}/${MATRIX_THREAD_RELATION_TYPE}/m.room.message`,
        {
          dir: opts.after ? "f" : "b",
          limit,
          from: normalizeOptionalString(opts.before) ?? normalizeOptionalString(opts.after),
        },
      )) as { chunk: MatrixRawEvent[]; start?: string; end?: string };
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
      hydratedChunk = await client.hydrateEvents(resolvedRoom, rawThreadEvents);
    } else {
      let token = normalizeOptionalString(opts.before) ?? normalizeOptionalString(opts.after);
      const dir = opts.after ? "f" : "b";
      const mainEvents: MatrixRawEvent[] = [];
      res = { chunk: [], start: token, end: token };
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
        )) as { chunk: MatrixRawEvent[]; start?: string; end?: string };
        const hydratedPage = await client.hydrateEvents(resolvedRoom, res.chunk);
        for (const event of hydratedPage) {
          if (!isThreadEvent(event)) {
            mainEvents.push(event);
          }
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
      nextBatch: res.end ?? null,
      prevBatch: res.start ?? null,
    };
  });
}
