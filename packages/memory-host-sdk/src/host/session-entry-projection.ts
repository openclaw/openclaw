import {
  asOptionalObjectRecord,
  asOptionalRecord,
} from "@openclaw/normalization-core/record-coerce";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";

export function collectRawSessionText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    const record = asOptionalObjectRecord(block);
    if (record?.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/** Retain memory's input facts, not tool results, attachments, or provider replay payloads. */
export function projectSessionEntryRecord(value: unknown): unknown {
  const record = asOptionalRecord(value);
  if (!record) {
    return null;
  }
  const message = record.type === "message" ? asOptionalRecord(record.message) : undefined;
  const metadata = asOptionalRecord(message?.["__openclaw"]);
  const provenance = asOptionalRecord(message?.provenance);
  const data = asOptionalRecord(record.data);
  const timestamp = (candidate: unknown) =>
    typeof candidate === "string" || typeof candidate === "number" ? candidate : undefined;
  return {
    type: readStringValue(record.type),
    id: readStringValue(record.id),
    firstKeptEntryId:
      record.firstKeptEntryId === undefined
        ? undefined
        : (readStringValue(record.firstKeptEntryId) ?? null),
    customType: readStringValue(record.customType),
    runId: readStringValue(record.runId),
    sessionKey: readStringValue(record.sessionKey),
    data: { runId: readStringValue(data?.runId), sessionKey: readStringValue(data?.sessionKey) },
    timestamp: timestamp(record.timestamp),
    message: message
      ? {
          role: readStringValue(message.role),
          timestamp: timestamp(message.timestamp),
          content:
            message.role === "user" || message.role === "assistant"
              ? collectRawSessionText(message.content)
              : null,
          provenance: {
            kind: readStringValue(provenance?.kind),
            sourceTool: readStringValue(provenance?.sourceTool),
          },
          __openclaw: {
            runId: readStringValue(metadata?.runId),
            senderIsOwner: metadata?.senderIsOwner === true,
            turnTainted: metadata?.turnTainted === true,
          },
        }
      : undefined,
  };
}
