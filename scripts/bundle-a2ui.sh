#!/usr/bin/env bash
set -euo pipefail

on_error() {
  echo "A2UI bundling failed. Re-run with: pnpm canvas:a2ui:bundle" >&2
  echo "If this persists, verify pnpm deps and try again." >&2
}
trap on_error ERR

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HASH_FILE="$ROOT_DIR/src/canvas-host/a2ui/.bundle.hash"
OUTPUT_FILE="$ROOT_DIR/src/canvas-host/a2ui/a2ui.bundle.js"
A2UI_RENDERER_DIR="$ROOT_DIR/vendor/a2ui/renderers/lit"
A2UI_APP_DIR="$ROOT_DIR/apps/shared/OpenClawKit/Tools/CanvasA2UI"

# Docker builds exclude vendor/apps via .dockerignore.
# In that environment we can keep a prebuilt bundle only if it exists.
if [[ ! -d "$A2UI_RENDERER_DIR" || ! -d "$A2UI_APP_DIR" ]]; then
  if [[ -f "$OUTPUT_FILE" ]]; then
    echo "A2UI sources missing; keeping prebuilt bundle."
    exit 0
  fi
  echo "A2UI sources missing and no prebuilt bundle found at: $OUTPUT_FILE" >&2
  exit 1
fi

# Allow skipping A2UI bundling via environment variable
if [[ "${OPENCLAW_A2UI_SKIP_MISSING:-}" == "1" ]]; then
  if [[ ! -f "$OUTPUT_FILE" ]]; then
    echo "Warning: A2UI bundle missing but OPENCLAW_A2UI_SKIP_MISSING=1 is set. Skipping bundling." >&2
  fi
  exit 0
fi

INPUT_PATHS=(
  "$ROOT_DIR/package.json"
  "$ROOT_DIR/pnpm-lock.yaml"
  "$A2UI_RENDERER_DIR"
  "$A2UI_APP_DIR"
)

compute_hash() {
  ROOT_DIR="$ROOT_DIR" node --input-type=module - "${INPUT_PATHS[@]}" <<'NODE'
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const rootDir = process.env.ROOT_DIR ?? process.cwd();
const inputs = process.argv.slice(2);
const files = [];

async function walk(entryPath) {
  const st = await fs.stat(entryPath);
  if (st.isDirectory()) {
    const entries = await fs.readdir(entryPath);
    for (const entry of entries) {
      await walk(path.join(entryPath, entry));
    }
    return;
  }
  files.push(entryPath);
}

for (const input of inputs) {
  await walk(input);
}

function normalize(p) {
  return p.split(path.sep).join("/");
}

files.sort((a, b) => normalize(a).localeCompare(normalize(b)));

const hash = createHash("sha256");
for (const filePath of files) {
  const rel = normalize(path.relative(rootDir, filePath));
  hash.update(rel);
  hash.update("\0");
  hash.update(await fs.readFile(filePath));
  hash.update("\0");
}

process.stdout.write(hash.digest("hex"));
NODE
}

current_hash="$(compute_hash)"
if [[ -f "$HASH_FILE" ]]; then
  previous_hash="$(cat "$HASH_FILE")"
  if [[ "$previous_hash" == "$current_hash" && -f "$OUTPUT_FILE" ]]; then
    echo "A2UI bundle up to date; skipping."
    exit 0
  fi
fi

# Ensure vendor dependencies are installed
if [[ ! -d "$A2UI_RENDERER_DIR/node_modules" ]]; then
  echo "Installing vendor dependencies for A2UI renderer..."
  if ! (cd "$A2UI_RENDERER_DIR" && pnpm install --silent 2>&1); then
    echo "Error: Failed to install vendor dependencies." >&2
    echo "You can:" >&2
    echo "  1. Manually run: cd vendor/a2ui/renderers/lit && pnpm install" >&2
    echo "  2. Skip A2UI bundling: OPENCLAW_A2UI_SKIP_MISSING=1 pnpm build" >&2
    exit 1
  fi
fi

# Check if dist directory exists after compilation
if ! pnpm -s exec tsc -p "$A2UI_RENDERER_DIR/tsconfig.json" 2>&1; then
  echo "Error: TypeScript compilation failed for A2UI renderer." >&2
  echo "Check vendor/a2ui/renderers/lit for compilation errors." >&2
  exit 1
fi

if ! rolldown -c "$A2UI_APP_DIR/rolldown.config.mjs" 2>&1; then
  echo "Error: Rolldown bundling failed for A2UI app." >&2
  exit 1
pnpm -s exec tsc -p "$A2UI_RENDERER_DIR/tsconfig.json"
if command -v rolldown >/dev/null 2>&1 && rolldown --version >/dev/null 2>&1; then
  rolldown -c "$A2UI_APP_DIR/rolldown.config.mjs"
else
  pnpm -s dlx rolldown -c "$A2UI_APP_DIR/rolldown.config.mjs"
fi

echo "$current_hash" > "$HASH_FILE"
