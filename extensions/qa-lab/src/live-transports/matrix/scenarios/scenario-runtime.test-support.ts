export function matrixMessage(
  eventId: string,
  body: string,
  sender = "@sut:test",
  msgtype?: string,
) {
  return {
    event_id: eventId,
    sender,
    type: "m.room.message",
    content: { body, ...(msgtype ? { msgtype } : {}) },
  };
}

export function matrixSyncResponse(
  roomId: string,
  events: Record<string, unknown>[],
  nextBatch = "next",
  extra: Record<string, unknown> = {},
) {
  return Response.json({
    next_batch: nextBatch,
    rooms: { join: { [roomId]: { timeline: { events } } } },
    ...extra,
  });
}
