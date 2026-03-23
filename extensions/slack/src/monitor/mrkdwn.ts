export function escapeSlackMrkdwn(value: string): string {
  // NOTE: We do NOT escape & because Slack's API handles entity encoding automatically.
  // Pre-escaping & causes double-encoding (& → &amp; → &#38;).
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([*_`~])/g, "\\$1");
}
