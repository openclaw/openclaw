// Doctor and runtime share record policy without loading a state-store implementation.
import { createHash } from "node:crypto";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export const WARM_IMAGE_MAX_ENTRIES = 128;
export const LEGACY_WARM_LEASE_MAX_ENTRIES = 256;

export function crabboxLegacyWarmImageCaptureSelector(key: string, record: unknown): string {
  return `legacy-${createHash("sha256").update(JSON.stringify({ key, record })).digest("hex")}`;
}

// Recovery selectors bind the original row bytes; preserve property order and prefixes.
export const legacyLeaseSelector = (key: string, value: unknown) =>
  `legacy-lease-${createHash("sha256").update(JSON.stringify({ key, value })).digest("hex")}`;

export function projectCrabboxLegacyWarmLeases(
  entries: readonly { key: string; value: unknown }[],
) {
  return entries.map(({ key, value }) => ({
    leaseId: key,
    machineClass:
      isRecord(value) && typeof value.machineClass === "string" ? value.machineClass : undefined,
    selector: legacyLeaseSelector(key, value),
  }));
}
