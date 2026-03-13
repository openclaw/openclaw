#!/usr/bin/env node
// Authored by: cc (Claude Code) | 2026-03-13
import fs from "node:fs";
import path from "node:path";

// Incremental repo-map updater for pre-commit hook.
// Usage: node update-repo-map.mjs -- file1.ts file2.ts
// Updates docs/repo-map.json for given files (src/ and extensions/ .ts only).
// Preserves existing purpose fields. Dependency-free.

const ROOT_DIR = findRepoRoot();
const MAP_PATH = path.join(ROOT_DIR, "docs", "repo-map.json");

const rawArgs = process.argv.slice(2);
const files = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;

if (files.length === 0) {
  process.exit(0);
}

const eligible = files.filter((f) => {
  if (!/\.(ts|tsx)$/.test(f)) {
    return false;
  }
  if (/\.test\.(ts|tsx)$/.test(f)) {
    return false;
  }
  if (/\.e2e\.test\.(ts|tsx)$/.test(f)) {
    return false;
  }
  return f.startsWith("src/") || f.startsWith("extensions/");
});

if (eligible.length === 0) {
  process.exit(0);
}

let map;
try {
  map = JSON.parse(fs.readFileSync(MAP_PATH, "utf8"));
} catch {
  process.stderr.write(`update-repo-map: cannot read ${MAP_PATH}\n`);
  process.exit(1);
}

const filesSection = map.files;
if (!filesSection || typeof filesSection !== "object") {
  process.stderr.write("update-repo-map: docs/repo-map.json missing 'files' key\n");
  process.exit(1);
}

let changed = false;

for (const filePath of eligible) {
  const absPath = path.join(ROOT_DIR, filePath);
  const exists = fs.existsSync(absPath);

  if (!exists) {
    // Remove deleted files from the map
    if (filesSection[filePath]) {
      delete filesSection[filePath];
      changed = true;
    }
    continue;
  }

  const source = fs.readFileSync(absPath, "utf8");
  const exports = extractExports(source);
  const dependencies = extractDependencies(source, filePath);

  const existing = filesSection[filePath];
  if (existing) {
    // Only update exports and dependencies, preserve purpose and other fields
    const exportsChanged = JSON.stringify(existing.exports ?? []) !== JSON.stringify(exports);
    const depsChanged =
      JSON.stringify(existing.dependencies ?? []) !== JSON.stringify(dependencies);
    if (exportsChanged || depsChanged) {
      existing.exports = exports;
      existing.dependencies = dependencies;
      changed = true;
    }
  } else {
    // New file — add with empty purpose for human to fill in
    filesSection[filePath] = { purpose: "", exports, dependencies };
    changed = true;
  }
}

if (!changed) {
  process.exit(0);
}

// Sort files keys for stable diffs
const sorted = {};
for (const key of Object.keys(filesSection).toSorted((a, b) => a.localeCompare(b))) {
  sorted[key] = filesSection[key];
}
map.files = sorted;
map.generated = new Date().toISOString().slice(0, 10);

fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2) + "\n", "utf8");

// --- helpers ---

function findRepoRoot() {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

function extractExports(source) {
  const names = new Set();

  // export (async )?(function|const|let|class|type|interface|enum) NAME
  const namedRe = /export\s+(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+(\w+)/g;
  let m;
  while ((m = namedRe.exec(source)) !== null) {
    names.add(m[1]);
  }

  // export default (function|class) NAME
  const defaultRe = /export\s+default\s+(?:function|class)\s+(\w+)/g;
  while ((m = defaultRe.exec(source)) !== null) {
    names.add(m[1]);
  }

  // export { name1, name2 }
  const reexportRe = /export\s*\{([^}]+)\}/g;
  while ((m = reexportRe.exec(source)) !== null) {
    for (const part of m[1].split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        .trim();
      if (name && /^\w+$/.test(name)) {
        names.add(name);
      }
    }
  }

  return [...names].toSorted((a, b) => a.localeCompare(b));
}

function extractDependencies(source, filePath) {
  const deps = new Set();
  const fileDir = path.dirname(filePath);

  // from "RELATIVE_PATH" or from 'RELATIVE_PATH' where path starts with .
  const importRe = /from\s+["'](\.[^"']+)["']/g;
  let m;
  while ((m = importRe.exec(source)) !== null) {
    const raw = m[1];
    // Normalize to repo-root-relative
    const resolved = path.posix.normalize(path.posix.join(fileDir, raw));
    // Collapse to directory if it ends with /index
    const dep = resolved.replace(/\/index$/, "/");
    deps.add(dep);
  }

  return [...deps].toSorted((a, b) => a.localeCompare(b));
}
