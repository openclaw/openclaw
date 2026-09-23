import { buildApprovalResponse } from "./approval-bridge.js";
import { isJsonObject, type JsonValue } from "./protocol.js";

/** Builds the method-specific fail-closed response after turn admission seals. */
export function buildCodexAppServerApprovalRejectionResponse(
  method: string,
  requestParams: JsonValue | undefined,
): JsonValue {
  return buildApprovalResponse(
    method,
    isJsonObject(requestParams) ? requestParams : undefined,
    "denied",
  );
}
