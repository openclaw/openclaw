const KEY_VALUE_PATTERNS: RegExp[] = [
  /\b(authorization|token|access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret|cookie)=([^\s,;]+)/gi,
  /\b(authorization|token|access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret|cookie):\s*([^\s,;]+)/gi,
];

const BEARER_PATTERN = /\b(Bearer)\s+([A-Za-z0-9._~+/=-]+)/gi;

export function redactSensitiveText(text: string): string {
  let redacted = text;

  for (const pattern of KEY_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, (_match, key: string) => `${key}=[redacted]`);
  }

  return redacted.replace(BEARER_PATTERN, "$1 [redacted]");
}
