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
ACP_AGENT="${OPENCLAW_LIVE_ACP_BIND_AGENT:-claude}"

case "$ACP_AGENT" in
  claude)
    AUTH_PROVIDER="claude-cli"
    CLI_PACKAGE="@anthropic-ai/claude-code"
    CLI_BIN="claude"
    ;;
  codex)
    AUTH_PROVIDER="codex-cli"
    CLI_PACKAGE="@openai/codex"
    CLI_BIN="codex"
    ;;
  *)
    echo "Unsupported OPENCLAW_LIVE_ACP_BIND_AGENT: $ACP_AGENT (expected claude or codex)" >&2
    exit 1
    ;;
esac

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
  done < <(openclaw_live_collect_auth_dirs_from_csv "$AUTH_PROVIDER")
  while IFS= read -r auth_file; do
    [[ -n "$auth_file" ]] || continue
    AUTH_FILES+=("$auth_file")
  done < <(openclaw_live_collect_auth_files_from_csv "$AUTH_PROVIDER")
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
      cp "/host-auth-files/$auth_file" "$HOME/$auth_file"
      chmod u+rw "$HOME/$auth_file" || true
    fi
  done
fi
agent="${OPENCLAW_LIVE_ACP_BIND_AGENT:-claude}"
case "$agent" in
  claude)
    if [ ! -x "$HOME/.npm-global/bin/claude" ]; then
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
if [ -n "\${OPENCLAW_LIVE_ACP_BIND_ANTHROPIC_API_KEY:-}" ]; then
  export ANTHROPIC_API_KEY="\${OPENCLAW_LIVE_ACP_BIND_ANTHROPIC_API_KEY}"
fi
if [ -n "\${OPENCLAW_LIVE_ACP_BIND_ANTHROPIC_API_KEY_OLD:-}" ]; then
  export ANTHROPIC_API_KEY_OLD="\${OPENCLAW_LIVE_ACP_BIND_ANTHROPIC_API_KEY_OLD}"
fi
exec "\$script_dir/claude-real" "\$@"
WRAP
      chmod +x "$HOME/.npm-global/bin/claude"
    fi
    claude auth status || true
    ;;
  codex)
    if [ ! -x "$HOME/.npm-global/bin/codex" ]; then
      npm_config_prefix="$HOME/.npm-global" npm install -g @openai/codex
    fi
    ;;
  *)
    echo "Unsupported OPENCLAW_LIVE_ACP_BIND_AGENT: $agent" >&2
    exit 1
    ;;
esac
tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT
source /app/scripts/lib/live-docker-stage.sh
openclaw_live_stage_source_tree "$tmp_dir"
openclaw_live_link_runtime_tree "$tmp_dir"
cd "$tmp_dir"
export OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND="${OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND:-}"
pnpm test:live src/gateway/gateway-acp-bind.live.test.ts
EOF

echo "==> Build live-test image: $LIVE_IMAGE_NAME (target=build)"
docker build --target build -t "$LIVE_IMAGE_NAME" -f "$ROOT_DIR/Dockerfile" "$ROOT_DIR"

echo "==> Run ACP bind live test in Docker"
echo "==> Agent: $ACP_AGENT"
echo "==> Auth dirs: ${AUTH_DIRS_CSV:-none}"
echo "==> Auth files: ${AUTH_FILES_CSV:-none}"
docker run --rm -t \
  -u node \
  --entrypoint bash \
  -e ANTHROPIC_API_KEY \
  -e ANTHROPIC_API_KEY_OLD \
  -e OPENCLAW_LIVE_ACP_BIND_ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  -e OPENCLAW_LIVE_ACP_BIND_ANTHROPIC_API_KEY_OLD="${ANTHROPIC_API_KEY_OLD:-}" \
  -e OPENAI_API_KEY \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e HOME=/home/node \
  -e NODE_OPTIONS=--disable-warning=ExperimentalWarning \
  -e OPENCLAW_SKIP_CHANNELS=1 \
  -e OPENCLAW_VITEST_FS_MODULE_CACHE=0 \
  -e OPENCLAW_DOCKER_AUTH_DIRS_RESOLVED="$AUTH_DIRS_CSV" \
  -e OPENCLAW_DOCKER_AUTH_FILES_RESOLVED="$AUTH_FILES_CSV" \
  -e OPENCLAW_LIVE_TEST=1 \
  -e OPENCLAW_LIVE_ACP_BIND=1 \
  -e OPENCLAW_LIVE_ACP_BIND_AGENT="$ACP_AGENT" \
  -e OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND="${OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND:-}" \
  -v "$ROOT_DIR":/src:ro \
  -v "$CONFIG_DIR":/home/node/.openclaw \
  -v "$WORKSPACE_DIR":/home/node/.openclaw/workspace \
  -v "$CLI_TOOLS_DIR":/home/node/.npm-global \
  "${EXTERNAL_AUTH_MOUNTS[@]}" \
  "${PROFILE_MOUNT[@]}" \
  "$LIVE_IMAGE_NAME" \
  -lc "$LIVE_TEST_CMD"
