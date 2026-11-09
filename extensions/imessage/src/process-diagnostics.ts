import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export function describeIMessageAutomationFailure(
  data: unknown,
  remoteHost?: string,
): string | undefined {
  const failure = asOptionalRecord(data);
  if (failure?.transport !== "applescript" || typeof failure.detail !== "string") {
    return undefined;
  }
  const code = /^Messages automation failed with AppleScript error (-1712|-1743)\.$/u.exec(
    failure.detail,
  )?.[1];
  if (!code) {
    return undefined;
  }
  // A timeout is not proof of denial. Guidance must not change retry classification
  // or trigger another send; the RPC's structured disposition remains authoritative.
  const reason =
    code === "-1743"
      ? "Messages Automation was denied."
      : "Messages Automation timed out. A missing Automation grant is one possible cause.";
  const context = remoteHost
    ? "Check System Settings > Privacy & Security > Automation for the SSH/wrapper process on the Messages Mac, not this Gateway's local runtime or Terminal."
    : "Check System Settings > Privacy & Security > Automation for the Gateway/launcher on the Messages Mac. " +
      "Local Gateway runtime: " +
      JSON.stringify(process.execPath) +
      ". " +
      "An app update that switches Node to Bun or moves the Gateway to a new runtime path needs this grant once; review the process macOS identifies, not just Terminal or OpenClaw.app.";
  return reason + " " + context + " Channel probes do not verify sending.";
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
    "If this started after an OpenClaw update, you may need to allow access again. For an app-managed or remote Gateway, check the actual launcher or SSH/wrapper process on the Messages Mac. " +
    "Check whether your message was delivered and review queued replies before retrying to avoid duplicates. " +
    "Technical details: Messages automation failed with AppleScript error " +
    code +
    "."
  );
}
