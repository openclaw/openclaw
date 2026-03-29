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
  sanitized = sanitized.replace(/authorization:\s*bearer\s+[a-z0-9\-._~+/=]+/gi, "authorization: [REDACTED]");
  sanitized = sanitized.replace(/\b(x-)?api[-_ ]?key\s*[:=]?\s*[^\s,;]+/gi, "$1api-key [REDACTED]");
  sanitized = sanitized.replace(/\b(api[-_ ]?token|token)\s*[:=]?\s*[^\s,;]+/gi, "$1 [REDACTED]");
  sanitized = sanitized.replace(/\bbasic\s+[a-z0-9+/=]{12,}\b/gi, "basic [REDACTED]");
  return sanitized;
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}…`;
}
