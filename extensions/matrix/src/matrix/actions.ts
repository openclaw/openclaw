import type { MatrixClient } from "matrix-bot-sdk";

import { getMatrixRuntime } from "../runtime.js";
import type { CoreConfig } from "../types.js";
import { getActiveMatrixClient } from "./active-client.js";
import {
  createMatrixClient,
  isBunRuntime,
  resolveMatrixAuth,
  resolveSharedMatrixClient,
} from "./client.js";
import {
  reactMatrixMessage,
  resolveMatrixRoomId,
  sendMessageMatrix,
} from "./send.js";

// Constants that were previously from matrix-js-sdk
const MsgType = {
  Text: "m.text",
} as const;

const RelationType = {
  Replace: "m.replace",
  Annotation: "m.annotation",
} as const;

const EventType = {
  RoomMessage: "m.room.message",
  RoomPinnedEvents: "m.room.pinned_events",
  RoomTopic: "m.room.topic",
  Reaction: "m.reaction",
} as const;

// Type definitions for matrix-bot-sdk event content
type RoomMessageEventContent = {
  msgtype: string;
  body: string;
  "m.new_content"?: RoomMessageEventContent;
  "m.relates_to"?: {
    rel_type?: string;
    event_id?: string;
    "m.in_reply_to"?: { event_id?: string };
  };
};

type ReactionEventContent = {
  "m.relates_to": {
    rel_type: string;
    event_id: string;
    key: string;
  };
};

type RoomPinnedEventsEventContent = {
  pinned: string[];
};

type RoomTopicEventContent = {
  topic?: string;
};

type MatrixRawEvent = {
  event_id: string;
  sender: string;
  type: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
  unsigned?: {
    redacted_because?: unknown;
  };
};

export type MatrixActionClientOpts = {
  client?: MatrixClient;
  timeoutMs?: number;
};

export type MatrixMessageSummary = {
  eventId?: string;
  sender?: string;
  body?: string;
  msgtype?: string;
  timestamp?: number;
  relatesTo?: {
    relType?: string;
    eventId?: string;
    key?: string;
  };
};

export type MatrixReactionSummary = {
  key: string;
  count: number;
  users: string[];
};

type MatrixActionClient = {
  client: MatrixClient;
  stopOnDone: boolean;
};

function ensureNodeRuntime() {
  if (isBunRuntime()) {
    throw new Error("Matrix support requires Node (bun runtime not supported)");
  }
}

async function resolveActionClient(opts: MatrixActionClientOpts = {}): Promise<MatrixActionClient> {
  ensureNodeRuntime();
  if (opts.client) return { client: opts.client, stopOnDone: false };
  const active = getActiveMatrixClient();
  if (active) return { client: active, stopOnDone: false };
  const shouldShareClient = Boolean(process.env.CLAWDBOT_GATEWAY_PORT);
  if (shouldShareClient) {
    const client = await resolveSharedMatrixClient({
      cfg: getMatrixRuntime().config.loadConfig() as CoreConfig,
      timeoutMs: opts.timeoutMs,
    });
    return { client, stopOnDone: false };
  }
  const auth = await resolveMatrixAuth({
    cfg: getMatrixRuntime().config.loadConfig() as CoreConfig,
  });
  const client = await createMatrixClient({
    homeserver: auth.homeserver,
    userId: auth.userId,
    accessToken: auth.accessToken,
    encryption: auth.encryption,
    localTimeoutMs: opts.timeoutMs,
  });
  if (auth.encryption && client.crypto) {
    try {
      const joinedRooms = await client.getJoinedRooms();
      await client.crypto.prepare(joinedRooms);
    } catch {
      // Ignore crypto prep failures for one-off actions.
    }
  }
  await client.start();
  return { client, stopOnDone: true };
}

function summarizeMatrixRawEvent(event: MatrixRawEvent): MatrixMessageSummary {
  const content = event.content as RoomMessageEventContent;
  const relates = content["m.relates_to"];
  let relType: string | undefined;
  let eventId: string | undefined;
  if (relates) {
    if ("rel_type" in relates) {
      relType = relates.rel_type;
      eventId = relates.event_id;
    } else if ("m.in_reply_to" in relates) {
      eventId = relates["m.in_reply_to"]?.event_id;
    }
  }
  const relatesTo =
    relType || eventId
      ? {
          relType,
          eventId,
        }
      : undefined;
  return {
    eventId: event.event_id,
    sender: event.sender,
    body: content.body,
    msgtype: content.msgtype,
    timestamp: event.origin_server_ts,
    relatesTo,
  };
}

async function readPinnedEvents(client: MatrixClient, roomId: string): Promise<string[]> {
  try {
    const content = (await client.getRoomStateEvent(
      roomId,
      EventType.RoomPinnedEvents,
      "",
    )) as RoomPinnedEventsEventContent;
    const pinned = content.pinned;
    return pinned.filter((id) => id.trim().length > 0);
  } catch (err: unknown) {
    const errObj = err as { statusCode?: number; body?: { errcode?: string } };
    const httpStatus = errObj.statusCode;
    const errcode = errObj.body?.errcode;
    if (httpStatus === 404 || errcode === "M_NOT_FOUND") {
      return [];
    }
    throw err;
  }
}

async function fetchEventSummary(
  client: MatrixClient,
  roomId: string,
  eventId: string,
): Promise<MatrixMessageSummary | null> {
  try {
    const raw = await client.getEvent(roomId, eventId) as MatrixRawEvent;
    if (raw.unsigned?.redacted_because) return null;
    return summarizeMatrixRawEvent(raw);
  } catch (err) {
    // Event not found, redacted, or inaccessible - return null
    return null;
  }
}

export async function sendMatrixMessage(
  to: string,
  content: string,
  opts: MatrixActionClientOpts & {
    mediaUrl?: string;
    replyToId?: string;
    threadId?: string;
  } = {},
) {
  return await sendMessageMatrix(to, content, {
    mediaUrl: opts.mediaUrl,
    replyToId: opts.replyToId,
    threadId: opts.threadId,
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
  const trimmed = content.trim();
  if (!trimmed) throw new Error("Matrix edit requires content");
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    const newContent = {
      msgtype: MsgType.Text,
      body: trimmed,
    } satisfies RoomMessageEventContent;
    const payload: RoomMessageEventContent = {
      msgtype: MsgType.Text,
      body: `* ${trimmed}`,
      "m.new_content": newContent,
      "m.relates_to": {
        rel_type: RelationType.Replace,
        event_id: messageId,
      },
    };
    const eventId = await client.sendMessage(resolvedRoom, payload);
    return { eventId: eventId ?? null };
  } finally {
    if (stopOnDone) client.stop();
  }
}

export async function deleteMatrixMessage(
  roomId: string,
  messageId: string,
  opts: MatrixActionClientOpts & { reason?: string } = {},
) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    await client.redactEvent(resolvedRoom, messageId, opts.reason);
  } finally {
    if (stopOnDone) client.stop();
  }
}

export async function readMatrixMessages(
  roomId: string,
  opts: MatrixActionClientOpts & {
    limit?: number;
    before?: string;
    after?: string;
  } = {},
): Promise<{
  messages: MatrixMessageSummary[];
  nextBatch?: string | null;
  prevBatch?: string | null;
}> {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    const limit =
      typeof opts.limit === "number" && Number.isFinite(opts.limit)
        ? Math.max(1, Math.floor(opts.limit))
        : 20;
    const token = opts.before?.trim() || opts.after?.trim() || undefined;
    const dir = opts.after ? "f" : "b";
    // matrix-bot-sdk uses doRequest for room messages
    const res = await client.doRequest("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(resolvedRoom)}/messages`, {
      dir,
      limit,
      from: token,
    }) as { chunk: MatrixRawEvent[]; start?: string; end?: string };
    const messages = res.chunk
      .filter((event) => event.type === EventType.RoomMessage)
      .filter((event) => !event.unsigned?.redacted_because)
      .map(summarizeMatrixRawEvent);
    return {
      messages,
      nextBatch: res.end ?? null,
      prevBatch: res.start ?? null,
    };
  } finally {
    if (stopOnDone) client.stop();
  }
}

export async function listMatrixReactions(
  roomId: string,
  messageId: string,
  opts: MatrixActionClientOpts & { limit?: number } = {},
): Promise<MatrixReactionSummary[]> {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    const limit =
      typeof opts.limit === "number" && Number.isFinite(opts.limit)
        ? Math.max(1, Math.floor(opts.limit))
        : 100;
    // matrix-bot-sdk uses doRequest for relations
    const res = await client.doRequest(
      "GET",
      `/_matrix/client/v1/rooms/${encodeURIComponent(resolvedRoom)}/relations/${encodeURIComponent(messageId)}/${RelationType.Annotation}/${EventType.Reaction}`,
      { dir: "b", limit },
    ) as { chunk: MatrixRawEvent[] };
    const summaries = new Map<string, MatrixReactionSummary>();
    for (const event of res.chunk) {
      const content = event.content as ReactionEventContent;
      const key = content["m.relates_to"]?.key;
      if (!key) continue;
      const sender = event.sender ?? "";
      const entry: MatrixReactionSummary = summaries.get(key) ?? {
        key,
        count: 0,
        users: [],
      };
      entry.count += 1;
      if (sender && !entry.users.includes(sender)) {
        entry.users.push(sender);
      }
      summaries.set(key, entry);
    }
    return Array.from(summaries.values());
  } finally {
    if (stopOnDone) client.stop();
  }
}

export async function removeMatrixReactions(
  roomId: string,
  messageId: string,
  opts: MatrixActionClientOpts & { emoji?: string } = {},
): Promise<{ removed: number }> {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    const res = await client.doRequest(
      "GET",
      `/_matrix/client/v1/rooms/${encodeURIComponent(resolvedRoom)}/relations/${encodeURIComponent(messageId)}/${RelationType.Annotation}/${EventType.Reaction}`,
      { dir: "b", limit: 200 },
    ) as { chunk: MatrixRawEvent[] };
    const userId = await client.getUserId();
    if (!userId) return { removed: 0 };
    const targetEmoji = opts.emoji?.trim();
    const toRemove = res.chunk
      .filter((event) => event.sender === userId)
      .filter((event) => {
        if (!targetEmoji) return true;
        const content = event.content as ReactionEventContent;
        return content["m.relates_to"]?.key === targetEmoji;
      })
      .map((event) => event.event_id)
      .filter((id): id is string => Boolean(id));
    if (toRemove.length === 0) return { removed: 0 };
    await Promise.all(toRemove.map((id) => client.redactEvent(resolvedRoom, id)));
    return { removed: toRemove.length };
  } finally {
    if (stopOnDone) client.stop();
  }
}

export async function pinMatrixMessage(
  roomId: string,
  messageId: string,
  opts: MatrixActionClientOpts = {},
): Promise<{ pinned: string[] }> {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    const current = await readPinnedEvents(client, resolvedRoom);
    const next = current.includes(messageId) ? current : [...current, messageId];
    const payload: RoomPinnedEventsEventContent = { pinned: next };
    await client.sendStateEvent(resolvedRoom, EventType.RoomPinnedEvents, "", payload);
    return { pinned: next };
  } finally {
    if (stopOnDone) client.stop();
  }
}

export async function unpinMatrixMessage(
  roomId: string,
  messageId: string,
  opts: MatrixActionClientOpts = {},
): Promise<{ pinned: string[] }> {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    const current = await readPinnedEvents(client, resolvedRoom);
    const next = current.filter((id) => id !== messageId);
    const payload: RoomPinnedEventsEventContent = { pinned: next };
    await client.sendStateEvent(resolvedRoom, EventType.RoomPinnedEvents, "", payload);
    return { pinned: next };
  } finally {
    if (stopOnDone) client.stop();
  }
}

export async function listMatrixPins(
  roomId: string,
  opts: MatrixActionClientOpts = {},
): Promise<{ pinned: string[]; events: MatrixMessageSummary[] }> {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    const pinned = await readPinnedEvents(client, resolvedRoom);
    const events = (
      await Promise.all(
        pinned.map(async (eventId) => {
          try {
            return await fetchEventSummary(client, resolvedRoom, eventId);
          } catch {
            return null;
          }
        }),
      )
    ).filter((event): event is MatrixMessageSummary => Boolean(event));
    return { pinned, events };
  } finally {
    if (stopOnDone) client.stop();
  }
}

export async function getMatrixMemberInfo(
  userId: string,
  opts: MatrixActionClientOpts & { roomId?: string } = {},
) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const roomId = opts.roomId ? await resolveMatrixRoomId(client, opts.roomId) : undefined;
    // matrix-bot-sdk uses getUserProfile
    const profile = await client.getUserProfile(userId);
    // Note: matrix-bot-sdk doesn't have getRoom().getMember() like matrix-js-sdk
    // We'd need to fetch room state separately if needed
    return {
      userId,
      profile: {
        displayName: profile?.displayname ?? null,
        avatarUrl: profile?.avatar_url ?? null,
      },
      membership: null, // Would need separate room state query
      powerLevel: null, // Would need separate power levels state query
      displayName: profile?.displayname ?? null,
      roomId: roomId ?? null,
    };
  } finally {
    if (stopOnDone) client.stop();
  }
}

export async function getMatrixRoomInfo(roomId: string, opts: MatrixActionClientOpts = {}) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    // matrix-bot-sdk uses getRoomState for state events
    let name: string | null = null;
    let topic: string | null = null;
    let canonicalAlias: string | null = null;
    let memberCount: number | null = null;
    
    try {
      const nameState = await client.getRoomStateEvent(resolvedRoom, "m.room.name", "");
      name = nameState?.name ?? null;
    } catch { /* ignore */ }
    
    try {
      const topicState = await client.getRoomStateEvent(resolvedRoom, EventType.RoomTopic, "");
      topic = topicState?.topic ?? null;
    } catch { /* ignore */ }
    
    try {
      const aliasState = await client.getRoomStateEvent(resolvedRoom, "m.room.canonical_alias", "");
      canonicalAlias = aliasState?.alias ?? null;
    } catch { /* ignore */ }
    
    try {
      const members = await client.getJoinedRoomMembers(resolvedRoom);
      memberCount = members.length;
    } catch { /* ignore */ }
    
    return {
      roomId: resolvedRoom,
      name,
      topic,
      canonicalAlias,
      altAliases: [], // Would need separate query
      memberCount,
    };
  } finally {
    if (stopOnDone) client.stop();
  }
}

export { reactMatrixMessage };
