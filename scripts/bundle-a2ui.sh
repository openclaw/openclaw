#!/usr/bin/env bash
set -euo pipefail

on_error() {
  echo "A2UI bundling failed. Re-run with: pnpm canvas:a2ui:bundle" >&2
  echo "If this persists, verify pnpm deps and try again." >&2
}
trap on_error ERR

# Resolve a working node so the script works on Windows (Git Bash/WSL), Linux, and macOS.
NODE=""
if command -v node >/dev/null 2>&1; then
  NODE="node"
fi

# Windows: when bash is Git Bash or WSL, node is often not in PATH; try Windows install locations.
if [[ -z "$NODE" ]]; then
  for candidate in \
    "/mnt/c/Program Files/nodejs/node.exe" \
    "/mnt/c/Program Files (x86)/nodejs/node.exe" \
    "/c/Program Files/nodejs/node.exe" \
    "/c/Program Files/nodejs/node" \
    "/mingw64/c/Program Files/nodejs/node.exe"; do
    if [[ -x "$candidate" ]]; then
      NODE="$candidate"
      export PATH="$(dirname "$candidate"):$PATH"
      break
    fi
  done
fi

# Linux/macOS: fallback to common install locations if not in PATH.
if [[ -z "$NODE" ]]; then
  for candidate in /usr/local/bin/node /usr/bin/node; do
    if [[ -x "$candidate" ]]; then
      NODE="$candidate"
      break
    fi
  done
fi

if [[ -z "$NODE" ]]; then
  echo "node not found. Install Node.js or run from a shell where 'node' is in PATH." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HASH_FILE="$ROOT_DIR/src/canvas-host/a2ui/.bundle.hash"
OUTPUT_FILE="$ROOT_DIR/src/canvas-host/a2ui/a2ui.bundle.js"
A2UI_RENDERER_DIR="$ROOT_DIR/vendor/a2ui/renderers/lit"
A2UI_APP_DIR="$ROOT_DIR/apps/shared/OpenClawKit/Tools/CanvasA2UI"

cd "$ROOT_DIR" || exit 1

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

# Pass no paths from bash to Node so Windows Node never sees Unix-style paths (e.g. /e/PET/...).
# The script uses process.cwd() and builds paths itself.
compute_hash() {
  "$NODE" --input-type=module - <<'NODE'
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const inputs = [
  path.join(rootDir, "package.json"),
  path.join(rootDir, "pnpm-lock.yaml"),
  path.join(rootDir, "vendor/a2ui/renderers/lit"),
  path.join(rootDir, "apps/shared/OpenClawKit/Tools/CanvasA2UI"),
];
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

# Run tsc and rolldown via $NODE; relative paths are valid because we cd'd to $ROOT_DIR above.
"$NODE" node_modules/typescript/bin/tsc -p vendor/a2ui/renderers/lit/tsconfig.json
"$NODE" node_modules/rolldown/bin/cli.mjs -c apps/shared/OpenClawKit/Tools/CanvasA2UI/rolldown.config.mjs

echo "$current_hash" > "$HASH_FILE"
