import fsSync from "node:fs";
import fsPromises from "node:fs/promises";

// Legacy Reef state files (audit.jsonl, replay.jsonl) are append-only logs
// that can grow unbounded. Cap individual file reads to prevent OOM during
// doctor migration — audit/replay logs are typically under 50 MiB for heavy
// use; reviews/delivered are under 10 MiB.
export const MAX_LEGACY_AUDIT_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_LEGACY_REPLAY_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_LEGACY_REVIEWS_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_LEGACY_DELIVERED_FILE_BYTES = 10 * 1024 * 1024;

/** Read a legacy Reef state file with a byte cap enforced at read time (not via a pre-read
 * stat) to avoid TOCTOU races between checking file size and allocating the read buffer. */
export async function readLegacyReefFileSafely(
  filePath: string,
  maxBytes: number,
): Promise<string> {
  const fd = fsSync.openSync(filePath, "r");
  try {
    const stat = fsSync.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`not a regular file: ${filePath}`);
    }
    const CHUNK_SIZE = 64 * 1024;
    const chunks: Buffer[] = [];
    let total = 0;
    const scratch = Buffer.allocUnsafe(CHUNK_SIZE);
    while (true) {
      const bytesRead = fsSync.readSync(fd, scratch, 0, CHUNK_SIZE, null);
      if (bytesRead === 0) {
        return Buffer.concat(chunks, total).toString("utf8");
      }
      total += bytesRead;
      if (total > maxBytes) {
        throw new RangeError(`file too large: exceeds ${maxBytes} bytes: ${filePath}`);
      }
      chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
    }
  } finally {
    fsSync.closeSync(fd);
  }
}

export function isFileTooLargeError(error: unknown): boolean {
  return error instanceof RangeError && (error as Error).message.includes("file too large");
}

/**
 * Archive an oversized legacy source by renaming it to `<path>.migrated`.
 * Reading the file is avoided so the safe-migration cap is not bypassed
 * during archival; a failed rename leaves the source in place for retry.
 */
export async function archiveOversizedLegacySource(params: {
  filePath: string;
  label: string;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const archivedPath = `${params.filePath}.migrated`;
  try {
    await fsPromises.rename(params.filePath, archivedPath);
    params.changes.push(`Archived oversized ${params.label} legacy source to ${archivedPath}`);
  } catch (error) {
    params.warnings.push(
      `Failed archiving oversized ${params.label} legacy source: ${String(error)}; left source in place`,
    );
  }
}
