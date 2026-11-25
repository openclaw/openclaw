/** Per-path ordered append writer for diagnostic logs. */
import fs from "node:fs/promises";
import path from "node:path";
import { appendRegularFile } from "../infra/fs-safe.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agents/diagnostic-writer");

/** Append writer handle shared by callers that target the same path. */
export type QueuedFileWriter = {
  filePath: string;
  write: (line: string) => unknown;
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
  let reportedFailure = false;
  const reportFailure = (error: unknown) => {
    if (!reportedFailure) {
      reportedFailure = true;
      log.warn("Diagnostic log write failed; check the configured log path", { filePath, error });
    }
  };
  let queue: Promise<unknown> = fs
    .mkdir(dir, { recursive: true, mode: 0o700 })
    .catch(reportFailure);
  const writer: QueuedFileWriter = {
    filePath,
    write: (line: string) => {
      queue = queue
        .then(() =>
          appendRegularFile({
            filePath,
            content: line,
            rejectSymlinkParents: true,
          }),
        )
        .catch(reportFailure);
      return queue;
    },
  };

  writers.set(filePath, writer);
  return writer;
}
