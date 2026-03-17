function isOutboundDirection(direction) {
  return direction?.startsWith("outbound") ?? false;
}
function readTwimlRequestView(ctx) {
  const params = new URLSearchParams(ctx.rawBody);
  const type = typeof ctx.query?.type === "string" ? ctx.query.type.trim() : void 0;
  const callIdFromQuery = typeof ctx.query?.callId === "string" && ctx.query.callId.trim() ? ctx.query.callId.trim() : void 0;
  return {
    callStatus: params.get("CallStatus"),
    direction: params.get("Direction"),
    isStatusCallback: type === "status",
    callSid: params.get("CallSid") || void 0,
    callIdFromQuery
  };
}
function decideTwimlResponse(input) {
  if (input.callIdFromQuery && !input.isStatusCallback) {
    if (input.hasStoredTwiml) {
      return { kind: "stored", consumeStoredTwimlCallId: input.callIdFromQuery };
    }
    if (input.isNotifyCall) {
      return { kind: "empty" };
    }
    if (isOutboundDirection(input.direction)) {
      return input.canStream ? { kind: "stream" } : { kind: "pause" };
    }
  }
  if (input.isStatusCallback) {
    return { kind: "empty" };
  }
  if (input.direction === "inbound") {
    if (input.hasActiveStreams) {
      return { kind: "queue" };
    }
    if (input.canStream && input.callSid) {
      return { kind: "stream", activateStreamCallSid: input.callSid };
    }
    return { kind: "pause" };
  }
  if (input.callStatus !== "in-progress") {
    return { kind: "empty" };
  }
  return input.canStream ? { kind: "stream" } : { kind: "pause" };
}
export {
  decideTwimlResponse,
  readTwimlRequestView
};
