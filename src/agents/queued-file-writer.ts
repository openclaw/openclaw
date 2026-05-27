import fs from "node:fs/promises";
import path from "node:path";

export type QueuedFileWriter = {
  filePath: string;
  write: (line: string) => void;
};

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

  const writer: QueuedFileWriter = {
    filePath,
    write: (line: string) => {
      queue = queue
        .then(() => ready)
        .then(() => fs.appendFile(filePath, line, "utf8"))
        .catch(() => undefined);
    },
  };

  writers.set(filePath, writer);
  return writer;
}
