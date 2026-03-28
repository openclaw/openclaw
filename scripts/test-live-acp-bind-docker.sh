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
# Keep in sync with extensions/acpx/src/config.ts ACPX_PINNED_VERSION.
ACPX_VERSION="${OPENCLAW_DOCKER_ACPX_VERSION:-0.3.1}"

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
if [[ -n "${OPENCLAW_DOCKER_AUTH_DIRS:-}" ]]; then
  while IFS= read -r auth_dir; do
    [[ -n "$auth_dir" ]] || continue
    AUTH_DIRS+=("$auth_dir")
  done < <(openclaw_live_collect_auth_dirs)
else
  while IFS= read -r auth_dir; do
    [[ -n "$auth_dir" ]] || continue
    AUTH_DIRS+=("$auth_dir")
  done < <(openclaw_live_collect_auth_dirs_from_csv "$AUTH_PROVIDER")
fi
AUTH_DIRS_CSV="$(openclaw_live_join_csv "${AUTH_DIRS[@]}")"

EXTERNAL_AUTH_MOUNTS=()
for auth_dir in "${AUTH_DIRS[@]}"; do
  host_path="$HOME/$auth_dir"
  if [[ -d "$host_path" ]]; then
    EXTERNAL_AUTH_MOUNTS+=(-v "$host_path":/home/node/"$auth_dir":ro)
  fi
done

read -r -d '' LIVE_TEST_CMD <<'EOF' || true
set -euo pipefail
[ -f "$HOME/.profile" ] && source "$HOME/.profile" || true
export PATH="$HOME/.npm-global/bin:$PATH"
if [ ! -x "$HOME/.npm-global/bin/acpx" ]; then
  npm_config_prefix="$HOME/.npm-global" npm install -g "acpx@${OPENCLAW_DOCKER_ACPX_VERSION:-0.3.1}"
fi
agent="${OPENCLAW_LIVE_ACP_BIND_AGENT:-claude}"
case "$agent" in
  claude)
    if [ ! -x "$HOME/.npm-global/bin/claude" ]; then
      npm_config_prefix="$HOME/.npm-global" npm install -g @anthropic-ai/claude-code
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
  export OPENCLAW_BUNDLED_PLUGINS_DIR=/app/dist-runtime/extensions
elif [ -d /app/dist/extensions ]; then
  export OPENCLAW_BUNDLED_PLUGINS_DIR=/app/dist/extensions
fi
cd "$tmp_dir"
export OPENCLAW_LIVE_ACP_BIND_ACPX_COMMAND="$HOME/.npm-global/bin/acpx"
pnpm test:live src/gateway/gateway-acp-bind.live.test.ts
EOF

echo "==> Build live-test image: $LIVE_IMAGE_NAME (target=build)"
docker build --target build -t "$LIVE_IMAGE_NAME" -f "$ROOT_DIR/Dockerfile" "$ROOT_DIR"

echo "==> Run ACP bind live test in Docker"
echo "==> Agent: $ACP_AGENT"
echo "==> Auth dirs: ${AUTH_DIRS_CSV:-none}"
docker run --rm -t \
  -u node \
  --entrypoint bash \
  -e ANTHROPIC_API_KEY \
  -e ANTHROPIC_API_KEY_OLD \
  -e OPENAI_API_KEY \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e HOME=/home/node \
  -e NODE_OPTIONS=--disable-warning=ExperimentalWarning \
  -e OPENCLAW_SKIP_CHANNELS=1 \
  -e OPENCLAW_VITEST_FS_MODULE_CACHE=0 \
  -e OPENCLAW_DOCKER_ACPX_VERSION="$ACPX_VERSION" \
  -e OPENCLAW_LIVE_TEST=1 \
  -e OPENCLAW_LIVE_ACP_BIND=1 \
  -e OPENCLAW_LIVE_ACP_BIND_AGENT="$ACP_AGENT" \
  -e OPENCLAW_LIVE_ACP_BIND_ACPX_COMMAND="${OPENCLAW_LIVE_ACP_BIND_ACPX_COMMAND:-}" \
  -v "$ROOT_DIR":/src:ro \
  -v "$CONFIG_DIR":/home/node/.openclaw \
  -v "$WORKSPACE_DIR":/home/node/.openclaw/workspace \
  -v "$CLI_TOOLS_DIR":/home/node/.npm-global \
  "${EXTERNAL_AUTH_MOUNTS[@]}" \
  "${PROFILE_MOUNT[@]}" \
  "$LIVE_IMAGE_NAME" \
  -lc "$LIVE_TEST_CMD"
