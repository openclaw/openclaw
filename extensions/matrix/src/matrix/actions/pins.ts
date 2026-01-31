import {
  EventType,
  type MatrixActionClientOpts,
  type MatrixMessageSummary,
  type RoomPinnedEventsEventContent,
} from "./types.js";
import { resolveActionClient } from "./client.js";
import { fetchEventSummary, readPinnedEvents } from "./summary.js";
import { resolveMatrixRoomId } from "../send.js";

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
