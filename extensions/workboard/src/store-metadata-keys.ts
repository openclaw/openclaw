import type { WorkboardMetadata } from "@openclaw/workboard-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const SUPPORTED_METADATA_KEYS: Record<keyof WorkboardMetadata, true> = {
  archivedAt: true,
  artifacts: true,
  attempts: true,
  attachments: true,
  automation: true,
  claim: true,
  comments: true,
  diagnostics: true,
  failureCount: true,
  lifecycleStatusSourceUpdatedAt: true,
  links: true,
  notifications: true,
  proof: true,
  stale: true,
  templateId: true,
  workerLogs: true,
  workerProtocol: true,
};

/** Validate client writes without changing normalization of persisted or server-owned metadata. */
export function assertSupportedMetadataKeys(value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  const unsupported = Object.keys(value)
    .filter((key) => !Object.hasOwn(SUPPORTED_METADATA_KEYS, key))
    .toSorted();
  if (unsupported.length === 0) {
    return;
  }
  throw new Error(
    `Unsupported workboard metadata key(s): ${unsupported.join(", ")}. Supported keys: ${Object.keys(SUPPORTED_METADATA_KEYS).toSorted().join(", ")}.`,
  );
}
