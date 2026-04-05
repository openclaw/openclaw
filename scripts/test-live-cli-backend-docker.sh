#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/live-docker-auth.sh"
IMAGE_NAME="${MULLUSI_IMAGE:-mullusi:local}"
LIVE_IMAGE_NAME="${MULLUSI_LIVE_IMAGE:-${IMAGE_NAME}-live}"
CONFIG_DIR="${MULLUSI_CONFIG_DIR:-$HOME/.mullusi}"
WORKSPACE_DIR="${MULLUSI_WORKSPACE_DIR:-$HOME/.mullusi/workspace}"
PROFILE_FILE="${MULLUSI_PROFILE_FILE:-$HOME/.profile}"
CLI_TOOLS_DIR="${MULLUSI_DOCKER_CLI_TOOLS_DIR:-$HOME/.cache/mullusi/docker-cli-tools}"
DEFAULT_MODEL="claude-cli/claude-sonnet-4-6"
CLI_MODEL="${MULLUSI_LIVE_CLI_BACKEND_MODEL:-$DEFAULT_MODEL}"
CLI_PROVIDER="${CLI_MODEL%%/*}"
CLI_DISABLE_MCP_CONFIG="${MULLUSI_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG:-}"

if [[ -z "$CLI_PROVIDER" || "$CLI_PROVIDER" == "$CLI_MODEL" ]]; then
  CLI_PROVIDER="claude-cli"
fi
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
if [[ -n "${MULLUSI_DOCKER_AUTH_DIRS:-}" ]]; then
  while IFS= read -r auth_dir; do
    [[ -n "$auth_dir" ]] || continue
    AUTH_DIRS+=("$auth_dir")
  done < <(mullusi_live_collect_auth_dirs)
  while IFS= read -r auth_file; do
    [[ -n "$auth_file" ]] || continue
    AUTH_FILES+=("$auth_file")
  done < <(mullusi_live_collect_auth_files)
else
  while IFS= read -r auth_dir; do
    [[ -n "$auth_dir" ]] || continue
    AUTH_DIRS+=("$auth_dir")
  done < <(mullusi_live_collect_auth_dirs_from_csv "$CLI_PROVIDER")
  while IFS= read -r auth_file; do
    [[ -n "$auth_file" ]] || continue
    AUTH_FILES+=("$auth_file")
  done < <(mullusi_live_collect_auth_files_from_csv "$CLI_PROVIDER")
fi
AUTH_DIRS_CSV=""
if ((${#AUTH_DIRS[@]} > 0)); then
  AUTH_DIRS_CSV="$(mullusi_live_join_csv "${AUTH_DIRS[@]}")"
fi
AUTH_FILES_CSV=""
if ((${#AUTH_FILES[@]} > 0)); then
  AUTH_FILES_CSV="$(mullusi_live_join_csv "${AUTH_FILES[@]}")"
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
IFS=',' read -r -a auth_dirs <<<"${MULLUSI_DOCKER_AUTH_DIRS_RESOLVED:-}"
IFS=',' read -r -a auth_files <<<"${MULLUSI_DOCKER_AUTH_FILES_RESOLVED:-}"
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
      cp "/host-auth-files/$auth_file" "$HOME/$auth_file"
      chmod u+rw "$HOME/$auth_file" || true
    fi
  done
fi
provider="${MULLUSI_DOCKER_CLI_BACKEND_PROVIDER:-claude-cli}"
if [ "$provider" = "claude-cli" ]; then
  if [ -z "${MULLUSI_LIVE_CLI_BACKEND_COMMAND:-}" ]; then
    export MULLUSI_LIVE_CLI_BACKEND_COMMAND="$HOME/.npm-global/bin/claude"
  fi
  if [ ! -x "${MULLUSI_LIVE_CLI_BACKEND_COMMAND}" ]; then
    npm_config_prefix="$HOME/.npm-global" npm install -g @anthropic-ai/claude-code
  fi
  real_claude="$HOME/.npm-global/bin/claude-real"
  if [ ! -x "$real_claude" ] && [ -x "$HOME/.npm-global/bin/claude" ]; then
    mv "$HOME/.npm-global/bin/claude" "$real_claude"
  fi
  if [ -x "$real_claude" ]; then
    cat > "$HOME/.npm-global/bin/claude" <<WRAP
#!/usr/bin/env bash
script_dir="\$(CDPATH= cd -- "\$(dirname -- "\$0")" && pwd)"
if [ -n "\${MULLUSI_LIVE_CLI_BACKEND_ANTHROPIC_API_KEY:-}" ]; then
  export ANTHROPIC_API_KEY="\${MULLUSI_LIVE_CLI_BACKEND_ANTHROPIC_API_KEY}"
fi
if [ -n "\${MULLUSI_LIVE_CLI_BACKEND_ANTHROPIC_API_KEY_OLD:-}" ]; then
  export ANTHROPIC_API_KEY_OLD="\${MULLUSI_LIVE_CLI_BACKEND_ANTHROPIC_API_KEY_OLD}"
fi
exec "\$script_dir/claude-real" "\$@"
WRAP
    chmod +x "$HOME/.npm-global/bin/claude"
  fi
  if [ -z "${MULLUSI_LIVE_CLI_BACKEND_PRESERVE_ENV:-}" ]; then
    export MULLUSI_LIVE_CLI_BACKEND_PRESERVE_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'
  fi
  claude auth status || true
fi
tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT
tar -C /src \
  --exclude=.git \
  --exclude=node_modules \
  --exclude=dist \
  --exclude=ui/dist \
  --exclude=ui/node_modules \
  -cf - . | tar -C "$tmp_dir" -xf -
ln -s /app/node_modules "$tmp_dir/node_modules"
ln -s /app/dist "$tmp_dir/dist"
if [ -d /app/dist-runtime/extensions ]; then
  export MULLUSI_BUNDLED_PLUGINS_DIR=/app/dist-runtime/extensions
elif [ -d /app/dist/extensions ]; then
  export MULLUSI_BUNDLED_PLUGINS_DIR=/app/dist/extensions
fi
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
  -e MULLUSI_LIVE_CLI_BACKEND_ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  -e MULLUSI_LIVE_CLI_BACKEND_ANTHROPIC_API_KEY_OLD="${ANTHROPIC_API_KEY_OLD:-}" \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e HOME=/home/node \
  -e NODE_OPTIONS=--disable-warning=ExperimentalWarning \
  -e MULLUSI_SKIP_CHANNELS=1 \
  -e MULLUSI_VITEST_FS_MODULE_CACHE=0 \
  -e MULLUSI_DOCKER_AUTH_DIRS_RESOLVED="$AUTH_DIRS_CSV" \
  -e MULLUSI_DOCKER_AUTH_FILES_RESOLVED="$AUTH_FILES_CSV" \
  -e MULLUSI_DOCKER_CLI_BACKEND_PROVIDER="$CLI_PROVIDER" \
  -e MULLUSI_LIVE_TEST=1 \
  -e MULLUSI_LIVE_CLI_BACKEND=1 \
  -e MULLUSI_LIVE_CLI_BACKEND_MODEL="$CLI_MODEL" \
  -e MULLUSI_LIVE_CLI_BACKEND_COMMAND="${MULLUSI_LIVE_CLI_BACKEND_COMMAND:-}" \
  -e MULLUSI_LIVE_CLI_BACKEND_ARGS="${MULLUSI_LIVE_CLI_BACKEND_ARGS:-}" \
  -e MULLUSI_LIVE_CLI_BACKEND_CLEAR_ENV="${MULLUSI_LIVE_CLI_BACKEND_CLEAR_ENV:-}" \
  -e MULLUSI_LIVE_CLI_BACKEND_PRESERVE_ENV="${MULLUSI_LIVE_CLI_BACKEND_PRESERVE_ENV:-}" \
  -e MULLUSI_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG="$CLI_DISABLE_MCP_CONFIG" \
  -e MULLUSI_LIVE_CLI_BACKEND_RESUME_PROBE="${MULLUSI_LIVE_CLI_BACKEND_RESUME_PROBE:-}" \
  -e MULLUSI_LIVE_CLI_BACKEND_IMAGE_PROBE="${MULLUSI_LIVE_CLI_BACKEND_IMAGE_PROBE:-}" \
  -e MULLUSI_LIVE_CLI_BACKEND_IMAGE_ARG="${MULLUSI_LIVE_CLI_BACKEND_IMAGE_ARG:-}" \
  -e MULLUSI_LIVE_CLI_BACKEND_IMAGE_MODE="${MULLUSI_LIVE_CLI_BACKEND_IMAGE_MODE:-}" \
  -v "$ROOT_DIR":/src:ro \
  -v "$CONFIG_DIR":/home/node/.mullusi \
  -v "$WORKSPACE_DIR":/home/node/.mullusi/workspace \
  -v "$CLI_TOOLS_DIR":/home/node/.npm-global \
  "${EXTERNAL_AUTH_MOUNTS[@]}" \
  "${PROFILE_MOUNT[@]}" \
  "$LIVE_IMAGE_NAME" \
  -lc "$LIVE_TEST_CMD"
