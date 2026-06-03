import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";

const REDACT_OPTIONS = { mode: "tools" as const };

export function redactUrlForLog(value: string): string {
  return redactSensitiveText(stripUrlSecrets(value), REDACT_OPTIONS);
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
    return stripMalformedUrlSecrets(value);
  }
}

function stripMalformedUrlSecrets(value: string): string {
  return value
    .replace(/#.*$/su, "")
    .replace(/\?.*$/su, "")
    .replace(/^((?:[a-z][a-z\d+.-]*:)?\/\/)[^/@\s"'<>]*@/iu, "$1");
}
