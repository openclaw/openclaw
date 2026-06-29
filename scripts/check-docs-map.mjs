#!/usr/bin/env node

/**
 * Checks that the committed docs/docs_map.md is up to date.
 * Exits non-zero if the map is stale.
 *
 * Generates to a temp file and compares in-memory — never mutates tracked files.
 *
 * Usage: node scripts/check-docs-map.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DOCS_DIR = join(process.cwd(), "docs");
const COMMITTED_FILE = join(DOCS_DIR, "docs_map.md");

if (!existsSync(COMMITTED_FILE)) {
  console.error("check-docs-map: docs/docs_map.md does not exist. Run `pnpm docs:map` first.");
  process.exit(1);
}

const committed = readFileSync(COMMITTED_FILE, "utf8");

// Generate to a temp file to avoid mutating tracked files
const tempDir = mkdtempSync(join(tmpdir(), "docs-map-check-"));
const tempFile = join(tempDir, "docs_map.md");

try {
  execFileSync("node", ["scripts/generate-docs-map.mjs", tempFile], {
    cwd: process.cwd(),
    stdio: "pipe",
  });

  const generated = readFileSync(tempFile, "utf8");

  if (committed !== generated) {
    console.error("check-docs-map: docs/docs_map.md is stale. Run `pnpm docs:map` to regenerate.");
    process.exit(1);
  }

  console.log("check-docs-map: docs_map.md is up to date.");
} catch (e) {
  console.error("check-docs-map: generator failed:", e.message);
  process.exit(1);
} finally {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {}
}
