#!/usr/bin/env node

// Rejects unresolved merge conflict markers in tracked files.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFLICT_MARKER_GREP_PATTERN = "^(<<<<<<< |\\|\\|\\|\\|\\|\\|\\| |=======$|>>>>>>> )";

function isBinaryBuffer(buffer) {
  return buffer.includes(0);
}

/**
 * Returns one-based line numbers containing merge conflict markers.
 */
export function findConflictMarkerLines(content) {
  const lines = content.split(/\r?\n/u);
  const matches = [];
  for (const [index, line] of lines.entries()) {
    if (
      line.startsWith("<<<<<<< ") ||
      line.startsWith("||||||| ") ||
      line === "=======" ||
      line.startsWith(">>>>>>> ")
    ) {
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
 * Scans a list of files for merge conflict markers, skipping binary content.
 * This is kept for direct, small-scale use (tests); the tracked-files path
 * uses git grep directly to avoid reading large files into memory.
 */
export function findConflictMarkersInFiles(filePaths, readFile = fs.readFileSync) {
  const violations = [];
  for (const filePath of filePaths) {
    let content;
    try {
      content = readFile(filePath);
    } catch {
      continue;
    }
    if (!Buffer.isBuffer(content)) {
      content = Buffer.from(String(content));
    }
    if (isBinaryBuffer(content)) {
      continue;
    }
    const lines = findConflictMarkerLines(content.toString("utf8"));
    if (lines.length > 0) {
      violations.push({
        filePath,
        lines,
      });
    }
  }
  return violations;
}

/**
 * Parses output from `git grep -n -z -o -I -E` into violation records.
 * With -z, git grep terminates each output line with a newline and separates
 * the path from the line number (and the line number from the match text)
 * with NUL bytes. The record format for each line is:
 *   path\0line-number\0match-text\n
 * Keeping parsing to exact grep match records avoids reading candidate files
 * whole and keeps memory bounded regardless of file size.
 */
function parseGitGrepConflictMarkerOutput(stdout) {
  const byPath = new Map();
  const outputLines = stdout.toString("utf8").split("\n");

  for (const outputLine of outputLines) {
    if (outputLine.length === 0) {
      continue;
    }
    const fields = outputLine.split("\0");
    if (fields.length < 3) {
      continue;
    }
    const relativePath = fields[0];
    const lineNumber = Number(fields[1]);
    if (!Number.isFinite(lineNumber) || lineNumber <= 0) {
      continue;
    }
    const existing = byPath.get(relativePath);
    if (existing) {
      existing.push(lineNumber);
    } else {
      byPath.set(relativePath, [lineNumber]);
    }
  }

  const violations = [];
  for (const [relativePath, lineNumbers] of byPath) {
    lineNumbers.sort((a, b) => a - b);
    violations.push({
      filePath: relativePath,
      lines: lineNumbers,
    });
  }
  violations.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return violations;
}

/**
 * Uses git grep to find exact conflict-marker matches in tracked files.
 */
export function findConflictMarkersInTrackedFiles(cwd = process.cwd(), run = spawnSync) {
  const result = run(
    "git",
    ["grep", "-n", "-z", "-o", "-I", "-E", CONFLICT_MARKER_GREP_PATTERN, "--", "."],
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
  return parseGitGrepConflictMarkerOutput(result.stdout);
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
    // findConflictMarkersInTrackedFiles already returns paths relative to cwd.
    console.error(`- ${violation.filePath}:${violation.lines.join(",")}`);
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
