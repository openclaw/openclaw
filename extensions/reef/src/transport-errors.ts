import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";

export function redactReefRelayErrorMessage(message: string, secrets: readonly string[]): string {
  let redacted = message;
  for (const secret of secrets) {
    if (secret.length > 0) {
      redacted = redacted.replaceAll(secret, "<redacted>");
    }
  }
  return redactSensitiveText(redacted, { mode: "tools" });
}
