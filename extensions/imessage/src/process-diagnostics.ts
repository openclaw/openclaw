import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

const PUBLIC_IMESSAGE_FULL_DISK_ACCESS_ERROR =
  "imsg cannot access ~/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.";

export function normalizeIMessageFullDiskAccessError(message: string): string | undefined {
  const normalized = normalizeLowercaseStringOrEmpty(message);
  return normalized.includes("full disk access") && normalized.includes("chat.db")
    ? PUBLIC_IMESSAGE_FULL_DISK_ACCESS_ERROR
    : undefined;
}

export function normalizeIMessageAutomationError(message: string): string | undefined {
  const code = /Messages automation failed with AppleScript error (-1712|-1743)(?![0-9])/i.exec(
    message,
  )?.[1];
  if (!code) {
    return undefined;
  }
  return (
    "Messages automation failed with AppleScript error " +
    code +
    ". " +
    (code === "-1712"
      ? "Messages timed out; check for an unresponsive Messages.app or a hidden permission prompt. "
      : "Messages Automation is not authorized. ") +
    "On the Messages Mac, open System Settings > Privacy & Security > Automation and allow Messages for the process running imsg. " +
    "For an app-managed background Gateway, check the current Gateway runtime (bun), not Terminal or the previous node/bun runtime. " +
    "An app update can change this permission identity. After granting access, verify delivery and queued replies before retrying from the Gateway."
  );
}
