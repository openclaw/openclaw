export function normalizePhoneNumber(input?: string): string {
  return input?.replace(/\D/g, "") ?? "";
}

/** Return true when the normalized caller exactly matches an allowlist entry. */
export function isAllowlistedCaller(
  normalizedFrom: string,
  allowFrom: string[] | undefined,
): boolean {
  if (!normalizedFrom) {
    return false;
  }
  return (allowFrom ?? []).some((num) => normalizePhoneNumber(num) === normalizedFrom);
}
