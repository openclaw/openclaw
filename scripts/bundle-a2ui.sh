#!/usr/bin/env bash
set -euo pipefail

on_error() {
  echo "A2UI bundling failed. Re-run with: pnpm canvas:a2ui:bundle" >&2
  echo "If this persists, verify pnpm deps and try again." >&2
}
trap on_error ERR

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Resolve a usable Node binary for bash environments on Windows/WSL/MSYS.
NODE_BIN="${NODE_BIN:-}"

if [[ -z "${NODE_BIN}" ]]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="node"
  elif command -v node.exe >/dev/null 2>&1; then
    NODE_BIN="node.exe"
  elif [[ -x "/mnt/c/Program Files/nodejs/node.exe" ]]; then
    NODE_BIN="/mnt/c/Program Files/nodejs/node.exe"
  elif [[ -n "${PROGRAMFILES:-}" ]]; then
    # Best-effort conversion of Windows ProgramFiles path to WSL mount path.
    PF_LC="$(printf "%s" "${PROGRAMFILES}" | tr '[:upper:]' '[:lower:]')"
    PF_LC="${PF_LC//\\//}"
    CAND="/mnt/c/${PF_LC#c:/}/nodejs/node.exe"
    if [[ -x "$CAND" ]]; then
      NODE_BIN="$CAND"
    fi
  fi
fi

if [[ -z "${NODE_BIN}" ]]; then
  echo "Node binary not found in this bash environment. Set NODE_BIN or ensure node is on PATH." >&2
  exit 1
fi

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

INPUT_PATHS=(
  "$ROOT_DIR/package.json"
  "$ROOT_DIR/pnpm-lock.yaml"
  "$A2UI_RENDERER_DIR"
  "$A2UI_APP_DIR"
)

# If we are using a Windows Node binary (node.exe), convert input paths to Windows form.
IS_WINDOWS_NODE=0
case "$NODE_BIN" in
  *node.exe) IS_WINDOWS_NODE=1 ;;
esac

NODE_INPUT_PATHS=("${INPUT_PATHS[@]}")

if [[ "$IS_WINDOWS_NODE" -eq 1 ]]; then
  if command -v wslpath >/dev/null 2>&1; then
    NODE_INPUT_PATHS=()
    for p in "${INPUT_PATHS[@]}"; do
      NODE_INPUT_PATHS+=("$(wslpath -w "$p")")
    done
  elif command -v cygpath >/dev/null 2>&1; then
    NODE_INPUT_PATHS=()
    for p in "${INPUT_PATHS[@]}"; do
      NODE_INPUT_PATHS+=("$(cygpath -w "$p")")
    done
  fi
fi

compute_hash() {
  if [[ "$IS_WINDOWS_NODE" -eq 1 ]]; then
    HASH_SCRIPT_WSL="/mnt/c/tmp/hash_script.mjs"
    mkdir -p "/mnt/c/tmp"
    cat > "$HASH_SCRIPT_WSL" << 'SCRIPTEOF'
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
SCRIPTEOF
    HASH_SCRIPT_WIN="$(wslpath -w "$HASH_SCRIPT_WSL")"
    ROOT_DIR="$ROOT_DIR" "$NODE_BIN" "$HASH_SCRIPT_WIN" "${NODE_INPUT_PATHS[@]}"
  else
    cat > /tmp/hash_script.mjs << 'SCRIPTEOF'
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
SCRIPTEOF
    ROOT_DIR="$ROOT_DIR" "$NODE_BIN" /tmp/hash_script.mjs "${NODE_INPUT_PATHS[@]}"
  fi
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
if command -v rolldown >/dev/null 2>&1; then
  rolldown -c "$A2UI_APP_DIR/rolldown.config.mjs"
else
  pnpm -s dlx rolldown -c "$A2UI_APP_DIR/rolldown.config.mjs"
fi

echo "$current_hash" > "$HASH_FILE"
