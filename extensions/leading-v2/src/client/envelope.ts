export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Map a leading-v2.0 error/login envelope to a tool error string, or null when
 * the response looks OK. The PHP backend signals failure via `login` (not
 * authorized) or `code === "danger"` with a user-facing `message`.
 */
export function envelopeError(res: Record<string, unknown>): string | null {
  if (res.login) {
    return "Backend rejected the request (not authorized for this account).";
  }
  if (res.code === "danger") {
    return asString(res.message) ?? "Backend returned an error.";
  }
  return null;
}
