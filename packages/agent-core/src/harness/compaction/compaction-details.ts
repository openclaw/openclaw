/** The details a generated compaction boundary persists. */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

/** Longest run-owned request a boundary carries; longer persisted values are dropped on read. */
export const MAX_LATEST_USER_REQUEST_CHARS = 800;

/** File-operation details stored on generated compaction entries. */
export interface CompactionDetails {
  /** Files read in the compacted history. */
  readFiles: string[];
  /** Files modified in the compacted history. */
  modifiedFiles: string[];
  /** Run-owned request that remains active across another compaction generation. */
  latestUnresolvedUserRequest?: string;
  /** The best available summary was committed without passing the safeguard audit. */
  qualityDegraded?: true;
}

export function parseCompactionDetails(value: unknown): CompactionDetails | undefined {
  const details = asOptionalRecord(value);
  if (
    !details ||
    !Array.isArray(details.readFiles) ||
    !details.readFiles.every((file): file is string => typeof file === "string") ||
    !Array.isArray(details.modifiedFiles) ||
    !details.modifiedFiles.every((file): file is string => typeof file === "string")
  ) {
    return undefined;
  }
  const request = details.latestUnresolvedUserRequest;
  const latestUnresolvedUserRequest =
    typeof request === "string" && request.length <= MAX_LATEST_USER_REQUEST_CHARS
      ? request
      : undefined;
  return {
    readFiles: details.readFiles,
    modifiedFiles: details.modifiedFiles,
    ...(latestUnresolvedUserRequest ? { latestUnresolvedUserRequest } : {}),
    ...(details.qualityDegraded === true ? { qualityDegraded: true as const } : {}),
  };
}
