import fsSync from "node:fs";
import fs from "node:fs/promises";

export const SESSION_SUMMARY_DAILY_MEMORY_PROBE_MAX_BYTES = 32 * 1024;

export async function readSessionSummaryProbePrefixFromFd(
  fd: number,
  maxBytes: number = SESSION_SUMMARY_DAILY_MEMORY_PROBE_MAX_BYTES,
): Promise<string> {
  const cappedMaxBytes = Math.max(1, Math.floor(maxBytes));
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for (;;) {
    if (totalBytes >= cappedMaxBytes) {
      break;
    }
    const nextChunkSize = Math.min(64 * 1024, cappedMaxBytes - totalBytes);
    const buf = Buffer.allocUnsafe(nextChunkSize);
    const bytesRead = await new Promise<number>((resolve, reject) => {
      fsSync.read(fd, buf, 0, nextChunkSize, totalBytes, (error, read) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(read);
      });
    });
    if (bytesRead <= 0) {
      break;
    }
    totalBytes += bytesRead;
    chunks.push(buf.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, totalBytes).toString("utf-8");
}

export async function readSessionSummaryProbePrefixFromFile(
  filePath: string,
  maxBytes: number = SESSION_SUMMARY_DAILY_MEMORY_PROBE_MAX_BYTES,
): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    return await readSessionSummaryProbePrefixFromFd(handle.fd, maxBytes);
  } finally {
    await handle.close().catch(() => undefined);
  }
}
