#!/usr/bin/env bash
set -euo pipefail

on_error() {
  echo "A2UI bundling failed. Re-run with: pnpm canvas:a2ui:bundle" >&2
  echo "If this persists, verify pnpm deps and try again." >&2
}
trap on_error ERR

# Find node executable (handle Windows)
find_node() {
  if command -v node &> /dev/null; then
    echo "node"
  elif command -v node.exe &> /dev/null; then
    echo "node.exe"
  elif [[ -n "${NODE_PATH:-}" ]] && [[ -x "$NODE_PATH/node.exe" ]]; then
    echo "$NODE_PATH/node.exe"
  elif [[ -n "${NODE_PATH:-}" ]] && [[ -x "$NODE_PATH/node" ]]; then
    echo "$NODE_PATH/node"
  else
    # Try to use which/where to find node
    local node_path
    node_path=$(which node 2>/dev/null || where.exe node.exe 2>/dev/null | head -1 || echo "")
    if [[ -n "$node_path" ]]; then
      echo "$node_path"
    else
      echo "node"
    fi
  fi
}

NODE_CMD="$(find_node)"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Convert bash path to Windows path for Node
win_path() {
  local p="$1"
  # If running in Git Bash/MSYS on Windows
  if [[ -n "${MSYSTEM:-}" ]] || command -v cygpath &> /dev/null; then
    if command -v cygpath &> /dev/null; then
      cygpath -w "$p"
    else
      # Manual conversion for Git Bash
      echo "$p" | sed -E 's|^/([a-z])/|\1:/|i'
    fi
  else
    echo "$p"
  fi
}

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

compute_hash() {
  # Convert all paths to Windows format for Node
  local root_for_node="$(win_path "$ROOT_DIR")"
  local pkg_json="$(win_path "$ROOT_DIR/package.json")"
  local pnpm_lock="$(win_path "$ROOT_DIR/pnpm-lock.yaml")"
  local renderer_dir="$(win_path "$A2UI_RENDERER_DIR")"
  local app_dir="$(win_path "$A2UI_APP_DIR")"
  
  ROOT_DIR="$root_for_node" "$NODE_CMD" --input-type=module - "$pkg_json" "$pnpm_lock" "$renderer_dir" "$app_dir" <<'NODE'
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

pnpm -s exec tsc -p "$A2UI_RENDERER_DIR/tsconfig.json"
rolldown -c "$A2UI_APP_DIR/rolldown.config.mjs"

echo "$current_hash" > "$HASH_FILE"
