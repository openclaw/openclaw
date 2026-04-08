#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/live-docker-auth.sh"
IMAGE_NAME="${OPENCLAW_IMAGE:-openclaw:local}"
LIVE_IMAGE_NAME="${OPENCLAW_LIVE_IMAGE:-${IMAGE_NAME}-live}"
CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$HOME/.openclaw}"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$HOME/.openclaw/workspace}"
PROFILE_FILE="${OPENCLAW_PROFILE_FILE:-$HOME/.profile}"
CLI_TOOLS_DIR="${OPENCLAW_DOCKER_CLI_TOOLS_DIR:-$HOME/.cache/openclaw/docker-cli-tools}"
DEFAULT_PROVIDER="${OPENCLAW_DOCKER_CLI_BACKEND_PROVIDER:-claude-cli}"
CLI_MODEL="${OPENCLAW_LIVE_CLI_BACKEND_MODEL:-}"
CLI_PROVIDER="${CLI_MODEL%%/*}"
CLI_DISABLE_MCP_CONFIG="${OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG:-}"

if [[ -z "$CLI_PROVIDER" || "$CLI_PROVIDER" == "$CLI_MODEL" ]]; then
  CLI_PROVIDER="$DEFAULT_PROVIDER"
fi

CLI_METADATA_JSON="$(node --import tsx "$ROOT_DIR/scripts/print-cli-backend-live-metadata.ts" "$CLI_PROVIDER")"
read_metadata_field() {
  local field="$1"
  node -e 'const data = JSON.parse(process.argv[1]); const field = process.argv[2]; const value = data?.[field]; if (value == null) process.exit(1); process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));' \
    "$CLI_METADATA_JSON" \
    "$field"
}

DEFAULT_MODEL="$(read_metadata_field defaultModelRef 2>/dev/null || printf '%s' 'claude-cli/claude-sonnet-4-6')"
CLI_MODEL="${CLI_MODEL:-$DEFAULT_MODEL}"
CLI_DEFAULT_COMMAND="$(read_metadata_field command 2>/dev/null || true)"
CLI_DOCKER_NPM_PACKAGE="$(read_metadata_field dockerNpmPackage 2>/dev/null || true)"
CLI_DOCKER_BINARY_NAME="$(read_metadata_field dockerBinaryName 2>/dev/null || true)"

if [[ "$CLI_PROVIDER" == "claude-cli" && -z "$CLI_DISABLE_MCP_CONFIG" ]]; then
  CLI_DISABLE_MCP_CONFIG="0"
fi

mkdir -p "$CLI_TOOLS_DIR"

PROFILE_MOUNT=()
if [[ -f "$PROFILE_FILE" ]]; then
  PROFILE_MOUNT=(-v "$PROFILE_FILE":/home/node/.profile:ro)
fi

AUTH_DIRS=()
AUTH_FILES=()
if [[ -n "${OPENCLAW_DOCKER_AUTH_DIRS:-}" ]]; then
  while IFS= read -r auth_dir; do
    [[ -n "$auth_dir" ]] || continue
    AUTH_DIRS+=("$auth_dir")
  done < <(openclaw_live_collect_auth_dirs)
  while IFS= read -r auth_file; do
    [[ -n "$auth_file" ]] || continue
    AUTH_FILES+=("$auth_file")
  done < <(openclaw_live_collect_auth_files)
else
  while IFS= read -r auth_dir; do
    [[ -n "$auth_dir" ]] || continue
    AUTH_DIRS+=("$auth_dir")
  done < <(openclaw_live_collect_auth_dirs_from_csv "$CLI_PROVIDER")
  while IFS= read -r auth_file; do
    [[ -n "$auth_file" ]] || continue
    AUTH_FILES+=("$auth_file")
  done < <(openclaw_live_collect_auth_files_from_csv "$CLI_PROVIDER")
fi
AUTH_DIRS_CSV=""
if ((${#AUTH_DIRS[@]} > 0)); then
  AUTH_DIRS_CSV="$(openclaw_live_join_csv "${AUTH_DIRS[@]}")"
fi
AUTH_FILES_CSV=""
if ((${#AUTH_FILES[@]} > 0)); then
  AUTH_FILES_CSV="$(openclaw_live_join_csv "${AUTH_FILES[@]}")"
fi

EXTERNAL_AUTH_MOUNTS=()
if ((${#AUTH_DIRS[@]} > 0)); then
  for auth_dir in "${AUTH_DIRS[@]}"; do
    host_path="$HOME/$auth_dir"
    if [[ -d "$host_path" ]]; then
      EXTERNAL_AUTH_MOUNTS+=(-v "$host_path":/host-auth/"$auth_dir":ro)
    fi
  done
fi
if ((${#AUTH_FILES[@]} > 0)); then
  for auth_file in "${AUTH_FILES[@]}"; do
    host_path="$HOME/$auth_file"
    if [[ -f "$host_path" ]]; then
      EXTERNAL_AUTH_MOUNTS+=(-v "$host_path":/host-auth-files/"$auth_file":ro)
    fi
  done
fi

read -r -d '' LIVE_TEST_CMD <<'EOF' || true
set -euo pipefail
[ -f "$HOME/.profile" ] && source "$HOME/.profile" || true
export PATH="$HOME/.npm-global/bin:$PATH"
IFS=',' read -r -a auth_dirs <<<"${OPENCLAW_DOCKER_AUTH_DIRS_RESOLVED:-}"
IFS=',' read -r -a auth_files <<<"${OPENCLAW_DOCKER_AUTH_FILES_RESOLVED:-}"
if ((${#auth_dirs[@]} > 0)); then
  for auth_dir in "${auth_dirs[@]}"; do
    [ -n "$auth_dir" ] || continue
    if [ -d "/host-auth/$auth_dir" ]; then
      mkdir -p "$HOME/$auth_dir"
      cp -R "/host-auth/$auth_dir/." "$HOME/$auth_dir"
      chmod -R u+rwX "$HOME/$auth_dir" || true
    fi
  done
fi
if ((${#auth_files[@]} > 0)); then
  for auth_file in "${auth_files[@]}"; do
    [ -n "$auth_file" ] || continue
    if [ -f "/host-auth-files/$auth_file" ]; then
      mkdir -p "$(dirname "$HOME/$auth_file")"
      cp "/host-auth-files/$auth_file" "$HOME/$auth_file"
      chmod u+rw "$HOME/$auth_file" || true
    fi
  done
fi
provider="${OPENCLAW_DOCKER_CLI_BACKEND_PROVIDER:-claude-cli}"
default_command="${OPENCLAW_DOCKER_CLI_BACKEND_COMMAND_DEFAULT:-}"
docker_package="${OPENCLAW_DOCKER_CLI_BACKEND_NPM_PACKAGE:-}"
binary_name="${OPENCLAW_DOCKER_CLI_BACKEND_BINARY_NAME:-}"
if [ -z "$binary_name" ] && [ -n "$default_command" ]; then
  binary_name="$(basename "$default_command")"
fi
if [ -z "${OPENCLAW_LIVE_CLI_BACKEND_COMMAND:-}" ] && [ -n "$binary_name" ]; then
  export OPENCLAW_LIVE_CLI_BACKEND_COMMAND="$HOME/.npm-global/bin/$binary_name"
fi
if [ -n "${OPENCLAW_LIVE_CLI_BACKEND_COMMAND:-}" ] && [ ! -x "${OPENCLAW_LIVE_CLI_BACKEND_COMMAND}" ] && [ -n "$docker_package" ]; then
  npm_config_prefix="$HOME/.npm-global" npm install -g "$docker_package"
fi
if [ "$provider" = "claude-cli" ]; then
  real_claude="$HOME/.npm-global/bin/claude-real"
  if [ ! -x "$real_claude" ] && [ -x "$HOME/.npm-global/bin/claude" ]; then
    mv "$HOME/.npm-global/bin/claude" "$real_claude"
  fi
  if [ -x "$real_claude" ]; then
    cat > "$HOME/.npm-global/bin/claude" <<WRAP
#!/usr/bin/env bash
script_dir="\$(CDPATH= cd -- "\$(dirname -- "\$0")" && pwd)"
if [ -n "\${OPENCLAW_LIVE_CLI_BACKEND_ANTHROPIC_API_KEY:-}" ]; then
  export ANTHROPIC_API_KEY="\${OPENCLAW_LIVE_CLI_BACKEND_ANTHROPIC_API_KEY}"
fi
if [ -n "\${OPENCLAW_LIVE_CLI_BACKEND_ANTHROPIC_API_KEY_OLD:-}" ]; then
  export ANTHROPIC_API_KEY_OLD="\${OPENCLAW_LIVE_CLI_BACKEND_ANTHROPIC_API_KEY_OLD}"
fi
exec "\$script_dir/claude-real" "\$@"
WRAP
    chmod +x "$HOME/.npm-global/bin/claude"
  fi
  if [ -z "${OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV:-}" ]; then
    export OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'
  fi
  claude auth status || true
fi
tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT
source /src/scripts/lib/live-docker-stage.sh
openclaw_live_stage_source_tree "$tmp_dir"
# Use a writable node_modules overlay in the temp repo. Vite writes bundled
# config artifacts under the nearest node_modules/.vite-temp path, and the
# build-stage /app/node_modules tree is root-owned in this Docker lane.
mkdir -p "$tmp_dir/node_modules"
cp -aRs /app/node_modules/. "$tmp_dir/node_modules"
rm -rf "$tmp_dir/node_modules/.vite-temp"
mkdir -p "$tmp_dir/node_modules/.vite-temp"
openclaw_live_link_runtime_tree "$tmp_dir"
openclaw_live_stage_state_dir "$tmp_dir/.openclaw-state"
openclaw_live_prepare_staged_config
cd "$tmp_dir"
pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
EOF

echo "==> Build live-test image: $LIVE_IMAGE_NAME (target=build)"
docker build --target build -t "$LIVE_IMAGE_NAME" -f "$ROOT_DIR/Dockerfile" "$ROOT_DIR"

echo "==> Run CLI backend live test in Docker"
echo "==> Model: $CLI_MODEL"
echo "==> Provider: $CLI_PROVIDER"
echo "==> External auth dirs: ${AUTH_DIRS_CSV:-none}"
echo "==> External auth files: ${AUTH_FILES_CSV:-none}"
docker run --rm -t \
  -u node \
  --entrypoint bash \
  -e ANTHROPIC_API_KEY \
  -e ANTHROPIC_API_KEY_OLD \
  -e OPENCLAW_LIVE_CLI_BACKEND_ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  -e OPENCLAW_LIVE_CLI_BACKEND_ANTHROPIC_API_KEY_OLD="${ANTHROPIC_API_KEY_OLD:-}" \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e HOME=/home/node \
  -e NODE_OPTIONS=--disable-warning=ExperimentalWarning \
  -e OPENCLAW_SKIP_CHANNELS=1 \
  -e OPENCLAW_VITEST_FS_MODULE_CACHE=0 \
  -e OPENCLAW_DOCKER_AUTH_DIRS_RESOLVED="$AUTH_DIRS_CSV" \
  -e OPENCLAW_DOCKER_AUTH_FILES_RESOLVED="$AUTH_FILES_CSV" \
  -e OPENCLAW_DOCKER_CLI_BACKEND_PROVIDER="$CLI_PROVIDER" \
  -e OPENCLAW_DOCKER_CLI_BACKEND_COMMAND_DEFAULT="$CLI_DEFAULT_COMMAND" \
  -e OPENCLAW_DOCKER_CLI_BACKEND_NPM_PACKAGE="$CLI_DOCKER_NPM_PACKAGE" \
  -e OPENCLAW_DOCKER_CLI_BACKEND_BINARY_NAME="$CLI_DOCKER_BINARY_NAME" \
  -e OPENCLAW_LIVE_TEST=1 \
  -e OPENCLAW_LIVE_CLI_BACKEND=1 \
  -e OPENCLAW_LIVE_CLI_BACKEND_MODEL="$CLI_MODEL" \
  -e OPENCLAW_LIVE_CLI_BACKEND_COMMAND="${OPENCLAW_LIVE_CLI_BACKEND_COMMAND:-}" \
  -e OPENCLAW_LIVE_CLI_BACKEND_ARGS="${OPENCLAW_LIVE_CLI_BACKEND_ARGS:-}" \
  -e OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV="${OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV:-}" \
  -e OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV="${OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV:-}" \
  -e OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG="$CLI_DISABLE_MCP_CONFIG" \
  -e OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE="${OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE:-}" \
  -e OPENCLAW_LIVE_CLI_BACKEND_MODEL_SWITCH_PROBE="${OPENCLAW_LIVE_CLI_BACKEND_MODEL_SWITCH_PROBE:-}" \
  -e OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE="${OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE:-}" \
  -e OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="${OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG:-}" \
  -e OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="${OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE:-}" \
  -v "$ROOT_DIR":/src:ro \
  -v "$CONFIG_DIR":/home/node/.openclaw \
  -v "$WORKSPACE_DIR":/home/node/.openclaw/workspace \
  -v "$CLI_TOOLS_DIR":/home/node/.npm-global \
  "${EXTERNAL_AUTH_MOUNTS[@]}" \
  "${PROFILE_MOUNT[@]}" \
  "$LIVE_IMAGE_NAME" \
  -lc "$LIVE_TEST_CMD"
