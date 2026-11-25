import type { SessionPermissionMode } from "../../packages/gateway-protocol/src/schema/sessions-row.js";

/** A retained mode is a ceiling; unset mode keeps config and host approval policy. */
export function intersectSessionPermissionModes(
  retained: SessionPermissionMode | undefined,
  current: SessionPermissionMode | undefined,
): SessionPermissionMode | undefined {
  if (retained === current) {
    return retained;
  }
  if (retained === "read-only" || current === "read-only") {
    return "read-only";
  }
  if (retained === "full") {
    return current;
  }
  if (current === "full") {
    return retained;
  }
  if (retained === undefined || current === undefined) {
    throw new Error(
      "The session changed between default and explicit permissions; start a new turn under the current policy.",
    );
  }
  return retained === "guarded" || current === "guarded" ? "guarded" : "workspace";
}
