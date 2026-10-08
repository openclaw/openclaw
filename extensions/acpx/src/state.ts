import {
  asFiniteNumber,
  asOptionalObjectRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export const ACPX_PROCESS_LEASE_NAMESPACE = "process-leases";
export const ACPX_PROCESS_LEASE_MAX_ENTRIES = 4096;

export const ACPX_GATEWAY_INSTANCE_NAMESPACE = "gateway-instance";
export const ACPX_GATEWAY_INSTANCE_KEY = "current";
export const ACPX_GATEWAY_INSTANCE_MAX_ENTRIES = 1;

export type AcpxGatewayInstanceRecord = {
  instanceId: string;
  createdAt: number;
};

export function normalizeAcpxGatewayInstanceRecord(
  value: unknown,
): AcpxGatewayInstanceRecord | undefined {
  const record = asOptionalObjectRecord(value);
  const instanceId = normalizeOptionalString(record?.instanceId);
  if (!instanceId) {
    return undefined;
  }
  return {
    instanceId,
    createdAt: Math.trunc(asFiniteNumber(record?.createdAt) ?? 0),
  };
}
