// Gateway Protocol schema module defines protocol validation shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import type { ErrorShape } from "./frames.js";
import { NonEmptyString } from "./primitives.js";

/** Gateway JSON-RPC style error codes shared by clients and server handlers. */
export const ErrorCodes = {
  /** Client has not completed account/device linking for this gateway. */
  NOT_LINKED: "NOT_LINKED",
  /** Device exists but still needs an explicit pairing approval. */
  NOT_PAIRED: "NOT_PAIRED",
  /** Agent turn exceeded the gateway wait window. */
  AGENT_TIMEOUT: "AGENT_TIMEOUT",
  /** Request payload failed protocol validation or method preconditions. */
  INVALID_REQUEST: "INVALID_REQUEST",
  /** Authenticated caller lacks permission for the requested operation. */
  FORBIDDEN: "FORBIDDEN",
  /** Approval resolution referenced a missing or expired approval request. */
  APPROVAL_NOT_FOUND: "APPROVAL_NOT_FOUND",
  /** Gateway service or required backend is temporarily unavailable. */
  UNAVAILABLE: "UNAVAILABLE",
} as const;

/** Closed set of canonical gateway error code strings. */
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** Stable discriminants for structured method-level authorization failures. */
export const GatewayErrorDetailCodes = {
  MISSING_SCOPE: "MISSING_SCOPE",
} as const;

/** Missing operator-scope details shared by WebSocket and HTTP responses. */
export const MissingScopeErrorDetailsSchema = closedObject({
  code: Type.Literal(GatewayErrorDetailCodes.MISSING_SCOPE),
  missingScope: NonEmptyString,
  requiredScopes: Type.Array(NonEmptyString, { minItems: 1 }),
});

/** Structured details emitted by method-level authorization failures. */
export const GatewayErrorDetailsSchema = MissingScopeErrorDetailsSchema;

export type MissingScopeErrorDetails = Static<typeof MissingScopeErrorDetailsSchema>;
export type GatewayErrorDetails = Static<typeof GatewayErrorDetailsSchema>;

/** Builds the canonical gateway error payload while preserving optional retry metadata. */
export function errorShape(
  code: ErrorCode,
  message: string,
  opts?: { details?: unknown; retryable?: boolean; retryAfterMs?: number },
): ErrorShape {
  return {
    code,
    message,
    ...opts,
  };
}

/** Builds structured details for a missing operator scope. */
export function buildMissingScopeErrorDetails(params: {
  missingScope: string;
  requiredScopes: readonly string[];
}): MissingScopeErrorDetails {
  const requiredScopes =
    params.requiredScopes.length > 0 ? [...params.requiredScopes] : [params.missingScope];
  return {
    code: GatewayErrorDetailCodes.MISSING_SCOPE,
    missingScope: params.missingScope,
    requiredScopes,
  };
}

/** Builds a forbidden error for a missing operator scope without message parsing. */
export function missingScopeErrorShape(params: {
  missingScope: string;
  requiredScopes: readonly string[];
}): ErrorShape {
  const details = buildMissingScopeErrorDetails(params);
  return errorShape(ErrorCodes.FORBIDDEN, `missing scope: ${params.missingScope}`, { details });
}
