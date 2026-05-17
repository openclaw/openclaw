const MAX_RAW_UPDATE_STRING = 500;
const MAX_RAW_UPDATE_ARRAY = 20;
const REDACTED_TELEGRAM_FIELD = "[redacted]";
const TELEGRAM_RAW_UPDATE_ALWAYS_REDACT_KEYS = new Set([
  "author_signature",
  "caption",
  "chat_instance",
  "data",
  "email",
  "file_id",
  "file_unique_id",
  "first_name",
  "invite_link",
  "last_name",
  "phone_number",
  "query",
  "text",
  "title",
  "url",
  "username",
]);
const TELEGRAM_RAW_UPDATE_ID_REDACT_KEYS = new Set([
  "chat_id",
  "custom_emoji_id",
  "migrate_from_chat_id",
  "migrate_to_chat_id",
  "sender_chat_id",
  "user_id",
]);
const TELEGRAM_RAW_UPDATE_ID_REDACT_PARENTS = new Set([
  "chat",
  "from",
  "sender_chat",
  "sender_user",
  "user",
  "via_bot",
]);
const TELEGRAM_RAW_UPDATE_USER_OBJECT_KEYS = new Set([
  "administrator",
  "bot",
  "creator",
  "forward_from",
  "forward_from_chat",
  "left_chat_member",
  "new_chat_member",
  "new_chat_members",
  "old_chat_member",
  "reply_to_message",
]);

function shouldRedactTelegramRawUpdateValue(key: string, parentKey: string | undefined): boolean {
  if (!key) {
    return false;
  }
  if (TELEGRAM_RAW_UPDATE_ALWAYS_REDACT_KEYS.has(key)) {
    return true;
  }
  if (TELEGRAM_RAW_UPDATE_ID_REDACT_KEYS.has(key)) {
    return true;
  }
  if (key === "id") {
    return parentKey !== undefined && TELEGRAM_RAW_UPDATE_ID_REDACT_PARENTS.has(parentKey);
  }
  return false;
}

function shouldTreatTelegramRawUpdateObjectAsPrivate(
  key: string,
  value: Record<string, unknown>,
): boolean {
  if (!TELEGRAM_RAW_UPDATE_USER_OBJECT_KEYS.has(key)) {
    return false;
  }
  return (
    typeof value.id === "number" ||
    typeof value.username === "string" ||
    typeof value.first_name === "string" ||
    typeof value.last_name === "string"
  );
}

export function stringifyTelegramRawUpdateForLog(update: unknown): string {
  const seen = new WeakSet<object>();
  const transform = (value: unknown, key = "", parentKey?: string): unknown => {
    if (shouldRedactTelegramRawUpdateValue(key, parentKey)) {
      return REDACTED_TELEGRAM_FIELD;
    }
    if (typeof value === "string") {
      return value.length > MAX_RAW_UPDATE_STRING
        ? `${value.slice(0, MAX_RAW_UPDATE_STRING)}...`
        : value;
    }
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_RAW_UPDATE_ARRAY).map((item) => transform(item, key, key));
      if (value.length > MAX_RAW_UPDATE_ARRAY) {
        items.push(`...(${value.length - MAX_RAW_UPDATE_ARRAY} more)`);
      }
      return items;
    }
    if (value && typeof value === "object") {
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);
      const record = value as Record<string, unknown>;
      if (shouldTreatTelegramRawUpdateObjectAsPrivate(key, record)) {
        return REDACTED_TELEGRAM_FIELD;
      }
      const redacted: Record<string, unknown> = {};
      for (const [entryKey, entryValue] of Object.entries(record)) {
        redacted[entryKey] = transform(entryValue, entryKey, key);
      }
      return redacted;
    }
    return value;
  };
  return JSON.stringify(transform(update ?? null));
}
