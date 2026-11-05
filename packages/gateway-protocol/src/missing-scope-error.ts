import type { Static } from "typebox";
import { ErrorCodes } from "./gateway-error-codes.js";
import { asProtocolRecord } from "./protocol-value-normalization.js";
import type * as ErrorSchemas from "./schema/error-codes.js";

export const MISSING_SCOPE_ERROR_CODE = "MISSING_SCOPE";

/** Missing operator-scope details shared by WebSocket and HTTP responses. */
export type MissingScopeErrorDetails = Static<typeof ErrorSchemas.MissingScopeErrorDetailsSchema>;

const LEGACY_MISSING_SCOPE_PATTERN = /\bmissing scope:\s*([a-z0-9._-]+)/i;

/** Reads validated missing-scope details from an untrusted protocol payload. */
export function readMissingScopeErrorDetails(details: unknown): MissingScopeErrorDetails | null {
  const record = asProtocolRecord(details);
  if (record?.code !== MISSING_SCOPE_ERROR_CODE) {
    return null;
  }
  const missingScope = typeof record.missingScope === "string" ? record.missingScope.trim() : "";
  const requiredScopes = Array.isArray(record.requiredScopes)
    ? record.requiredScopes.map((scope) => (typeof scope === "string" ? scope.trim() : ""))
    : [];
  if (!missingScope || requiredScopes.length === 0 || requiredScopes.some((scope) => !scope)) {
    return null;
  }
  return {
    code: MISSING_SCOPE_ERROR_CODE,
    missingScope,
    requiredScopes,
  };
}

/**
 * Reads a method-level missing-scope failure, preferring structured details.
 * The message fallback keeps clients compatible with gateways predating structured details.
 */
export function readMissingScopeError(error: unknown): MissingScopeErrorDetails | null {
  const record = asProtocolRecord(error);
  if (!record) {
    return null;
  }
  const structured = readMissingScopeErrorDetails(record.details);
  if (structured) {
    return structured;
  }
  const code =
    typeof record.gatewayCode === "string"
      ? record.gatewayCode
      : typeof record.code === "string"
        ? record.code
        : "";
  if (code !== ErrorCodes.FORBIDDEN && code !== ErrorCodes.INVALID_REQUEST) {
    return null;
  }
  const message = typeof record.message === "string" ? record.message : "";
  const missingScope = message.match(LEGACY_MISSING_SCOPE_PATTERN)?.[1];
  return missingScope
    ? {
        code: MISSING_SCOPE_ERROR_CODE,
        missingScope,
        requiredScopes: [missingScope],
      }
    : null;
}
