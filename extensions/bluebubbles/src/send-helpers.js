import { normalizeBlueBubblesHandle, parseBlueBubblesTarget } from "./targets.js";
function resolveBlueBubblesSendTarget(raw) {
  const parsed = parseBlueBubblesTarget(raw);
  if (parsed.kind === "handle") {
    return {
      kind: "handle",
      address: normalizeBlueBubblesHandle(parsed.to),
      service: parsed.service
    };
  }
  if (parsed.kind === "chat_id") {
    return { kind: "chat_id", chatId: parsed.chatId };
  }
  if (parsed.kind === "chat_guid") {
    return { kind: "chat_guid", chatGuid: parsed.chatGuid };
  }
  return { kind: "chat_identifier", chatIdentifier: parsed.chatIdentifier };
}
function extractBlueBubblesMessageId(payload) {
  if (!payload || typeof payload !== "object") {
    return "unknown";
  }
  const asRecord = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const record = payload;
  const dataRecord = asRecord(record.data);
  const resultRecord = asRecord(record.result);
  const payloadRecord = asRecord(record.payload);
  const messageRecord = asRecord(record.message);
  const dataArrayFirst = Array.isArray(record.data) ? asRecord(record.data[0]) : null;
  const roots = [record, dataRecord, resultRecord, payloadRecord, messageRecord, dataArrayFirst];
  for (const root of roots) {
    if (!root) {
      continue;
    }
    const candidates = [
      root.message_id,
      root.messageId,
      root.messageGuid,
      root.message_guid,
      root.guid,
      root.id,
      root.uuid
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        return String(candidate);
      }
    }
  }
  return "unknown";
}
export {
  extractBlueBubblesMessageId,
  resolveBlueBubblesSendTarget
};
