import {
  ErrorCodes,
  GatewayErrorDetailCodes,
  type SessionWorkspaceRecoveryRequiredErrorDetails,
} from "./gateway-error-details.js";
import { asProtocolRecord, isNonEmptyProtocolString } from "./protocol-value-normalization.js";

/** Reads an exact pending-workspace recovery route without parsing operator-facing prose. */
export function readSessionWorkspaceRecoveryRequiredError(
  error: unknown,
): SessionWorkspaceRecoveryRequiredErrorDetails | null {
  const record = asProtocolRecord(error);
  const details = asProtocolRecord(record?.details);
  const source = asProtocolRecord(details?.source);
  if (
    record?.code !== ErrorCodes.UNAVAILABLE ||
    details?.code !== GatewayErrorDetailCodes.SESSION_WORKSPACE_RECOVERY_REQUIRED ||
    details.cause !== "device_offline" ||
    details.recoveryAction !== "continue_on_gateway" ||
    !isNonEmptyProtocolString(details.sessionId) ||
    typeof source?.generation !== "number" ||
    !Number.isSafeInteger(source.generation) ||
    source.generation < 0 ||
    !isNonEmptyProtocolString(source.environmentId) ||
    typeof source.ownerEpoch !== "number" ||
    !Number.isSafeInteger(source.ownerEpoch) ||
    source.ownerEpoch < 1
  ) {
    return null;
  }
  return {
    code: details.code,
    cause: details.cause,
    recoveryAction: details.recoveryAction,
    sessionId: details.sessionId,
    source: {
      generation: source.generation,
      environmentId: source.environmentId,
      ownerEpoch: source.ownerEpoch,
    },
  };
}
