/**
 * Minimal error helpers for A2A gateway handlers.
 * Kept intentionally small — no core errorShape graph duplication.
 */

export const A2AErrorCodes = {
  INVALID_REQUEST: "INVALID_REQUEST",
  NOT_FOUND: "NOT_FOUND",
  INTERNAL: "INTERNAL",
} as const;

export type A2AErrorCode = (typeof A2AErrorCodes)[keyof typeof A2AErrorCodes];

export function a2aError(
  code: A2AErrorCode,
  message: string,
): { code: A2AErrorCode; message: string } {
  return { code, message };
}
