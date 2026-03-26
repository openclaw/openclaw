/**
 * Sanitize error messages to prevent control character injection in logs.
 */
export function sanitizeErrorMessage(err: unknown, maxLen = 200): string {
  let str = String(err);
  str = str.replace(/\p{C}/gu, "");
  return str.length > maxLen ? `${str.slice(0, maxLen)}...` : str;
}
