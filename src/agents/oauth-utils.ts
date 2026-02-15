const DEFAULT_EXPIRES_BUFFER_MS = 5 * 60 * 1000;

/**
 * Convert an OAuth `expires_in` (seconds) value to an absolute timestamp (ms),
 * subtracting a 5-minute buffer so we refresh before the token actually expires.
 */
export function coerceExpiresAt(expiresInSeconds: number, now: number): number {
  const value = now + Math.max(0, Math.floor(expiresInSeconds)) * 1000 - DEFAULT_EXPIRES_BUFFER_MS;
  return Math.max(value, now + 30_000);
}
