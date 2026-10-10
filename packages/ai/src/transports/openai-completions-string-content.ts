/**
 * OpenAI Chat Completions compatibility helpers. Some providers only accept
 * role/content messages with plain string content instead of text block arrays.
 */
import {
  asOptionalObjectRecord,
  asOptionalRecord,
} from "@openclaw/normalization-core/record-coerce";

/** Flatten string-only text block content arrays into newline-joined strings. */
export function flattenCompletionMessagesToStringContent(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    const record = asOptionalObjectRecord(message);
    const content = record?.content;
    if (!Array.isArray(content)) {
      return message;
    }
    const textParts: string[] = [];
    for (const item of content) {
      const part = asOptionalObjectRecord(item);
      if (part?.type !== "text" || typeof part.text !== "string") {
        return message;
      }
      textParts.push(part.text);
    }
    return {
      ...record,
      content: textParts.join("\n"),
    };
  });
}

/** Strip completion messages to role/content fields for strict providers. */
export function stripCompletionMessagesToRoleContent(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    const record = asOptionalRecord(message);
    if (!record) {
      return message;
    }
    return {
      ...(Object.hasOwn(record, "role") ? { role: record.role } : {}),
      ...(Object.hasOwn(record, "content") ? { content: record.content } : {}),
    };
  });
}
