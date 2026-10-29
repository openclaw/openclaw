import type { WorkboardLink, WorkboardMetadata } from "@openclaw/workboard-contract";
import { definedFields } from "../record-fields.js";
import { MAX_CARD_METADATA_BYTES } from "./store-constants.js";

export function isDependencyLink(link: WorkboardLink): boolean {
  return link.type === "parent" || link.type === "child";
}

export function removeUndefinedMetadataFields(metadata: WorkboardMetadata): WorkboardMetadata {
  const next = definedFields({ ...metadata });
  for (const [key, value] of Object.entries(next)) {
    if ((Array.isArray(value) && value.length === 0) || (key === "failureCount" && value === 0)) {
      Reflect.deleteProperty(next, key);
    }
  }
  return next;
}

function metadataByteSize(metadata: WorkboardMetadata): number {
  return Buffer.byteLength(JSON.stringify(metadata), "utf8");
}

export function trimMetadataToBudget(
  metadata: WorkboardMetadata,
  options: { preserveProofId?: string; preserveNotificationId?: string } = {},
): WorkboardMetadata {
  let next = removeUndefinedMetadataFields(metadata);
  while (metadataByteSize(next) > MAX_CARD_METADATA_BYTES) {
    const currentSize = metadataByteSize(next);
    for (const key of [
      "attempts",
      "diagnostics",
      "notifications",
      "proof",
      "artifacts",
      "attachments",
      "workerLogs",
      "links",
      "comments",
    ] as const) {
      const entries = next[key];
      if (!entries?.length) {
        continue;
      }
      const preserveId = key === "proof" ? options.preserveProofId : options.preserveNotificationId;
      const index =
        key === "proof" || key === "notifications"
          ? (next[key]?.findIndex((entry) => entry.id !== preserveId) ?? -1)
          : key === "links"
            ? (next.links?.findIndex((link) => !isDependencyLink(link)) ?? -1)
            : 0;
      if (index < 0) {
        continue;
      }
      next = removeUndefinedMetadataFields({
        ...next,
        [key]: entries.filter((_, entryIndex) => entryIndex !== index),
      });
      break;
    }
    if (metadataByteSize(next) >= currentSize) {
      if (options.preserveProofId) {
        throw new Error(`card metadata cannot retain proof: ${options.preserveProofId}`);
      }
      if (options.preserveNotificationId) {
        throw new Error(
          `card metadata cannot retain notification: ${options.preserveNotificationId}`,
        );
      }
      break;
    }
  }
  return next;
}
