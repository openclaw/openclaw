// Doctor and runtime share record policy without loading a state-store implementation.
import { createHash } from "node:crypto";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export type WarmImageOperation =
  | {
      type: "capture";
      id: string;
      startedAtMs: number;
      leaseId?: string;
      provider?: string;
      phase: "scrubbing" | "creating" | "uncertain";
      checkpointIds?: string[];
    }
  | { type: "retire"; checkpointId: string };

export const WARM_IMAGE_MAX_ENTRIES = 128;
export const LEGACY_WARM_LEASE_MAX_ENTRIES = 256;
const CAPTURE_WARNING_AGE_MS = 1_200_000;

export function withoutCrabboxWarmImageOperation<T extends { operation?: WarmImageOperation }>(
  record: T,
): Omit<T, "operation"> {
  const profile = { ...record };
  delete profile.operation;
  return profile;
}

export function crabboxWarmImageCaptureStatus(record: { operation?: WarmImageOperation }) {
  const capture = record.operation?.type === "capture" ? record.operation : undefined;
  if (!capture) {
    return undefined;
  }
  return {
    selector: capture.id,
    startedAtMs: capture.startedAtMs,
    ...(capture.leaseId ? { leaseId: capture.leaseId } : {}),
    ...(capture.provider ? { provider: capture.provider } : {}),
    phase: capture.phase,
    ...(capture.checkpointIds ? { checkpointIds: capture.checkpointIds } : {}),
    stale: Date.now() - capture.startedAtMs >= CAPTURE_WARNING_AGE_MS,
  };
}

export const CRABBOX_WARM_IMAGE_WAIT_HINT =
  "The capture may still be preparing its source or waiting for provider readiness. Inspect openclaw crabbox warm-images --json and allow the owning capture to settle.";

export function crabboxWarmImageRecoveryHint(selector: string, checkpointIds?: string[]): string {
  return `${checkpointIds?.length ? `Candidate checkpoints: ${checkpointIds.join(", ")}. ` : ""}Stop the owning Gateway and capture processes, confirm any worker being recovered is stopped, and resolve any untracked checkpoint in the Crabbox catalog before running: openclaw crabbox warm-images --recover ${selector} --acknowledge-provider-cleanup. Then restart the Gateway; the next eligible worker can capture again.`;
}

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
