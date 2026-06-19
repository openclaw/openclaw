#!/usr/bin/env node
import { createReadStream } from "node:fs";
// Filters staged file paths for pre-commit lint/format hooks.
import path from "node:path";

/**
 * Prints selected files as NUL-delimited tokens to stdout.
 *
 * Usage (args):  node scripts/pre-commit/filter-staged-files.mjs lint -- <files...>
 * Usage (stdin): printf '%s\0' <files...> | node scripts/pre-commit/filter-staged-files.mjs lint
 *
 * When no files follow the `--` separator (or `--` is absent), file paths are
 * read as NUL-delimited tokens from stdin. This avoids ARG_MAX limits when the
 * staged file count is large (e.g. merging upstream/main).
 *
 * Keep this dependency-free: the pre-commit hook runs in many environments.
 */

const mode = process.argv[2];
const rawArgs = process.argv.slice(3);
const explicitFiles = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;

if (mode !== "lint" && mode !== "format") {
  process.stderr.write("usage: filter-staged-files.mjs <lint|format> -- <files...>\n");
  process.exit(2);
}

const lintExts = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const formatExts = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".md", ".mdx"]);
const formatIgnoredPathPatterns = [/^extensions\/[^/]+\/src\/host\/.+\/[^/]+\.bundle\.js$/u];

const shouldSelect = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (mode === "lint") {
    return lintExts.has(ext);
  }
  if (formatIgnoredPathPatterns.some((pattern) => pattern.test(filePath))) {
    return false;
  }
  return formatExts.has(ext);
};

const emit = (file) => {
  if (shouldSelect(file)) {
    process.stdout.write(file);
    process.stdout.write("\0");
  }
};

if (explicitFiles.length > 0) {
  for (const file of explicitFiles) {
    emit(file);
  }
} else {
  // Read NUL-delimited file list from stdin to avoid ARG_MAX on large merges.
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\0")) !== -1) {
      const file = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (file) emit(file);
    }
  });
  process.stdin.on("end", () => {
    if (buf) emit(buf);
  });
}
