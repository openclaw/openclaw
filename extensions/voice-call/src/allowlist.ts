// Caller allowlist helpers for provider-normalized phone numbers.

/** Normalize a phone number to digits only. */
export function normalizePhoneNumber(input?: string): string {
  if (!input) {
    return "";
  }
  return input.replace(/\D/g, "");
}

/** Return true when the normalized caller exactly matches an allowlist entry. */
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

/**
 * Inbound-policy decision. Mirrors the switch in `manager/events.ts`
 * `shouldAcceptInbound` so paths that do not route through the CallManager
 * (e.g. the msteams realtime bridge) accept/reject callers identically.
 * `from` is the caller id — a phone number, or a Teams `aadId` for msteams
 * (which will not match a phone allowlist).
 */
export function isInboundCallAllowed(
  inboundPolicy: "disabled" | "allowlist" | "pairing" | "open" | undefined,
  allowFrom: string[] | undefined,
  from: string | undefined,
): boolean {
  switch (inboundPolicy) {
    case "open":
      return true;
    case "allowlist":
    case "pairing":
      return isAllowlistedCaller(normalizePhoneNumber(from), allowFrom);
    default:
      // "disabled" or unset → reject (config validation already blocks
      // realtime + "disabled"; this is defensive).
      return false;
  }
}
