/** Shared phone number helpers. */

/**
 * Normalize a phone number to a canonical form: digits only, no leading +,
 * and for Mexican numbers strip the legacy "1" after country code 52.
 *
 * Variants handled:
 *   +5216671234567 → 526671234567
 *    5216671234567 → 526671234567
 *   +526671234567  → 526671234567
 *    526671234567  → 526671234567  (already canonical)
 *
 * Non-MX numbers are stripped of non-digits only.
 */
export function normalizePhone(phone: string): string {
  // Strip everything that isn't a digit
  let digits = phone.replace(/\D/g, "");

  // Mexican numbers: remove the legacy "1" after country code "52"
  // A Mexican mobile is 52 + 10-digit number = 12 digits.
  // With the legacy 1 it's 52 + 1 + 10-digit = 13 digits.
  if (digits.length === 13 && digits.startsWith("521")) {
    digits = "52" + digits.slice(3);
  }

  return digits;
}
