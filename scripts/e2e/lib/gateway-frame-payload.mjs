function hasOwnEnvelopeField(frame, field) {
  return (
    ((typeof frame === "object" && frame !== null) || typeof frame === "function") &&
    Object.hasOwn(frame, field)
  );
}

export function resolveGatewaySuccessPayload(frame) {
  if (hasOwnEnvelopeField(frame, "payload")) {
    return frame.payload;
  }
  if (hasOwnEnvelopeField(frame, "result")) {
    return frame.result;
  }
  return undefined;
}

export function resolveGatewayCliPayload(frame) {
  if (hasOwnEnvelopeField(frame, "result")) {
    return frame.result;
  }
  if (hasOwnEnvelopeField(frame, "payload")) {
    return frame.payload;
  }
  if (hasOwnEnvelopeField(frame, "data")) {
    return frame.data;
  }
  return frame;
}
