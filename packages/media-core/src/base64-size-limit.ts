import { estimateBase64DecodedBytes } from "./base64.js";

/**
 * Validates base64 decoded size against a byte budget.
 * Returns error object without throwing, allowing caller to decide strategy.
 *
 * @param base64 - Base64 encoded string
 * @param maxBytes - Maximum allowed decoded bytes
 * @returns Error if exceeds limit, undefined otherwise
 *
 * @example
 * // Throw on error
 * const error = validateBase64SizeLimit(base64, maxBytes);
 * if (error) throw error;
 *
 * @example
 * // Return undefined on error
 * const error = validateBase64SizeLimit(base64, maxBytes);
 * if (error) return undefined;
 */
export function validateBase64SizeLimit(
  base64: string,
  maxBytes: number,
): Error | undefined {
  const estimated = estimateBase64DecodedBytes(base64);
  if (estimated > maxBytes) {
    return new Error(
      `Base64 payload exceeds size limit: ${estimated} bytes > ${maxBytes} bytes`,
    );
  }
  return undefined;
}