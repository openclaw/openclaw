#!/usr/bin/env node

// Rejects unresolved merge conflict markers in tracked files.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFLICT_MARKER_GREP_PATTERN = "^(<<<<<<< |\\|\\|\\|\\|\\|\\|\\| |=======$|>>>>>>> )";

// Files larger than this are skipped rather than buffered into memory whole.
// Conflict markers live in source-like text, and 50 MiB is well above any
// reasonable source or generated text file that should be scanned here.
const MAX_CONFLICT_MARKER_SCAN_BYTES = 50 * 1024 * 1024;

function isBinaryBuffer(buffer) {
  return buffer.includes(0);
}

function isConflictMarkerLine(line) {
  return (
    line.startsWith("<<<<<<< ") ||
    line.startsWith("||||||| ") ||
    line === "=======" ||
    line.startsWith(">>>>>>> ")
  );
}

/**
 * Returns one-based line numbers containing merge conflict markers.
 */
export function findConflictMarkerLines(content) {
  const lines = content.split(/\r?\n/u);
  const matches = [];
  for (const [index, line] of lines.entries()) {
    if (isConflictMarkerLine(line)) {
      matches.push(index + 1);
    }
  }
  return matches;
}

/**
 * Lists tracked files in the repository.
 */
export function listTrackedFiles(cwd = process.cwd()) {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd,
    encoding: "utf8",
  });
  return output
    .split("\0")
    .filter(Boolean)
    .map((relativePath) => path.join(cwd, relativePath));
}

/**
 * Scans a single file for merge conflict markers using bounded memory.
 * The file is read in chunks of at most `maxScanBytes`, so the total memory
 * use stays bounded even for files much larger than the chunk size.
 */
function findConflictMarkersInFileByChunks(
  filePath,
  statSync,
  openSync,
  readSync,
  closeSync,
  maxScanBytes,
) {
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    return null;
  }
  if (stats.size === 0) {
    return null;
  }

  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxScanBytes);
    let bytesRead = readSync(fd, buffer, 0, maxScanBytes, 0);
    if (bytesRead === 0) {
      return null;
    }

    // Treat files containing null bytes as binary and skip them. The binary
    // check only needs the first chunk because null bytes are not valid text.
    if (isBinaryBuffer(buffer.subarray(0, bytesRead))) {
      return null;
    }

    const violations = [];
    let offset = 0;
    let leftover = "";
    let lineNumber = 0;

    const processText = (text) => {
      const combined = leftover + text;
      const lines = combined.split(/\r?\n/u);
      // If the text does not end with a newline, the last segment is an
      // incomplete line that must be carried into the next chunk. This keeps
      // conflict markers that cross a chunk boundary intact when checked.
      const endsWithNewline = /\r?\n$/u.test(combined);
      leftover = endsWithNewline ? "" : lines.pop();
      for (const line of lines) {
        lineNumber += 1;
        if (isConflictMarkerLine(line)) {
          violations.push(lineNumber);
        }
      }
    };

    processText(buffer.toString("utf8", 0, bytesRead));
    offset += bytesRead;

    while (true) {
      bytesRead = readSync(fd, buffer, 0, maxScanBytes, offset);
      if (bytesRead === 0) {
        break;
      }
      processText(buffer.toString("utf8", 0, bytesRead));
      offset += bytesRead;
    }

    if (leftover) {
      lineNumber += 1;
      if (isConflictMarkerLine(leftover)) {
        violations.push(lineNumber);
      }
    }

    return violations.length > 0 ? { filePath, lines: violations } : null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Scans files for merge conflict markers, skipping binary content and
 * reading each file in bounded chunks to avoid unbounded memory use.
 */
export function findConflictMarkersInFiles(
  filePaths,
  statSync = fs.statSync,
  warn = console.warn,
  maxScanBytes = MAX_CONFLICT_MARKER_SCAN_BYTES,
  openSync = fs.openSync,
  readSync = fs.readSync,
  closeSync = fs.closeSync,
) {
  const violations = [];
  for (const filePath of filePaths) {
    const result = findConflictMarkersInFileByChunks(
      filePath,
      statSync,
      openSync,
      readSync,
      closeSync,
      maxScanBytes,
    );
    if (result) {
      violations.push(result);
    }
  }
  return violations;
}

/**
 * Uses git grep to list tracked files that may contain conflict markers.
 */
function listTrackedFilesWithConflictMarkerCandidates(cwd = process.cwd(), run = spawnSync) {
  const result = run(
    "git",
    ["grep", "-l", "-z", "-I", "-E", CONFLICT_MARKER_GREP_PATTERN, "--", "."],
    {
      cwd,
      encoding: "buffer",
    },
  );
  if (result.status === 1) {
    return [];
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString("utf8").trim();
    throw new Error(stderr || `git grep failed with status ${result.status ?? "unknown"}`);
  }
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((relativePath) => path.join(cwd, relativePath));
}

/**
 * Finds merge conflict markers in tracked repository files.
 */
export function findConflictMarkersInTrackedFiles(cwd = process.cwd()) {
  return findConflictMarkersInFiles(listTrackedFilesWithConflictMarkerCandidates(cwd));
}

/**
 * Runs the merge conflict marker check.
 */
export async function main() {
  const cwd = process.cwd();
  const violations = findConflictMarkersInTrackedFiles(cwd);
  if (violations.length === 0) {
    return;
  }

  console.error("Found unresolved merge conflict markers:");
  for (const violation of violations) {
    const relativePath = path.relative(cwd, violation.filePath) || violation.filePath;
    console.error(`- ${relativePath}:${violation.lines.join(",")}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(
    /** @param {unknown} error */ (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
