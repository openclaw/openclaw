#!/usr/bin/env bash
set -euo pipefail

on_error() {
  echo "A2UI bundling failed. Re-run with: pnpm canvas:a2ui:bundle" >&2
  echo "If this persists, verify pnpm deps and try again." >&2
}
trap on_error ERR

NODE_SHIM_DIR=""
NODE_REQUIRES_WINDOWS_PATHS=0
cleanup() {
  if [[ -n "$NODE_SHIM_DIR" && -d "$NODE_SHIM_DIR" ]]; then
    rm -rf "$NODE_SHIM_DIR"
  fi
}
trap cleanup EXIT

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HASH_FILE="$ROOT_DIR/src/canvas-host/a2ui/.bundle.hash"
OUTPUT_FILE="$ROOT_DIR/src/canvas-host/a2ui/a2ui.bundle.js"
A2UI_RENDERER_DIR="$ROOT_DIR/vendor/a2ui/renderers/lit"
A2UI_APP_DIR="$ROOT_DIR/apps/shared/OpenClawKit/Tools/CanvasA2UI"

ensure_node_shim() {
  if command -v node >/dev/null 2>&1; then
    return 0
  fi

  local node_exe
  node_exe="$(command -v node.exe || true)"
  if [[ -z "$node_exe" ]]; then
    echo "Node.js is not available in this shell. Install Node.js or ensure node/node.exe is on PATH." >&2
    return 1
  fi

  NODE_SHIM_DIR="$(mktemp -d)"
  NODE_REQUIRES_WINDOWS_PATHS=1
  cat > "$NODE_SHIM_DIR/node" <<'EOF'
#!/usr/bin/env bash
exec node.exe "$@"
EOF
  chmod +x "$NODE_SHIM_DIR/node"
  export PATH="$NODE_SHIM_DIR:$PATH"
}

ensure_node_shim

to_node_path() {
  local input_path="$1"
  if [[ "$NODE_REQUIRES_WINDOWS_PATHS" -eq 1 ]]; then
    wslpath -w "$input_path"
  else
    printf '%s\n' "$input_path"
  fi
}

run_pnpm() {
  if [[ "$NODE_REQUIRES_WINDOWS_PATHS" -eq 1 ]]; then
    cmd.exe /d /c pnpm.cmd "$@"
  else
    pnpm "$@"
  fi
}

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

compute_hash() {
  local node_root_dir="$ROOT_DIR"
  local node_inputs=("${INPUT_PATHS[@]}")

  if [[ "$NODE_REQUIRES_WINDOWS_PATHS" -eq 1 ]]; then
    node_root_dir="$(to_node_path "$ROOT_DIR")"
    node_inputs=()
    for input_path in "${INPUT_PATHS[@]}"; do
      node_inputs+=("$(to_node_path "$input_path")")
    done
  fi

  ROOT_DIR="$node_root_dir" node --input-type=module --eval '
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const rootDir = process.env.ROOT_DIR ?? process.cwd();
const inputs = process.argv.slice(1);
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
' "${node_inputs[@]}"
}

current_hash="$(compute_hash)"
if [[ -f "$HASH_FILE" ]]; then
  previous_hash="$(cat "$HASH_FILE")"
  if [[ "$previous_hash" == "$current_hash" && -f "$OUTPUT_FILE" ]]; then
    echo "A2UI bundle up to date; skipping."
    exit 0
  fi
fi

run_pnpm -s exec tsc -p "$(to_node_path "$A2UI_RENDERER_DIR/tsconfig.json")"
if command -v rolldown >/dev/null 2>&1 && rolldown --version >/dev/null 2>&1; then
  rolldown -c "$A2UI_APP_DIR/rolldown.config.mjs"
elif [[ -f "$ROOT_DIR/node_modules/.pnpm/node_modules/rolldown/bin/cli.mjs" ]]; then
  node "$(to_node_path "$ROOT_DIR/node_modules/.pnpm/node_modules/rolldown/bin/cli.mjs")" \
    -c "$(to_node_path "$A2UI_APP_DIR/rolldown.config.mjs")"
elif [[ -f "$ROOT_DIR/node_modules/.pnpm/rolldown@1.0.0-rc.9/node_modules/rolldown/bin/cli.mjs" ]]; then
  node "$(to_node_path "$ROOT_DIR/node_modules/.pnpm/rolldown@1.0.0-rc.9/node_modules/rolldown/bin/cli.mjs")" \
    -c "$(to_node_path "$A2UI_APP_DIR/rolldown.config.mjs")"
else
  run_pnpm -s dlx rolldown -c "$(to_node_path "$A2UI_APP_DIR/rolldown.config.mjs")"
fi

echo "$current_hash" > "$HASH_FILE"
