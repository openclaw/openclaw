import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const HASH_FILE = join(ROOT_DIR, "src", "canvas-host", "a2ui", ".bundle.hash");
const OUTPUT_FILE = join(ROOT_DIR, "src", "canvas-host", "a2ui", "a2ui.bundle.js");
const A2UI_RENDERER_DIR = join(ROOT_DIR, "vendor", "a2ui", "renderers", "lit");
const A2UI_APP_DIR = join(ROOT_DIR, "apps", "shared", "OpenClawKit", "Tools", "CanvasA2UI");

if (!existsSync(A2UI_RENDERER_DIR) || !existsSync(A2UI_APP_DIR)) {
  console.log("A2UI sources missing; keeping prebuilt bundle.");
  process.exit(0);
}

const INPUT_PATHS = [
  join(ROOT_DIR, "package.json"),
  join(ROOT_DIR, "pnpm-lock.yaml"),
  A2UI_RENDERER_DIR,
  A2UI_APP_DIR,
];

function getFiles(dir: string): string[] {
  let results: string[] = [];
  const list = readdirSync(dir);
  for (const file of list) {
    const filePath = join(dir, file);
    const stat = statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getFiles(filePath));
    } else {
      results.push(filePath);
    }
  }
  return results;
}

function computeHash(): string {
  let allFiles: string[] = [];
  for (const input of INPUT_PATHS) {
    const stat = statSync(input);
    if (stat.isDirectory()) {
      allFiles = allFiles.concat(getFiles(input));
    } else {
      allFiles.push(input);
    }
  }

  // Normalize paths for consistent sorting
  const normalizePath = (p: string) => p.split(sep).join("/");
  allFiles.sort((a, b) => normalizePath(a).localeCompare(normalizePath(b)));

  const hash = createHash("sha256");
  for (const filePath of allFiles) {
    const rel = normalizePath(relative(ROOT_DIR, filePath));
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

const currentHash = computeHash();

if (existsSync(HASH_FILE)) {
  const previousHash = readFileSync(HASH_FILE, "utf-8").trim();
  if (previousHash === currentHash && existsSync(OUTPUT_FILE)) {
    console.log("A2UI bundle up to date; skipping.");
    process.exit(0);
  }
}

// Emulate: pnpm -s exec tsc -p "$A2UI_RENDERER_DIR/tsconfig.json"
console.log("Compiling A2UI renderer...");
const tscResult = spawnSync(
  "pnpm",
  ["exec", "tsc", "-p", join(A2UI_RENDERER_DIR, "tsconfig.json")],
  {
    stdio: "inherit",
    shell: true,
    cwd: ROOT_DIR,
  },
);

if (tscResult.status !== 0) {
  console.error("A2UI bundling failed: tsc error");
  process.exit(1);
}

// Emulate: rolldown -c "$A2UI_APP_DIR/rolldown.config.mjs"
console.log("Bundling A2UI app...");
const rolldownResult = spawnSync(
  "npx",
  ["rolldown", "-c", join(A2UI_APP_DIR, "rolldown.config.mjs")],
  {
    stdio: "inherit",
    shell: true,
    cwd: ROOT_DIR,
  },
);

if (rolldownResult.status !== 0) {
  console.error("A2UI bundling failed: rolldown error");
  process.exit(1);
}

// Ensure directory exists for hash file
const hashDir = join(ROOT_DIR, "src", "canvas-host", "a2ui");
if (!existsSync(hashDir)) {
  mkdirSync(hashDir, { recursive: true });
}

writeFileSync(HASH_FILE, currentHash);
console.log("A2UI bundle updated.");
