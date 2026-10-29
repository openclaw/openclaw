import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/** Metadata fields Workboard persists; a write that names anything else must fail loudly. */
const SUPPORTED_METADATA_KEYS: ReadonlySet<string> = new Set([
  "archivedAt",
  "artifacts",
  "attempts",
  "attachments",
  "automation",
  "claim",
  "comments",
  "diagnostics",
  "failureCount",
  "lifecycleStatusSourceUpdatedAt",
  "links",
  "notifications",
  "proof",
  "stale",
  "templateId",
  "workerLogs",
  "workerProtocol",
]);

/**
 * Reject client metadata keys the store cannot persist instead of dropping them silently.
 * The store rebuilds metadata from its own field list, so a write carrying an unknown key
 * would otherwise report success and lose the value.
 */
export function assertSupportedMetadataKeys(value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  const unsupported = Object.keys(value)
    .filter((key) => !SUPPORTED_METADATA_KEYS.has(key))
    .toSorted();
  if (unsupported.length === 0) {
    return;
  }
  throw new Error(
    `Unsupported workboard metadata key(s): ${unsupported.join(", ")}. Supported keys: ${[
      ...SUPPORTED_METADATA_KEYS,
    ]
      .toSorted()
      .join(", ")}.`,
  );
}
