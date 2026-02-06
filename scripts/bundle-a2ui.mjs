#!/usr/bin/env node
import { spawnSync } from "child_process";
import crypto from "crypto";
import { promises as fs } from "fs";
import path from "path";

const ROOT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const HASH_FILE = path.join(ROOT_DIR, "src/canvas-host/a2ui/.bundle.hash");
const OUTPUT_FILE = path.join(ROOT_DIR, "src/canvas-host/a2ui/a2ui.bundle.js");
const A2UI_RENDERER_DIR = path.join(ROOT_DIR, "vendor/a2ui/renderers/lit");
const A2UI_APP_DIR = path.join(ROOT_DIR, "apps/shared/OpenClawKit/Tools/CanvasA2UI");

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function computeHash(inputs) {
  const files = [];
  async function walk(entry) {
    const st = await fs.stat(entry);
    if (st.isDirectory()) {
      const entries = await fs.readdir(entry);
      for (const e of entries) await walk(path.join(entry, e));
      return;
    }
    files.push(entry);
  }
  for (const input of inputs) await walk(input);
  function normalize(p) {
    return p.split(path.sep).join("/");
  }
  files.sort((a, b) => normalize(a).localeCompare(normalize(b)));
  const hash = crypto.createHash("sha256");
  for (const filePath of files) {
    const rel = normalize(path.relative(ROOT_DIR, filePath));
    hash.update(rel);
    hash.update("\0");
    hash.update(await fs.readFile(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

(async function main() {
  if (!(await exists(A2UI_RENDERER_DIR)) || !(await exists(A2UI_APP_DIR))) {
    console.log("A2UI sources missing; keeping prebuilt bundle.");
    process.exit(0);
  }

  const INPUT_PATHS = [
    path.join(ROOT_DIR, "package.json"),
    path.join(ROOT_DIR, "pnpm-lock.yaml"),
    A2UI_RENDERER_DIR,
    A2UI_APP_DIR,
  ];

  const current_hash = await computeHash(INPUT_PATHS);
  try {
    if (await exists(HASH_FILE)) {
      const previous_hash = (await fs.readFile(HASH_FILE, "utf8")).trim();
      if (previous_hash === current_hash && (await exists(OUTPUT_FILE))) {
        console.log("A2UI bundle up to date; skipping.");
        process.exit(0);
      }
    }
  } catch (err) {
    // continue
  }

  // Compile renderer TS
  console.log("Compiling A2UI renderer tsc...");
  const tsc = spawnSync(
    "pnpm",
    ["-s", "exec", "tsc", "-p", path.join(A2UI_RENDERER_DIR, "tsconfig.json")],
    { stdio: "inherit", shell: true },
  );
  if (tsc.status !== 0) process.exit(tsc.status || 1);

  // Run rolldown (via pnpm exec to ensure correct platform binary)
  console.log("Running rolldown...");
  const rolldown = spawnSync(
    "pnpm",
    ["-s", "exec", "rolldown", "-c", path.join(A2UI_APP_DIR, "rolldown.config.mjs")],
    { stdio: "inherit", shell: true },
  );
  if (rolldown.status !== 0) process.exit(rolldown.status || 1);

  await fs.writeFile(HASH_FILE, current_hash, "utf8");
  console.log("A2UI bundle complete.");
})();
