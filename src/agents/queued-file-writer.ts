/** Per-path ordered append writer for diagnostic logs. */
import fs from "node:fs/promises";
import path from "node:path";
import { appendRegularFile } from "../infra/fs-safe.js";

/** Append writer handle shared by callers that target the same path. */
export type QueuedFileWriter = {
  filePath: string;
  write: (line: string) => unknown;
  flush: () => Promise<void>;
};

/** Returns the cached writer for a path or creates a new ordered append queue. */
export function getQueuedFileWriter(
  writers: Map<string, QueuedFileWriter>,
  filePath: string,
): QueuedFileWriter {
  const existing = writers.get(filePath);
  if (existing) {
    return existing;
  }

  const dir = path.dirname(filePath);
  const ready = fs.mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => undefined);
  let queue: Promise<unknown> = Promise.resolve();
  const writer: QueuedFileWriter = {
    filePath,
    write: (line: string) => {
      queue = queue
        .then(async () => {
          await ready;
          await appendRegularFile({
            filePath,
            content: line,
            rejectSymlinkParents: true,
          });
        })
        .catch(() => undefined);
      return "queued";
    },
    flush: async () => {
      await queue;
    },
  };

  writers.set(filePath, writer);
  return writer;
}
