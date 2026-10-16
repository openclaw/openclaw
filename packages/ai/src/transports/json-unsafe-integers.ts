/**
 * JSON parsing helpers that preserve integer literals larger than
 * Number.MAX_SAFE_INTEGER as strings before JSON.parse can round them.
 */
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";

const MAX_SAFE_INTEGER_ABS_STR = String(Number.MAX_SAFE_INTEGER);
// Consume strings atomically so digits in text and escaped quotes stay untouched.
// JSON.parse owns syntax validation; this scan only preserves integer precision.
const JSON_STRING_OR_NUMBER_RE =
  /"(?:\\[\s\S]|[^"\\])*"?|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function isUnsafeIntegerLiteral(token: string): boolean {
  const digits = token[0] === "-" ? token.slice(1) : token;
  return (
    digits.length > MAX_SAFE_INTEGER_ABS_STR.length ||
    (digits.length === MAX_SAFE_INTEGER_ABS_STR.length && digits > MAX_SAFE_INTEGER_ABS_STR)
  );
}

/** Quotes integer literals above Number.MAX_SAFE_INTEGER before JSON.parse. */
export function quoteUnsafeIntegerLiterals(input: string): string {
  if (!/(?:^|\D)\d{16}/.test(input)) {
    return input;
  }
  return input.replace(JSON_STRING_OR_NUMBER_RE, (token, offset: number) =>
    token[0] !== '"' &&
    !/[.eE]/.test(token) &&
    // An incomplete fraction/exponent is not an integer; callers classify malformed JSON separately.
    !/[.eE]/.test(input.charAt(offset + token.length)) &&
    isUnsafeIntegerLiteral(token)
      ? `"${token}"`
      : token,
  );
}

/** Parses JSON while preserving unsafe integer literals as strings. */
export function parseJsonPreservingUnsafeIntegers(input: string): unknown {
  return JSON.parse(quoteUnsafeIntegerLiterals(input)) as unknown;
}

/** Parses or accepts an object while preserving unsafe integer literals in string input. */
export function parseJsonObjectPreservingUnsafeIntegers(
  value: unknown,
): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return asNullableRecord(parseJsonPreservingUnsafeIntegers(value));
    } catch {
      return null;
    }
  }
  return asNullableRecord(value);
}
