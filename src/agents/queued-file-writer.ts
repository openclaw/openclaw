import fs from "node:fs/promises";
import path from "node:path";
import { appendRegularFile, resolveRegularFileAppendFlags } from "../infra/fs-safe.js";

export type QueuedFileWriteResult = "queued" | "dropped";

export type QueuedFileWriter = {
  filePath: string;
  write: (line: string) => unknown;
  flush: () => Promise<void>;
};

type QueuedFileWriterOptions = {
  maxFileBytes?: number;
  maxQueuedBytes?: number;
  /**
   * When set to a positive integer alongside `maxFileBytes`, archive the current
   * file with numeric suffixes (`.1`, `.2`, ...) instead of dropping appends once
   * the cap is reached. `maxFiles` counts the active file plus its archives, so
   * `maxFiles: 3` keeps `<file>`, `<file>.1`, and `<file>.2`. Anything older is
   * unlinked. Leaving this unset (or `0`) preserves the legacy "drop on cap"
   * behavior for existing callers.
   */
  maxFiles?: number;
  yieldBeforeWrite?: boolean;
};

export const resolveQueuedFileAppendFlags = resolveRegularFileAppendFlags;

async function safeAppendFile(
  filePath: string,
  line: string,
  options: QueuedFileWriterOptions,
): Promise<void> {
  await appendRegularFile({
    filePath,
    content: line,
    maxFileBytes: options.maxFileBytes,
    rejectSymlinkParents: true,
  });
}

function waitForImmediate(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

async function statSizeForRotation(filePath: string): Promise<number> {
  try {
    const stat = await fs.lstat(filePath);
    // Refuse to rotate when the path is a symlink or non-regular file: the
    // append step will reject it anyway, and we do not want rotate to follow
    // the link and rename the wrong target.
    if (!stat.isFile()) {
      return Number.POSITIVE_INFINITY;
    }
    return stat.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return 0;
    }
    throw err;
  }
}

async function rotateNumericSuffixes(filePath: string, maxFiles: number): Promise<void> {
  // Drop the oldest archive that would exceed the retention budget, then shift
  // each remaining archive down one slot, finishing by renaming the active
  // file into the freed `.1` slot. Renames are atomic so no event in flight
  // observes a missing-then-recreated active file.
  const oldestSlot = maxFiles - 1; // active file counts as one slot
  if (oldestSlot >= 1) {
    await fs.rm(`${filePath}.${oldestSlot}`, { force: true });
  }
  for (let slot = oldestSlot - 1; slot >= 1; slot -= 1) {
    try {
      await fs.rename(`${filePath}.${slot}`, `${filePath}.${slot + 1}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw err;
      }
    }
  }
  if (oldestSlot >= 1) {
    try {
      await fs.rename(filePath, `${filePath}.1`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw err;
      }
    }
  } else {
    // maxFiles === 1: keep just the active file. Truncate by removing it so
    // the next append starts a fresh file with the configured permissions.
    await fs.rm(filePath, { force: true });
  }
}

async function maybeRotateBeforeAppend(
  filePath: string,
  lineBytes: number,
  options: QueuedFileWriterOptions,
): Promise<void> {
  const cap = options.maxFileBytes;
  const maxFiles = options.maxFiles;
  if (cap === undefined || cap <= 0 || maxFiles === undefined || maxFiles <= 0) {
    return;
  }
  const size = await statSizeForRotation(filePath);
  if (size + lineBytes <= cap) {
    return;
  }
  await rotateNumericSuffixes(filePath, maxFiles);
}

export function getQueuedFileWriter(
  writers: Map<string, QueuedFileWriter>,
  filePath: string,
  options: QueuedFileWriterOptions = {},
): QueuedFileWriter {
  const existing = writers.get(filePath);
  if (existing) {
    return existing;
  }

  const dir = path.dirname(filePath);
  const ready = fs.mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => undefined);
  let queue: Promise<unknown> = Promise.resolve();
  let queuedBytes = 0;

  const writer: QueuedFileWriter = {
    filePath,
    write: (line: string) => {
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (
        options.maxQueuedBytes !== undefined &&
        queuedBytes + lineBytes > options.maxQueuedBytes
      ) {
        return "dropped";
      }
      queuedBytes += lineBytes;
      queue = queue
        .then(() => ready)
        .then(() => (options.yieldBeforeWrite ? waitForImmediate() : undefined))
        .then(() => maybeRotateBeforeAppend(filePath, lineBytes, options))
        .then(() => safeAppendFile(filePath, line, options))
        .catch(() => undefined)
        .finally(() => {
          queuedBytes = Math.max(0, queuedBytes - lineBytes);
        });
      return "queued";
    },
    flush: async () => {
      await queue;
    },
  };

  writers.set(filePath, writer);
  return writer;
}
