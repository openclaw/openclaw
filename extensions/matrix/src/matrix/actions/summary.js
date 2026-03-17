import {
  EventType
} from "./types.js";
function summarizeMatrixRawEvent(event) {
  const content = event.content;
  const relates = content["m.relates_to"];
  let relType;
  let eventId;
  if (relates) {
    if ("rel_type" in relates) {
      relType = relates.rel_type;
      eventId = relates.event_id;
    } else if ("m.in_reply_to" in relates) {
      eventId = relates["m.in_reply_to"]?.event_id;
    }
  }
  const relatesTo = relType || eventId ? {
    relType,
    eventId
  } : void 0;
  return {
    eventId: event.event_id,
    sender: event.sender,
    body: content.body,
    msgtype: content.msgtype,
    timestamp: event.origin_server_ts,
    relatesTo
  };
}
async function readPinnedEvents(client, roomId) {
  try {
    const content = await client.getRoomStateEvent(
      roomId,
      EventType.RoomPinnedEvents,
      ""
    );
    const pinned = content.pinned;
    return pinned.filter((id) => id.trim().length > 0);
  } catch (err) {
    const errObj = err;
    const httpStatus = errObj.statusCode;
    const errcode = errObj.body?.errcode;
    if (httpStatus === 404 || errcode === "M_NOT_FOUND") {
      return [];
    }
    throw err;
  }
}
async function fetchEventSummary(client, roomId, eventId) {
  try {
    const raw = await client.getEvent(roomId, eventId);
    if (raw.unsigned?.redacted_because) {
      return null;
    }
    return summarizeMatrixRawEvent(raw);
  } catch {
    return null;
  }
}
export {
  fetchEventSummary,
  readPinnedEvents,
  summarizeMatrixRawEvent
};
