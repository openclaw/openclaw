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

INPUT_PATHS=(
  "$ROOT_DIR/package.json"
  "$ROOT_DIR/pnpm-lock.yaml"
  "$A2UI_RENDERER_DIR"
  "$A2UI_APP_DIR"
)

resolve_node_bin() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi

  if command -v node.exe >/dev/null 2>&1; then
    command -v node.exe
    return 0
  fi

  if command -v where.exe >/dev/null 2>&1; then
    while IFS= read -r windows_path; do
      windows_path="${windows_path//$'\r'/}"
      [[ -z "$windows_path" ]] && continue

      if command -v cygpath >/dev/null 2>&1; then
        candidate="$(cygpath -u "$windows_path" 2>/dev/null || true)"
      else
        candidate="$windows_path"
      fi

      if [[ -n "$candidate" && -x "$candidate" ]]; then
        echo "$candidate"
        return 0
      fi
    done < <(where.exe node 2>/dev/null || true)
  fi

  return 1
}

NODE_BIN="$(resolve_node_bin || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node executable not found in PATH (bash)." >&2
  echo "On Windows, ensure Node is installed and accessible to your bash shell." >&2
  exit 1
fi

NODE_USES_WINDOWS_PATHS=0
if [[ "$NODE_BIN" == *.exe ]]; then
  NODE_USES_WINDOWS_PATHS=1
fi

if ! command -v node >/dev/null 2>&1; then
  NODE_SHIM_DIR="$ROOT_DIR/.cache/node-shim"
  NODE_SHIM_PATH="$NODE_SHIM_DIR/node"
  mkdir -p "$NODE_SHIM_DIR"
  printf '#!/usr/bin/env bash\nexec "%s" "$@"\n' "$NODE_BIN" > "$NODE_SHIM_PATH"
  chmod +x "$NODE_SHIM_PATH"
  PATH="$NODE_SHIM_DIR:$PATH"
fi

to_node_path() {
  local p="$1"
  if [[ "$NODE_USES_WINDOWS_PATHS" -eq 1 ]]; then
    if command -v wslpath >/dev/null 2>&1; then
      wslpath -w "$p"
      return 0
    fi
    if command -v cygpath >/dev/null 2>&1; then
      cygpath -w "$p"
      return 0
    fi
  fi
  echo "$p"
}

compute_hash() {
  local root_dir_for_node
  root_dir_for_node="$(to_node_path "$ROOT_DIR")"

  local input_paths_for_node=()
  local input_path
  for input_path in "${INPUT_PATHS[@]}"; do
    input_paths_for_node+=("$(to_node_path "$input_path")")
  done

  ROOT_DIR="$root_dir_for_node" "$NODE_BIN" --input-type=module - "${input_paths_for_node[@]}" <<'NODE'
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

if [[ "$NODE_USES_WINDOWS_PATHS" -eq 1 ]]; then
  renderer_tsconfig_win="$(to_node_path "$A2UI_RENDERER_DIR/tsconfig.json")"
  app_rolldown_config_win="$(to_node_path "$A2UI_APP_DIR/rolldown.config.mjs")"
  cmd.exe /d /s /c "pnpm -s exec tsc -p $renderer_tsconfig_win"
  if command -v rolldown >/dev/null 2>&1; then
    cmd.exe /d /s /c "rolldown -c $app_rolldown_config_win"
  else
    cmd.exe /d /s /c "pnpm -s dlx rolldown -c $app_rolldown_config_win"
  fi
else
  pnpm -s exec tsc -p "$A2UI_RENDERER_DIR/tsconfig.json"
  if command -v rolldown >/dev/null 2>&1; then
    rolldown -c "$A2UI_APP_DIR/rolldown.config.mjs"
  else
    pnpm -s dlx rolldown -c "$A2UI_APP_DIR/rolldown.config.mjs"
  fi
fi

echo "$current_hash" > "$HASH_FILE"
