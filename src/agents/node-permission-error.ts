import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import {
  readNodePermissionRequest,
  type NodePermissionRequest,
} from "../../packages/gateway-protocol/src/node-permissions.js";

/** Tool wrappers add context with Error.cause; retain the typed native refusal. */
export function readNodePermissionError(error: unknown): NodePermissionRequest | undefined {
  const seen = new Set<unknown>();
  for (let candidate = error; candidate && !seen.has(candidate);) {
    seen.add(candidate);
    const record = asOptionalObjectRecord(candidate);
    const details = asOptionalObjectRecord(record?.details);
    const permission = readNodePermissionRequest(details?.permissionMissing);
    if (permission) {
      return permission;
    }
    candidate = record?.cause;
  }
  return undefined;
}
