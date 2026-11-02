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
