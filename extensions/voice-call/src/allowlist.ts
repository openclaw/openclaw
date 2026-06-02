/** Normalizes PSTN caller ids to digits-only strings for allowlist comparisons. */
export function normalizePhoneNumber(input?: string): string {
  if (!input) {
    return "";
  }
  return input.replace(/\D/g, "");
}

/** Checks a pre-normalized caller id against configured phone-number allowlist entries. */
export function isAllowlistedCaller(
  normalizedFrom: string,
  allowFrom: string[] | undefined,
): boolean {
  if (!normalizedFrom) {
    return false;
  }
  return (allowFrom ?? []).some((num) => {
    const normalizedAllow = normalizePhoneNumber(num);
    return normalizedAllow !== "" && normalizedAllow === normalizedFrom;
  });
}
