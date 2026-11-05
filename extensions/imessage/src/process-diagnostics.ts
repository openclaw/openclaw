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
    (code === "-1712"
      ? "Messages took too long to respond, so OpenClaw couldn't confirm your iMessage was sent. Open Messages on your Mac and approve any permission prompt. If the app is frozen, quit and reopen it. "
      : "OpenClaw couldn't send your iMessage because it doesn't have permission to control Messages. ") +
    "On the Mac running Messages, open System Settings > Privacy & Security > Automation and allow Messages access for the process running OpenClaw. " +
    'If this started after an OpenClaw update, you may need to allow access again. For an app-managed Gateway, look for "bun" in Automation settings. ' +
    "Check whether your message was delivered and review queued replies before retrying to avoid duplicates. " +
    "Technical details: Messages automation failed with AppleScript error " +
    code +
    "."
  );
}
