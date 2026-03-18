// Authored by: cc (Claude Code) | 2026-03-17

/** Strip all non-digit characters for comparison (mirrors voice-call/src/allowlist.ts). */
export function normalizePhoneNumber(input?: string): string {
  if (!input) {
    return "";
  }
  return input.replace(/\D/g, "");
}

/** Return true if the digit-normalized sender matches any number in the allowlist. */
export function isAllowlistedSender(
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
