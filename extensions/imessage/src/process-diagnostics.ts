import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

const PUBLIC_IMESSAGE_FULL_DISK_ACCESS_ERROR =
  "imsg cannot access ~/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.";

export function normalizeIMessageFullDiskAccessError(message: string): string | undefined {
  const normalized = normalizeLowercaseStringOrEmpty(message);
  return normalized.includes("full disk access") && normalized.includes("chat.db")
    ? PUBLIC_IMESSAGE_FULL_DISK_ACCESS_ERROR
    : undefined;
}
