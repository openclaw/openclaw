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
TSC_CLI="$ROOT_DIR/node_modules/typescript/bin/tsc"
ROLLDOWN_CLI="$ROOT_DIR/node_modules/rolldown/bin/cli.mjs"

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node.exe 2>/dev/null || true)"
fi
if [[ -z "$NODE_BIN" ]]; then
  for node_dir in \
    "/c/Program Files/nodejs" \
    "/c/Program Files (x86)/nodejs" \
    "/mnt/c/Program Files/nodejs" \
    "/mnt/c/Program Files (x86)/nodejs"
  do
    if [[ -x "$node_dir/node.exe" ]]; then
      NODE_BIN="$node_dir/node.exe"
      break
    fi
  done
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "node runtime not found for A2UI bundling" >&2
  exit 1
fi

node_path() {
  local value="$1"
  if [[ "$NODE_BIN" == *.exe && "$value" == /* ]]; then
    if [[ "$value" =~ ^/mnt/([a-zA-Z])/(.*)$ ]]; then
      local drive="${BASH_REMATCH[1]^^}:"
      local rest="${BASH_REMATCH[2]//\//\\}"
      printf "%s\\%s" "$drive" "$rest"
      return
    fi
    if [[ "$value" =~ ^/([a-zA-Z])/(.*)$ ]]; then
      local drive="${BASH_REMATCH[1]^^}:"
      local rest="${BASH_REMATCH[2]//\//\\}"
      printf "%s\\%s" "$drive" "$rest"
      return
    fi
  fi
  printf "%s" "$value"
}

NODE_ROOT_DIR="$(node_path "$ROOT_DIR")"
NODE_TSC_CLI="$(node_path "$TSC_CLI")"
NODE_ROLLDOWN_CLI="$(node_path "$ROLLDOWN_CLI")"
NODE_ROLLDOWN_CONFIG="$(node_path "$A2UI_APP_DIR/rolldown.config.mjs")"
NODE_A2UI_RENDERER_TSCONFIG="$(node_path "$A2UI_RENDERER_DIR/tsconfig.json")"

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

INPUT_PATHS=(
  "$ROOT_DIR/package.json"
  "$ROOT_DIR/pnpm-lock.yaml"
  "$A2UI_RENDERER_DIR"
  "$A2UI_APP_DIR"
)

NODE_INPUT_PATHS=()
for input_path in "${INPUT_PATHS[@]}"; do
  NODE_INPUT_PATHS+=("$(node_path "$input_path")")
done

compute_hash() {
  ROOT_DIR="$NODE_ROOT_DIR" "$NODE_BIN" --input-type=module - "${NODE_INPUT_PATHS[@]}" <<'NODE'
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

"$NODE_BIN" "$NODE_TSC_CLI" -p "$NODE_A2UI_RENDERER_TSCONFIG"
"$NODE_BIN" "$NODE_ROLLDOWN_CLI" -c "$NODE_ROLLDOWN_CONFIG"

echo "$current_hash" > "$HASH_FILE"
