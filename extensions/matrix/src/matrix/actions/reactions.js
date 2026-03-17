import { resolveMatrixRoomId } from "../send.js";
import { resolveActionClient } from "./client.js";
import { resolveMatrixActionLimit } from "./limits.js";
import {
  EventType,
  RelationType
} from "./types.js";
function getReactionsPath(roomId, messageId) {
  return `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(messageId)}/${RelationType.Annotation}/${EventType.Reaction}`;
}
async function listReactionEvents(client, roomId, messageId, limit) {
  const res = await client.doRequest("GET", getReactionsPath(roomId, messageId), {
    dir: "b",
    limit
  });
  return res.chunk;
}
async function listMatrixReactions(roomId, messageId, opts = {}) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    const limit = resolveMatrixActionLimit(opts.limit, 100);
    const chunk = await listReactionEvents(client, resolvedRoom, messageId, limit);
    const summaries = /* @__PURE__ */ new Map();
    for (const event of chunk) {
      const content = event.content;
      const key = content["m.relates_to"]?.key;
      if (!key) {
        continue;
      }
      const sender = event.sender ?? "";
      const entry = summaries.get(key) ?? {
        key,
        count: 0,
        users: []
      };
      entry.count += 1;
      if (sender && !entry.users.includes(sender)) {
        entry.users.push(sender);
      }
      summaries.set(key, entry);
    }
    return Array.from(summaries.values());
  } finally {
    if (stopOnDone) {
      client.stop();
    }
  }
}
async function removeMatrixReactions(roomId, messageId, opts = {}) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    const chunk = await listReactionEvents(client, resolvedRoom, messageId, 200);
    const userId = await client.getUserId();
    if (!userId) {
      return { removed: 0 };
    }
    const targetEmoji = opts.emoji?.trim();
    const toRemove = chunk.filter((event) => event.sender === userId).filter((event) => {
      if (!targetEmoji) {
        return true;
      }
      const content = event.content;
      return content["m.relates_to"]?.key === targetEmoji;
    }).map((event) => event.event_id).filter((id) => Boolean(id));
    if (toRemove.length === 0) {
      return { removed: 0 };
    }
    await Promise.all(toRemove.map((id) => client.redactEvent(resolvedRoom, id)));
    return { removed: toRemove.length };
  } finally {
    if (stopOnDone) {
      client.stop();
    }
  }
}
export {
  listMatrixReactions,
  removeMatrixReactions
};
