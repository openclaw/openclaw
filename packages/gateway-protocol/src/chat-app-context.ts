import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isQuestionThumbnail } from "./question-media.js";

/** Display-only receipt of the App references shared with a user turn. */
export type ChatAppContextAttachment = {
  title: string;
  uri?: string;
  icon?: string;
  description?: string;
};
export const CHAT_APP_CONTEXT_LIMITS = {
  items: 16,
  title: 200,
  uri: 2048,
  icon: 8192,
  description: 4096,
} as const;

/** Read persisted/untrusted display metadata; never interprets references as model input. */
export function readChatAppContext(value: unknown): ChatAppContextAttachment[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > CHAT_APP_CONTEXT_LIMITS.items) {
    return undefined;
  }
  const result: ChatAppContextAttachment[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.title !== "string" ||
      !entry.title.trim() ||
      entry.title.length > CHAT_APP_CONTEXT_LIMITS.title
    ) {
      return undefined;
    }
    const item: ChatAppContextAttachment = { title: entry.title };
    for (const key of ["uri", "icon", "description"] as const) {
      const field = entry[key];
      if (field === undefined) {
        continue;
      }
      if (typeof field !== "string" || field.length > CHAT_APP_CONTEXT_LIMITS[key]) {
        return undefined;
      }
      if (key !== "icon" || isQuestionThumbnail(field)) {
        item[key] = field;
      }
    }
    result.push(item);
  }
  return result;
}
