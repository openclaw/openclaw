import { resolveMatrixRoomId, sendMessageMatrix } from "../send.js";
import { resolveActionClient } from "./client.js";
import { resolveMatrixActionLimit } from "./limits.js";
import { summarizeMatrixRawEvent } from "./summary.js";
import {
  EventType,
  MsgType,
  RelationType
} from "./types.js";
async function sendMatrixMessage(to, content, opts = {}) {
  return await sendMessageMatrix(to, content, {
    mediaUrl: opts.mediaUrl,
    replyToId: opts.replyToId,
    threadId: opts.threadId,
    client: opts.client,
    timeoutMs: opts.timeoutMs
  });
}
async function editMatrixMessage(roomId, messageId, content, opts = {}) {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("Matrix edit requires content");
  }
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    const newContent = {
      msgtype: MsgType.Text,
      body: trimmed
    };
    const payload = {
      msgtype: MsgType.Text,
      body: `* ${trimmed}`,
      "m.new_content": newContent,
      "m.relates_to": {
        rel_type: RelationType.Replace,
        event_id: messageId
      }
    };
    const eventId = await client.sendMessage(resolvedRoom, payload);
    return { eventId: eventId ?? null };
  } finally {
    if (stopOnDone) {
      client.stop();
    }
  }
}
async function deleteMatrixMessage(roomId, messageId, opts = {}) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    await client.redactEvent(resolvedRoom, messageId, opts.reason);
  } finally {
    if (stopOnDone) {
      client.stop();
    }
  }
}
async function readMatrixMessages(roomId, opts = {}) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    const limit = resolveMatrixActionLimit(opts.limit, 20);
    const token = opts.before?.trim() || opts.after?.trim() || void 0;
    const dir = opts.after ? "f" : "b";
    const res = await client.doRequest(
      "GET",
      `/_matrix/client/v3/rooms/${encodeURIComponent(resolvedRoom)}/messages`,
      {
        dir,
        limit,
        from: token
      }
    );
    const messages = res.chunk.filter((event) => event.type === EventType.RoomMessage).filter((event) => !event.unsigned?.redacted_because).map(summarizeMatrixRawEvent);
    return {
      messages,
      nextBatch: res.end ?? null,
      prevBatch: res.start ?? null
    };
  } finally {
    if (stopOnDone) {
      client.stop();
    }
  }
}
export {
  deleteMatrixMessage,
  editMatrixMessage,
  readMatrixMessages,
  sendMatrixMessage
};
