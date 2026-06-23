// Caller allowlist helpers for provider-normalized phone numbers.

/** Normalize a phone number to digits only. */
export function normalizePhoneNumber(input?: string): string {
  if (!input) {
    return "";
  }
  return input.replace(/\D/g, "");
}

/**
 * Return true when the caller matches an allowlist entry — by phone number
 * (digits only) OR by exact caller id, case-insensitive. The id match lets
 * providers whose caller id is not a phone number (e.g. the Microsoft Teams
 * `aadId`, an AAD object id) use the allowlist without being phone-normalized.
 * `from` may be a raw caller id or an already-normalized phone string.
 */
export function isAllowlistedCaller(
  from: string | undefined,
  allowFrom: string[] | undefined,
): boolean {
  const raw = from?.trim();
  if (!raw) {
    return false;
  }
  const idFrom = raw.toLowerCase();
  const normalizedFrom = normalizePhoneNumber(raw);
  return (allowFrom ?? []).some((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) {
      return false;
    }
    // Exact caller-id match (e.g. a Teams AAD object id), case-insensitive.
    if (trimmed.toLowerCase() === idFrom) {
      return true;
    }
    // Phone-number match (digits only).
    const normalizedAllow = normalizePhoneNumber(trimmed);
    return normalizedAllow !== "" && normalizedFrom !== "" && normalizedAllow === normalizedFrom;
  });
}

/**
 * Inbound-policy decision. Mirrors the switch in `manager/events.ts`
 * `shouldAcceptInbound` so paths that do not route through the CallManager
 * (e.g. the msteams realtime bridge) accept/reject callers identically.
 * `from` is the caller id — a phone number, or a Teams `aadId` for msteams.
 * `isAllowlistedCaller` matches either form (phone digits or exact id).
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
      return isAllowlistedCaller(from, allowFrom);
    default:
      // "disabled" or unset → reject (config validation already blocks
      // realtime + "disabled"; this is defensive).
      return false;
  }
}
