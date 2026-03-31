import fs from "node:fs/promises";
import path from "node:path";

export type QueuedFileWriter = {
  filePath: string;
  write: (line: string) => void;
  /** Returns a promise that resolves when all queued writes have completed. */
  drain: () => Promise<void>;
};

/** Number of consecutive failures before emitting a warning. */
const WARN_AFTER_FAILURES = 3;

export function getQueuedFileWriter(
  writers: Map<string, QueuedFileWriter>,
  filePath: string,
): QueuedFileWriter {
  const existing = writers.get(filePath);
  if (existing) {
    return existing;
  }

  const dir = path.dirname(filePath);
  const ready = fs.mkdir(dir, { recursive: true }).catch(() => undefined);
  let queue = Promise.resolve();
  let consecutiveFailures = 0;

  const writer: QueuedFileWriter = {
    filePath,
    write: (line: string) => {
      queue = queue
        .then(() => ready)
        .then(() => fs.appendFile(filePath, line, "utf8"))
        .then(() => {
          consecutiveFailures = 0;
        })
        .catch((err: unknown) => {
          consecutiveFailures++;
          if (
            consecutiveFailures === WARN_AFTER_FAILURES ||
            (consecutiveFailures > WARN_AFTER_FAILURES && consecutiveFailures % 30 === 0)
          ) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(
              `QueuedFileWriter: ${consecutiveFailures} consecutive write failures to ${filePath}: ${msg}`,
            );
          }
        });
    },
    drain: () => queue,
  };

  writers.set(filePath, writer);
  return writer;
}
