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

  // SECURITY: Ensure the log file is created with owner-only permissions (0o600)
  // to prevent other users on the system from reading sensitive diagnostic data.
  const ensurePermissions = ready.then(async () => {
    try {
      await fs.writeFile(filePath, "", { flag: "a", mode: 0o600 });
      if (process.platform !== "win32") {
        await fs.chmod(filePath, 0o600);
      }
    } catch {
      // Best-effort: file may not exist yet or permissions may not be supported
    }
  });

  const writer: QueuedFileWriter = {
    filePath,
    write: (line: string) => {
      queue = queue
        .then(() => ensurePermissions)
        .then(() => fs.appendFile(filePath, line, { encoding: "utf8" }))
        .catch(() => undefined);
    },
  };

  writers.set(filePath, writer);
  return writer;
}
