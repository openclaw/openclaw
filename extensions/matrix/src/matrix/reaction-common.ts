import {
  asOptionalObjectRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export const MATRIX_ANNOTATION_RELATION_TYPE = "m.annotation";
export const MATRIX_REACTION_EVENT_TYPE = "m.reaction";

export type MatrixReactionSummary = {
  key: string;
  count: number;
  users: string[];
};

type MatrixReactionAnnotation = {
  key: string;
  eventId?: string;
};

type MatrixReactionEventLike = {
  content?: unknown;
  sender?: string | null;
  event_id?: string | null;
};

function normalizeMatrixReactionValue(value: string, field: "messageId" | "emoji"): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Matrix reaction requires ${field === "emoji" ? "an emoji" : "a messageId"}`);
  }
  return normalized;
}

export function buildMatrixReactionContent(
  messageId: string,
  emoji: string,
): {
  "m.relates_to": {
    rel_type: typeof MATRIX_ANNOTATION_RELATION_TYPE;
    event_id: string;
    key: string;
  };
} {
  return {
    "m.relates_to": {
      rel_type: MATRIX_ANNOTATION_RELATION_TYPE,
      event_id: normalizeMatrixReactionValue(messageId, "messageId"),
      key: normalizeMatrixReactionValue(emoji, "emoji"),
    },
  };
}

export function buildMatrixReactionRelationsPath(roomId: string, messageId: string): string {
  return `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(normalizeMatrixReactionValue(messageId, "messageId"))}/${MATRIX_ANNOTATION_RELATION_TYPE}/${MATRIX_REACTION_EVENT_TYPE}`;
}

export function extractMatrixReactionAnnotation(
  content: unknown,
): MatrixReactionAnnotation | undefined {
  const relatesTo = asOptionalObjectRecord(asOptionalObjectRecord(content)?.["m.relates_to"]);
  if (!relatesTo) {
    return undefined;
  }
  if (
    typeof relatesTo.rel_type === "string" &&
    relatesTo.rel_type !== MATRIX_ANNOTATION_RELATION_TYPE
  ) {
    return undefined;
  }
  const key = normalizeOptionalString(relatesTo.key) ?? "";
  if (!key) {
    return undefined;
  }
  const eventId = normalizeOptionalString(relatesTo.event_id) ?? "";
  return {
    key,
    eventId: eventId || undefined,
  };
}

export function summarizeMatrixReactionEvents(
  events: Iterable<Pick<MatrixReactionEventLike, "content" | "sender">>,
): MatrixReactionSummary[] {
  const summaries = new Map<string, MatrixReactionSummary>();
  for (const event of events) {
    const key = extractMatrixReactionAnnotation(event.content)?.key;
    if (!key) {
      continue;
    }
    const sender = normalizeOptionalString(event.sender) ?? "";
    const entry = summaries.get(key) ?? { key, count: 0, users: [] };
    entry.count += 1;
    if (sender && !entry.users.includes(sender)) {
      entry.users.push(sender);
    }
    summaries.set(key, entry);
  }
  return Array.from(summaries.values());
}

export function selectOwnMatrixReactionEventIds(
  events: Iterable<Pick<MatrixReactionEventLike, "content" | "event_id" | "sender">>,
  userId: string,
  emoji?: string,
): string[] {
  const senderId = normalizeOptionalString(userId) ?? "";
  if (!senderId) {
    return [];
  }
  const targetEmoji = normalizeOptionalString(emoji);
  const ids: string[] = [];
  for (const event of events) {
    if ((normalizeOptionalString(event.sender) ?? "") !== senderId) {
      continue;
    }
    if (targetEmoji && extractMatrixReactionAnnotation(event.content)?.key !== targetEmoji) {
      continue;
    }
    const eventId = normalizeOptionalString(event.event_id);
    if (eventId) {
      ids.push(eventId);
    }
  }
  return ids;
}
