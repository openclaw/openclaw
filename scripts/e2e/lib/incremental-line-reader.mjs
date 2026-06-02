import { createHash } from "node:crypto";
import fs from "node:fs";

function readSlice(filePath, start, length) {
  if (length <= 0) {
    return "";
  }
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function readBufferSlice(filePath, start, length) {
  if (length <= 0) {
    return Buffer.alloc(0);
  }
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function resolveFileIdentity(stats) {
  if (Number.isSafeInteger(stats.dev) && Number.isSafeInteger(stats.ino) && stats.ino !== 0) {
    return `${stats.dev}:${stats.ino}`;
  }
  return Number.isFinite(stats.birthtimeMs) ? `birth:${stats.birthtimeMs}` : undefined;
}

function resolveFileVersion(stats) {
  return `${stats.mtimeMs}:${stats.ctimeMs}`;
}

function readTailFingerprint(filePath, stats, maxReadBytes) {
  const length = Math.min(stats.size, maxReadBytes);
  const start = Math.max(0, stats.size - length);
  const buffer = readBufferSlice(filePath, start, length);
  const hash = createHash("sha256").update(buffer).digest("base64url");
  return `${start}:${buffer.byteLength}:${hash}`;
}

export function resolvePositiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function createIncrementalLineReader(filePath, options = {}) {
  const maxReadBytes = resolvePositiveInteger(options.maxReadBytes, 256 * 1024);
  let fileIdentity;
  let fileVersion;
  let contentFingerprint;
  let offset = 0;
  let pending = "";

  return {
    readLines() {
      if (!fs.existsSync(filePath)) {
        return { lines: [], reset: false };
      }

      const stats = fs.statSync(filePath);
      if (!stats.isFile()) {
        return { lines: [], reset: false };
      }

      let reset = false;
      const nextFileIdentity = resolveFileIdentity(stats);
      const nextFileVersion = resolveFileVersion(stats);
      if (
        fileIdentity !== undefined &&
        nextFileIdentity !== undefined &&
        fileIdentity !== nextFileIdentity
      ) {
        offset = 0;
        pending = "";
        reset = true;
      }
      fileIdentity = nextFileIdentity;

      if (
        !reset &&
        stats.size === offset &&
        fileVersion !== undefined &&
        fileVersion !== nextFileVersion
      ) {
        const nextContentFingerprint = readTailFingerprint(filePath, stats, maxReadBytes);
        if (contentFingerprint !== undefined && contentFingerprint !== nextContentFingerprint) {
          offset = 0;
          pending = "";
          reset = true;
        } else {
          contentFingerprint = nextContentFingerprint;
          fileVersion = nextFileVersion;
          return { lines: [], reset: false };
        }
      }

      if (stats.size < offset) {
        offset = 0;
        pending = "";
        reset = true;
      }
      if (stats.size === offset) {
        fileVersion = nextFileVersion;
        return { lines: [], reset };
      }

      let start = offset;
      let discardFirstLine = false;
      let clamped = false;
      if (start === 0 && stats.size > maxReadBytes) {
        start = stats.size - maxReadBytes;
        pending = "";
        clamped = true;
      } else if (stats.size - start > maxReadBytes) {
        start = stats.size - maxReadBytes;
        pending = "";
        clamped = true;
      }
      if (clamped && start > 0) {
        discardFirstLine = readSlice(filePath, start - 1, 1) !== "\n";
      }

      const text = readSlice(filePath, start, stats.size - start);
      offset = stats.size;
      fileVersion = nextFileVersion;
      contentFingerprint = readTailFingerprint(filePath, stats, maxReadBytes);
      if (!text) {
        return { lines: [], reset };
      }

      let chunk = pending + text;
      if (discardFirstLine) {
        const newlineIndex = chunk.indexOf("\n");
        if (newlineIndex === -1) {
          pending = "";
          return { lines: [], reset };
        }
        chunk = chunk.slice(newlineIndex + 1);
      }

      const lines = chunk.split("\n");
      pending = lines.pop() ?? "";
      return { lines, reset };
    },
  };
}
