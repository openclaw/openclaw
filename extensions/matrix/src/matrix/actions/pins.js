import { resolveMatrixRoomId } from "../send.js";
import { resolveActionClient } from "./client.js";
import { fetchEventSummary, readPinnedEvents } from "./summary.js";
import {
  EventType
} from "./types.js";
async function withResolvedPinRoom(roomId, opts, run) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    return await run(client, resolvedRoom);
  } finally {
    if (stopOnDone) {
      client.stop();
    }
  }
}
async function updateMatrixPins(roomId, messageId, opts, update) {
  return await withResolvedPinRoom(roomId, opts, async (client, resolvedRoom) => {
    const current = await readPinnedEvents(client, resolvedRoom);
    const next = update(current);
    const payload = { pinned: next };
    await client.sendStateEvent(resolvedRoom, EventType.RoomPinnedEvents, "", payload);
    return { pinned: next };
  });
}
async function pinMatrixMessage(roomId, messageId, opts = {}) {
  return await updateMatrixPins(
    roomId,
    messageId,
    opts,
    (current) => current.includes(messageId) ? current : [...current, messageId]
  );
}
async function unpinMatrixMessage(roomId, messageId, opts = {}) {
  return await updateMatrixPins(
    roomId,
    messageId,
    opts,
    (current) => current.filter((id) => id !== messageId)
  );
}
async function listMatrixPins(roomId, opts = {}) {
  return await withResolvedPinRoom(roomId, opts, async (client, resolvedRoom) => {
    const pinned = await readPinnedEvents(client, resolvedRoom);
    const events = (await Promise.all(
      pinned.map(async (eventId) => {
        try {
          return await fetchEventSummary(client, resolvedRoom, eventId);
        } catch {
          return null;
        }
      })
    )).filter((event) => Boolean(event));
    return { pinned, events };
  });
}
export {
  listMatrixPins,
  pinMatrixMessage,
  unpinMatrixMessage
};
