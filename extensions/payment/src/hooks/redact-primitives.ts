/**
 * redact-primitives.ts — Shared PAN/CVV detection primitives.
 *
 * Extracted so that both store.ts (via inline copy, unchanged) and the
 * before_message_write redaction hook can detect card-shaped strings using
 * the same logic. Do not add state or side effects here.
 *
 * NOTE: store.ts retains its own inline copy of luhnCheck/isPanShape/CVV_KEY_PATTERN
 * to avoid a circular import. These implementations MUST stay in sync.
 * Any change here must be mirrored in store.ts and vice versa.
 */

/**
 * Luhn check. Returns true if the digit string passes the Luhn algorithm.
 */
export function luhnCheck(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i]!, 10);
    if (alternate) {
      n *= 2;
      if (n > 9) {
        n -= 9;
      }
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/**
 * Returns true if the string (stripped of spaces/dashes) looks like a PAN:
 * 13-19 digits and passes Luhn check.
 */
export function isPanShape(value: string): boolean {
  const digits = value.replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(digits)) {
    return false;
  }
  return luhnCheck(digits);
}

/** Key names that indicate a CVV-like value. Case-insensitive. */
export const CVV_KEY_PATTERN = /^(cvv2?|cvc2?|card_?security_?code|security_?code)$/i;

/**
 * Recursively scan an arbitrary value for PAN-shaped strings or CVV-key context strings.
 * Returns a detection result on first match, or undefined if no card data found.
 *
 * Safe preview: returns last4 only for PAN, "[cvv]" for CVV context.
 * NEVER returns the full value in the result.
 */
export function scanForCardData(
  value: unknown,
): { kind: "pan" | "cvv"; preview: string } | undefined {
  return _scan(value, null, new WeakSet<object>());
}

function _scan(
  value: unknown,
  parentKey: string | null,
  seen: WeakSet<object>,
): { kind: "pan" | "cvv"; preview: string } | undefined {
  try {
    if (value === null || value === undefined) return undefined;

    if (typeof value === "string") {
      // CVV-key context: flag any string when parentKey matches CVV pattern
      if (parentKey !== null && CVV_KEY_PATTERN.test(parentKey)) {
        // Only flag if it looks like a CVV (3-4 digits)
        if (/^\d{3,4}$/.test(value.trim())) {
          return { kind: "cvv", preview: "[cvv]" };
        }
      }
      // PAN-shaped string
      if (isPanShape(value)) {
        // Safe preview: last4 only
        const digits = value.replace(/[\s-]/g, "");
        return { kind: "pan", preview: `••${digits.slice(-4)}` };
      }
      return undefined;
    }

    if (typeof value === "number" || typeof value === "boolean") return undefined;

    if (Array.isArray(value)) {
      if (seen.has(value)) return undefined;
      seen.add(value);
      for (const item of value) {
        const found = _scan(item, parentKey, seen);
        if (found) return found;
      }
      return undefined;
    }

    if (typeof value === "object") {
      if (seen.has(value as object)) return undefined;
      seen.add(value as object);
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const found = _scan(child, key, seen);
        if (found) return found;
      }
      return undefined;
    }

    return undefined;
  } catch {
    // Fail-closed: any error in scanning must not suppress the check.
    return undefined;
  }
}
