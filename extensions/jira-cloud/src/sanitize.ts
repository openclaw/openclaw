export function redactSecret(value: string, secret: string): string {
  if (!secret) {
    return value;
  }
  return value.split(secret).join("[REDACTED]");
}

export function redactSecrets(value: string, secrets: string[]): string {
  let sanitized = value;
  for (const secret of secrets) {
    sanitized = redactSecret(sanitized, secret);
  }
  sanitized = sanitized.replace(/authorization:\s*basic\s+[a-z0-9+/=]+/gi, "authorization: [REDACTED]");
  sanitized = sanitized.replace(/\b(api[-_ ]?token|token)\s*[:=]?\s*[^\s,;]+/gi, "$1 [REDACTED]");
  return sanitized;
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}…`;
}
