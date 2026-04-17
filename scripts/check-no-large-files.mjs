#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

// Forward-only hygiene guard: prevent new large files from entering the tree.
// History rewrite is a separate, coordinated effort (GIT-1). This guard caps
// future growth so the pack keeps shrinking (relatively) as old bloat rolls off.

export const DEFAULT_MAX_BYTES = 3 * 1024 * 1024; // 3 MiB

// Tracked files that already exceed the default threshold. Each entry MUST
// have a justification. Adding to this list requires explicit code review —
// prefer shrinking, moving to fetch-at-build, or Git LFS over new entries.
export const ALLOWLIST = Object.freeze([
  // Bundled viewer runtime for the diffs extension. Regenerated from
  // upstream; the shipped bundle is what agents load at runtime.
  "extensions/diffs/assets/viewer-runtime.js",
  // Onboarding/demo screenshot captured for docs. Static asset.
  "apps/ios/screenshots/session-2026-03-07/canvas-cool.png",
]);

const ALLOWLIST_SET = new Set(ALLOWLIST);

export function listTrackedFiles(cwd = process.cwd()) {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd,
    encoding: "utf8",
  });
  return output
    .split("\0")
    .filter(Boolean)
    .map((relativePath) => ({
      relativePath,
      absolutePath: path.join(cwd, relativePath),
    }));
}

export function findLargeFiles(
  files,
  { maxBytes = DEFAULT_MAX_BYTES, allowlist = ALLOWLIST_SET } = {},
) {
  const offenders = [];
  for (const file of files) {
    if (allowlist.has(file.relativePath)) {
      continue;
    }
    if (!existsSync(file.absolutePath)) {
      continue;
    }
    let bytes;
    try {
      bytes = statSync(file.absolutePath).size;
    } catch {
      continue;
    }
    if (bytes > maxBytes) {
      offenders.push({ relativePath: file.relativePath, bytes });
    }
  }
  offenders.sort((a, b) => b.bytes - a.bytes);
  return offenders;
}

function parseMaxBytesArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--max-bytes") {
      const next = argv[i + 1];
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--max-bytes must be a positive number (got ${String(next)})`);
      }
      return parsed;
    }
  }
  return DEFAULT_MAX_BYTES;
}

function formatMiB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

async function main() {
  // Stay quiet on EPIPE so `... | head` is safe.
  process.stdout.on("error", (error) => {
    if (error?.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  });

  const maxBytes = parseMaxBytesArg(process.argv.slice(2));
  const files = listTrackedFiles();
  const offenders = findLargeFiles(files, { maxBytes });

  if (offenders.length === 0) {
    return;
  }

  process.stderr.write(
    `check-no-large-files: ${offenders.length} tracked file(s) exceed ${formatMiB(maxBytes)}.\n` +
      `Shrink the file, move it out of git (fetch-at-build / Git LFS), or add an\n` +
      `explicit entry to ALLOWLIST in scripts/check-no-large-files.mjs with a\n` +
      `justification.\n\n`,
  );
  for (const offender of offenders) {
    process.stdout.write(`${offender.bytes}\t${offender.relativePath}\n`);
  }
  process.exitCode = 1;
}

const invokedAsScript =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedAsScript) {
  await main();
}
