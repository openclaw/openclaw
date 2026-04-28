#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SEARCH_ROOTS = ["src"];
const DEPRECATED_IMPORT_PATTERN =
  /(?:from\s+["'][^"']*pi-embedded-runner|import\(["'][^"']*pi-embedded-runner)/;
const EXCLUDED_PATH_PARTS = [
  "src/agents/pi-embedded-runner/",
  "src/agents/pi-embedded-runner.ts",
  "src/agents/pi-embedded.ts",
  "src/agents/embedded-runner.ts",
  "src/agents/embedded-runner/",
];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
      continue;
    }
    if (entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name)) {
      yield full;
    }
  }
}

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

const warnings = [];
for (const root of SEARCH_ROOTS) {
  const absoluteRoot = path.join(ROOT, root);
  if (!fs.existsSync(absoluteRoot)) {
    continue;
  }
  for (const file of walk(absoluteRoot)) {
    const rel = relative(file);
    if (
      rel.endsWith(".test.ts") ||
      EXCLUDED_PATH_PARTS.some((excluded) => rel.startsWith(excluded))
    ) {
      continue;
    }
    const text = fs.readFileSync(file, "utf8");
    if (DEPRECATED_IMPORT_PATTERN.test(text)) {
      warnings.push(rel);
    }
  }
}

if (warnings.length > 0) {
  console.warn(
    [
      "[embedded-runner-imports] Deprecated pi-embedded-runner imports remain.",
      "This guard is warning-only while compatibility barrels are supported.",
      "New core imports should prefer src/agents/embedded-runner(.js) unless they need an unmigrated deep helper.",
      ...warnings.map((file) => `  - ${file}`),
    ].join("\n"),
  );
} else {
  console.log("[embedded-runner-imports] no deprecated core imports found");
}
