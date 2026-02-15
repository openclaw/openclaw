#!/usr/bin/env tsx
/**
 * Bundle A2UI renderer + app into a single JS bundle.
 * Cross-platform replacement for bundle-a2ui.sh.
 */

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

const HASH_FILE = path.join(ROOT_DIR, "src/canvas-host/a2ui/.bundle.hash");
const OUTPUT_FILE = path.join(ROOT_DIR, "src/canvas-host/a2ui/a2ui.bundle.js");
const A2UI_RENDERER_DIR = path.join(ROOT_DIR, "vendor/a2ui/renderers/lit");
const A2UI_APP_DIR = path.join(ROOT_DIR, "apps/shared/OpenClawKit/Tools/CanvasA2UI");

// Docker builds exclude vendor/apps via .dockerignore.
// In that environment we can keep a prebuilt bundle only if it exists.
if (!fs.existsSync(A2UI_RENDERER_DIR) || !fs.existsSync(A2UI_APP_DIR)) {
  if (fs.existsSync(OUTPUT_FILE)) {
    console.log("A2UI sources missing; keeping prebuilt bundle.");
    process.exit(0);
  }
  console.error(`A2UI sources missing and no prebuilt bundle found at: ${OUTPUT_FILE}`);
  process.exit(1);
}

// Compute content hash from all input files.
const INPUT_PATHS = [
  path.join(ROOT_DIR, "package.json"),
  path.join(ROOT_DIR, "pnpm-lock.yaml"),
  A2UI_RENDERER_DIR,
  A2UI_APP_DIR,
];

async function walkFiles(entryPath: string): Promise<string[]> {
  const st = fs.statSync(entryPath);
  if (st.isDirectory()) {
    const entries = fs.readdirSync(entryPath);
    const all: string[] = [];
    for (const entry of entries) {
      all.push(...(await walkFiles(path.join(entryPath, entry))));
    }
    return all;
  }
  return [entryPath];
}

function normalize(p: string): string {
  return p.split(path.sep).join("/");
}

async function computeHash(): Promise<string> {
  const files: string[] = [];
  for (const input of INPUT_PATHS) {
    files.push(...(await walkFiles(input)));
  }
  files.sort((a, b) => normalize(a).localeCompare(normalize(b)));

  const hash = createHash("sha256");
  for (const filePath of files) {
    const rel = normalize(path.relative(ROOT_DIR, filePath));
    hash.update(rel);
    hash.update("\0");
    hash.update(fs.readFileSync(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function run(cmd: string) {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd: ROOT_DIR, stdio: "inherit" });
}

try {
  const currentHash = await computeHash();

  if (fs.existsSync(HASH_FILE)) {
    const previousHash = fs.readFileSync(HASH_FILE, "utf-8").trim();
    if (previousHash === currentHash && fs.existsSync(OUTPUT_FILE)) {
      console.log("A2UI bundle up to date; skipping.");
      process.exit(0);
    }
  }

  run(`pnpm -s exec tsc -p "${path.relative(ROOT_DIR, path.join(A2UI_RENDERER_DIR, "tsconfig.json"))}"`);
  run(`pnpm exec rolldown -c "${path.relative(ROOT_DIR, path.join(A2UI_APP_DIR, "rolldown.config.mjs"))}"`);

  fs.writeFileSync(HASH_FILE, currentHash);
  console.log("A2UI bundle complete.");
} catch (err) {
  console.error("A2UI bundling failed. Re-run with: pnpm canvas:a2ui:bundle");
  console.error("If this persists, verify pnpm deps and try again.");
  process.exit(1);
}
