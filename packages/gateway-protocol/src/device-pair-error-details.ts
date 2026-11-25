import { isProtocolRecord } from "./protocol-value-normalization.js";

/** Structured device-pairing details carried in gateway error payloads. */
export const DevicePairErrorDetailCodes = {
  /** A setup code was refused because no phone can reach a loopback-only Gateway. */
  GATEWAY_LOOPBACK_ONLY: "DEVICE_PAIR_GATEWAY_LOOPBACK_ONLY",
} as const;

export function isDevicePairGatewayLoopbackOnlyError(error: unknown): boolean {
  const details = isProtocolRecord(error) ? error.details : undefined;
  return (
    isProtocolRecord(details) && details.code === DevicePairErrorDetailCodes.GATEWAY_LOOPBACK_ONLY
  );
}
