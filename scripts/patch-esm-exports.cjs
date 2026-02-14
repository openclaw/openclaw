#!/usr/bin/env node
/**
 * Postinstall patch: add "default" export condition to ESM-only packages.
 *
 * jiti (the TS/ESM loader used at runtime) converts imports to CJS require().
 * Some dependencies ship export maps with only an "import" condition and no
 * "default" or "require" fallback, which causes ERR_PACKAGE_PATH_NOT_EXPORTED.
 * This script walks node_modules and adds the missing "default" condition so
 * both ESM and CJS resolution work.
 *
 * Safe to run multiple times (idempotent). Never exits non-zero.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MAX_DEPTH = 8;
const SKIP_DIRS = new Set([".cache", ".store"]);

/**
 * Mutate an exports object in-place, adding a "default" condition to any entry
 * that has "import" but neither "default" nor "require".
 *
 * @param {unknown} exports - The "exports" field from package.json
 * @returns {boolean} Whether any entry was modified
 */
function patchExports(exports) {
  if (typeof exports !== "object" || exports === null || Array.isArray(exports)) {
    return false;
  }
  let modified = false;
  for (const key of Object.keys(exports)) {
    const entry = exports[key];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    if ("import" in entry && !("default" in entry) && !("require" in entry)) {
      entry.default = entry.import;
      modified = true;
    }
  }
  return modified;
}

/**
 * Walk a directory tree and patch every package.json whose exports need a
 * "default" condition.
 *
 * @param {string} dir - Root directory to walk (typically node_modules)
 * @returns {{ patchedCount: number, errors: Array<{ file: string, error: string }> }}
 */
function patchDir(dir) {
  let patchedCount = 0;
  const errors = [];

  function walk(currentDir, depth) {
    if (depth > MAX_DEPTH) {
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (SKIP_DIRS.has(name)) {
        continue;
      }
      const fullPath = path.join(currentDir, name);

      if (name === "package.json") {
        try {
          const content = fs.readFileSync(fullPath, "utf8");
          const pkg = JSON.parse(content);
          if (pkg.exports && patchExports(pkg.exports)) {
            fs.writeFileSync(fullPath, JSON.stringify(pkg, null, 2) + "\n");
            patchedCount++;
          }
        } catch (err) {
          errors.push({ file: fullPath, error: err.message });
        }
        continue;
      }

      let isDir = entry.isDirectory();
      if (!isDir && entry.isSymbolicLink()) {
        try {
          isDir = fs.statSync(fullPath).isDirectory();
        } catch {
          continue;
        }
      }
      if (isDir) {
        walk(fullPath, depth + 1);
      }
    }
  }

  walk(dir, 0);
  return { patchedCount, errors };
}

if (require.main === module) {
  try {
    const nodeModules = path.resolve(__dirname, "..", "node_modules");
    const { patchedCount } = patchDir(nodeModules);
    console.log(`patch-esm-exports: patched ${patchedCount} package(s)`);
  } catch (err) {
    console.warn("patch-esm-exports: unexpected error —", err.message);
  }
}

module.exports = { patchExports, patchDir };
