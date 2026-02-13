import { RoomId } from "@matrix-org/matrix-sdk-crypto-nodejs";
import type { OpenClawConfig, AgentToolResult } from "./openclaw-types.js";
import { matrixFetch } from "./client/http.js";
import { getTrackedRoomIds, getRoomName, isDmRoom } from "./client/rooms.js";
import {
  sendMatrixMessage,
  sendReaction,
  listReactions,
  removeReaction,
  editMessage,
  deleteMessage,
} from "./client/send.js";
import { resolveMatrixTarget } from "./client/targets.js";
import { getMachine } from "./crypto/machine.js";

/**
 * Build an AgentToolResult matching the jsonResult() format from openclaw/plugin-sdk.
 * content must be an array of content blocks — NOT a plain object.
 */
function jsonResult(payload: unknown): AgentToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

/**
 * Handle Matrix message actions from OpenClaw's message tool.
 */
export async function handleMatrixAction(ctx: {
  action: string;
  params: Record<string, unknown>;
  cfg: OpenClawConfig;
  accountId?: string | null;
}): Promise<AgentToolResult> {
  switch (ctx.action) {
    case "send":
      return handleSend(ctx.params, ctx.cfg);
    case "read":
      return handleRead(ctx.params, ctx.cfg);
    case "channel-list":
      return handleChannelList();
    case "react":
      return handleReact(ctx.params);
    case "reactions":
      return handleListReactions(ctx.params);
    case "unreact":
      return handleUnreact(ctx.params, ctx.cfg);
    case "edit":
      return handleEdit(ctx.params, ctx.cfg);
    case "delete":
    case "unsend":
      return handleDelete(ctx.params);
    case "invite":
      return handleInvite(ctx.params);
    case "join":
      return handleJoin(ctx.params);
    case "leave":
      return handleLeave(ctx.params);
    case "kick":
      return handleKick(ctx.params);
    case "ban":
      return handleBan(ctx.params);
    default:
      throw new Error(`Unknown action: ${ctx.action}`);
  }
}

// ── Send ─────────────────────────────────────────────────────────────
async function handleSend(params: Record<string, unknown>, cfg: OpenClawConfig) {
  const target = params.target as string | undefined;
  const message = params.message as string | undefined;

  if (!target) throw new Error("Missing 'target' (room ID or user ID)");
  if (!message) throw new Error("Missing 'message' text");

  const replyTo = params.replyTo as string | undefined;
  const userId =
    ((cfg.channels?.matrix as Record<string, unknown> | undefined)?.userId as string) ?? "";
  const roomId = await resolveMatrixTarget(target, userId);

  const result = await sendMatrixMessage({
    roomId,
    text: message,
    replyToId: replyTo,
  });

  return jsonResult({
    ok: true,
    eventId: result.eventId,
    roomId,
  });
}

// ── Read ─────────────────────────────────────────────────────────────
async function handleRead(params: Record<string, unknown>, cfg: OpenClawConfig) {
  const target = params.target as string | undefined;
  const limit = Math.min((params.limit as number) ?? 20, 100);
  const fromToken = params.from_token as string | undefined;

  if (!target) throw new Error("Missing 'target' room ID");

  const userId =
    ((cfg.channels?.matrix as Record<string, unknown> | undefined)?.userId as string) ?? "";
  const roomId = await resolveMatrixTarget(target, userId);

  let url = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=${limit}`;
  if (fromToken) {
    url += `&from=${encodeURIComponent(fromToken)}`;
  }

  const response = await matrixFetch<{
    chunk: Array<{
      event_id: string;
      sender: string;
      origin_server_ts: number;
      type: string;
      content: Record<string, unknown>;
    }>;
    end?: string;
  }>("GET", url);

  // Decrypt encrypted events before returning
  const machine = getMachine();
  const matrixRoomId = new RoomId(roomId);

  const messages: Array<{
    id: string;
    sender: string;
    timestamp: number;
    body: string;
  }> = [];

  for (const event of response.chunk ?? []) {
    if (event.type === "m.room.encrypted") {
      // Attempt decryption
      try {
        const decrypted = await machine.decryptRoomEvent(JSON.stringify(event), matrixRoomId);
        const decryptedContent = JSON.parse(decrypted.event);
        if (decryptedContent.type === "m.room.message") {
          messages.push({
            id: event.event_id,
            sender: event.sender,
            timestamp: event.origin_server_ts,
            body:
              typeof decryptedContent.content?.body === "string"
                ? decryptedContent.content.body
                : "[no text]",
          });
        }
      } catch {
        // Decryption failed — include as placeholder
        messages.push({
          id: event.event_id,
          sender: event.sender,
          timestamp: event.origin_server_ts,
          body: "[encrypted — unable to decrypt]",
        });
      }
    } else if (event.type === "m.room.message") {
      messages.push({
        id: event.event_id,
        sender: event.sender,
        timestamp: event.origin_server_ts,
        body: typeof event.content?.body === "string" ? event.content.body : "[no text]",
      });
    }
  }

  return jsonResult({
    ok: true,
    roomId,
    count: messages.length,
    next_token: response.end,
    messages,
  });
}

// ── Channel List ─────────────────────────────────────────────────────
async function handleChannelList() {
  // Use tracked rooms from our state + /joined_rooms API
  let joinedRooms: string[] = [];
  try {
    const response = await matrixFetch<{ joined_rooms: string[] }>(
      "GET",
      "/_matrix/client/v3/joined_rooms",
    );
    joinedRooms = response.joined_rooms ?? [];
  } catch {
    // Fallback to locally tracked rooms
    joinedRooms = getTrackedRoomIds();
  }

  const rooms = joinedRooms.map((roomId) => ({
    id: roomId,
    name: getRoomName(roomId) ?? roomId,
    type: isDmRoom(roomId) ? "dm" : "group",
  }));

  return jsonResult({
    ok: true,
    count: rooms.length,
    rooms,
  });
}

// ── React ─────────────────────────────────────────────────────────────
async function handleReact(params: Record<string, unknown>) {
  const roomId = params.roomId as string | undefined;
  const eventId = params.eventId as string | undefined;
  const emoji = params.emoji as string | undefined;

  if (!roomId) throw new Error("Missing 'roomId'");
  if (!eventId) throw new Error("Missing 'eventId'");
  if (!emoji) throw new Error("Missing 'emoji'");

  const reactionEventId = await sendReaction(roomId, eventId, emoji);
  return jsonResult({ ok: true, reactionEventId });
}

// ── List Reactions ────────────────────────────────────────────────────
async function handleListReactions(params: Record<string, unknown>) {
  const roomId = params.roomId as string | undefined;
  const eventId = params.eventId as string | undefined;

  if (!roomId) throw new Error("Missing 'roomId'");
  if (!eventId) throw new Error("Missing 'eventId'");

  const reactions = await listReactions(roomId, eventId);
  return jsonResult({ ok: true, reactions });
}

// ── Unreact ───────────────────────────────────────────────────────────
async function handleUnreact(params: Record<string, unknown>, cfg: OpenClawConfig) {
  const roomId = params.roomId as string | undefined;
  const eventId = params.eventId as string | undefined;
  const emoji = params.emoji as string | undefined;

  if (!roomId) throw new Error("Missing 'roomId'");
  if (!eventId) throw new Error("Missing 'eventId'");
  if (!emoji) throw new Error("Missing 'emoji'");

  const userId =
    ((cfg.channels?.matrix as Record<string, unknown> | undefined)?.userId as string) ?? "";
  await removeReaction(roomId, eventId, userId, emoji);
  return jsonResult({ ok: true });
}

// ── Edit ──────────────────────────────────────────────────────────────
async function handleEdit(params: Record<string, unknown>, cfg: OpenClawConfig) {
  const roomId = params.roomId as string | undefined;
  const eventId = params.eventId as string | undefined;
  const message = params.message as string | undefined;

  if (!roomId) throw new Error("Missing 'roomId'");
  if (!eventId) throw new Error("Missing 'eventId'");
  if (!message) throw new Error("Missing 'message'");

  const result = await editMessage(roomId, eventId, message);
  return jsonResult({ ok: true, eventId: result.eventId, roomId });
}

// ── Delete ────────────────────────────────────────────────────────────
async function handleDelete(params: Record<string, unknown>) {
  const roomId = params.roomId as string | undefined;
  const eventId = params.eventId as string | undefined;
  const reason = params.reason as string | undefined;

  if (!roomId) throw new Error("Missing 'roomId'");
  if (!eventId) throw new Error("Missing 'eventId'");

  await deleteMessage(roomId, eventId, reason);
  return jsonResult({ ok: true });
}

// ── Invite ────────────────────────────────────────────────────────────
async function handleInvite(params: Record<string, unknown>) {
  const roomId = params.roomId as string | undefined;
  const userId = params.userId as string | undefined;
  const reason = params.reason as string | undefined;

  if (!roomId) throw new Error("Missing 'roomId'");
  if (!userId) throw new Error("Missing 'userId'");

  const body: Record<string, unknown> = { user_id: userId };
  if (reason) body.reason = reason;

  await matrixFetch("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, body);
  return jsonResult({ ok: true, roomId, userId });
}

// ── Join ──────────────────────────────────────────────────────────────
async function handleJoin(params: Record<string, unknown>) {
  const target = params.target as string | undefined;

  if (!target) throw new Error("Missing 'target' (room ID or alias)");

  const response = await matrixFetch<{ room_id: string }>(
    "POST",
    `/_matrix/client/v3/join/${encodeURIComponent(target)}`,
    {},
  );
  return jsonResult({ ok: true, roomId: response.room_id });
}

// ── Leave ─────────────────────────────────────────────────────────────
async function handleLeave(params: Record<string, unknown>) {
  const roomId = params.roomId as string | undefined;
  const reason = params.reason as string | undefined;

  if (!roomId) throw new Error("Missing 'roomId'");

  const body: Record<string, unknown> = {};
  if (reason) body.reason = reason;

  await matrixFetch("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, body);
  return jsonResult({ ok: true, roomId });
}

// ── Kick ──────────────────────────────────────────────────────────────
async function handleKick(params: Record<string, unknown>) {
  const roomId = params.roomId as string | undefined;
  const userId = params.userId as string | undefined;
  const reason = params.reason as string | undefined;

  if (!roomId) throw new Error("Missing 'roomId'");
  if (!userId) throw new Error("Missing 'userId'");

  const body: Record<string, unknown> = { user_id: userId };
  if (reason) body.reason = reason;

  await matrixFetch("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/kick`, body);
  return jsonResult({ ok: true, roomId, userId });
}

// ── Ban ───────────────────────────────────────────────────────────────
async function handleBan(params: Record<string, unknown>) {
  const roomId = params.roomId as string | undefined;
  const userId = params.userId as string | undefined;
  const reason = params.reason as string | undefined;

  if (!roomId) throw new Error("Missing 'roomId'");
  if (!userId) throw new Error("Missing 'userId'");

  const body: Record<string, unknown> = { user_id: userId };
  if (reason) body.reason = reason;

  await matrixFetch("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/ban`, body);
  return jsonResult({ ok: true, roomId, userId });
}
