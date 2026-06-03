import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";

const REDACT_OPTIONS = { mode: "tools" as const };

export function redactUrlForLog(value: string, maxLength?: number): string {
  const redacted = redactSensitiveText(stripUrlSecrets(value), REDACT_OPTIONS);
  if (maxLength === undefined || redacted.length <= maxLength) {
    return redacted;
  }
  return `${redacted.slice(0, maxLength)}...`;
}

export function redactTextForLog(value: string): string {
  return redactSensitiveText(stripUrlSecretsInText(value), REDACT_OPTIONS);
}

function stripUrlSecretsInText(value: string): string {
  return value.replace(/(?:https?:\/\/|\/\/)[^\s"'<>]+/gu, (match) => stripUrlSecrets(match));
}

function stripUrlSecrets(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  try {
    const protocolRelative = trimmed.startsWith("//");
    const parsed = new URL(protocolRelative ? `https:${trimmed}` : trimmed);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    const clean = parsed.toString();
    return protocolRelative ? clean.replace(/^https:/u, "") : clean;
  } catch {
    return value;
  }
}
