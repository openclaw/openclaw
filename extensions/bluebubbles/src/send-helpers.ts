import { normalizeBlueBubblesHandle, parseBlueBubblesTarget } from "./targets.js";
import type { BlueBubblesSendTarget } from "./types.js";

export function resolveBlueBubblesSendTarget(raw: string): BlueBubblesSendTarget {
  const parsed = parseBlueBubblesTarget(raw);
  if (parsed.kind === "handle") {
    return {
      kind: "handle",
      address: normalizeBlueBubblesHandle(parsed.to),
      service: parsed.service,
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

export function extractBlueBubblesMessageId(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "unknown";
  }
  const record = payload as Record<string, unknown>;
  const data =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : null;
  const candidates = [
    record.messageId,
    record.messageGuid,
    record.message_guid,
    record.guid,
    record.id,
    data?.messageId,
    data?.messageGuid,
    data?.message_guid,
    data?.message_id,
    data?.guid,
    data?.id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return String(candidate);
    }
  }
  return "unknown";
}
