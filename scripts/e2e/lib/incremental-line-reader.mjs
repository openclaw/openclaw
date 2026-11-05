import fs from "node:fs";

function readSlice(filePath, start, length) {
  return readBufferSlice(filePath, start, length).toString("utf8");
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

export function resolvePositiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function createIncrementalLineReader(filePath, options = {}) {
  const maxReadBytes = resolvePositiveInteger(options.maxReadBytes, 256 * 1024);
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
      // Fixture logs append or truncate; same-size external replacement is best-effort.
      if (stats.size < offset) {
        offset = 0;
        pending = "";
        reset = true;
      }
      if (stats.size === offset) {
        return { lines: [], reset };
      }

      let start = offset;
      let discardFirstLine = false;
      if (stats.size - start > maxReadBytes) {
        start = stats.size - maxReadBytes;
        pending = "";
        if (start > 0) {
          discardFirstLine = readSlice(filePath, start - 1, 1) !== "\n";
        }
      }

      const text = readSlice(filePath, start, stats.size - start);
      offset = stats.size;
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
