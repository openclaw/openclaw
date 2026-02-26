#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${OPENCLAW_SAFE_ENV_FILE:-$ROOT_DIR/.env.safe}"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/openclaw_security_mode.sh <standard|strict> [--yes]

Modes:
  standard  Practical mode (web + file tools allowed, high-risk runtime still blocked)
  strict    Locked mode (no web, no fs write/edit/apply_patch, minimal session tools)

Options:
  --yes     Skip interactive confirmation prompt
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd docker

MODE="${1:-}"
ASSUME_YES="${2:-}"

if [[ -z "$MODE" ]]; then
  usage
  exit 1
fi

if [[ "$MODE" != "standard" && "$MODE" != "strict" ]]; then
  echo "Invalid mode: $MODE" >&2
  usage
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  echo "Run ./scripts/openclaw_safe_bootstrap.sh first." >&2
  exit 1
fi

print_warning() {
  if [[ "$MODE" == "strict" ]]; then
    cat <<'EOF'
WARNING: you are switching to STRICT security mode.

Changes that will be applied:
- Disable web tools and image tool.
- Disable filesystem tool group (read/write/edit/apply_patch).
- Keep only minimal session + memory tools.
- Keep runtime, browser, node, cron, spawn-style tools blocked.

Possible downsides:
- Lower autonomy and fewer completed tasks.
- More manual operator intervention needed.
- Research and document/file workflows become limited.
EOF
  else
    cat <<'EOF'
WARNING: you are switching to STANDARD security mode.

Changes that will be applied:
- Re-enable web + filesystem tool groups.
- Keep runtime, browser, node, cron, spawn-style tools blocked.

Possible downsides:
- Broader tool surface than strict mode.
- More external-network usage when web tools are used.
EOF
  fi
}

confirm() {
  if [[ "$ASSUME_YES" == "--yes" ]]; then
    return 0
  fi
  print_warning
  echo ""
  read -r -p "Type CONFIRM to apply mode '$MODE': " reply
  if [[ "$reply" != "CONFIRM" ]]; then
    echo "Aborted. No changes applied."
    exit 1
  fi
}

compose_cli() {
  docker compose --env-file "$ENV_FILE" run --rm openclaw-cli "$@"
}

apply_standard() {
  compose_cli config set tools.allow '["group:web","group:fs","group:memory","sessions_list","sessions_history","sessions_send","session_status","image"]' --json
  compose_cli config set tools.deny '["group:runtime","browser","canvas","nodes","cron","gateway","subagents","sessions_spawn"]' --json
  compose_cli config set tools.profile full
}

apply_strict() {
  compose_cli config set tools.allow '["sessions_list","sessions_history","sessions_send","session_status","group:memory"]' --json
  compose_cli config set tools.deny '["group:web","group:fs","group:runtime","image","browser","canvas","nodes","cron","gateway","subagents","sessions_spawn"]' --json
  compose_cli config set tools.profile full
}

confirm

echo "Applying mode: $MODE"
if [[ "$MODE" == "strict" ]]; then
  apply_strict
else
  apply_standard
fi

compose_cli config set gateway.auth.mode token
compose_cli config set gateway.controlUi.enabled true
compose_cli config set gateway.controlUi.basePath /

docker compose --env-file "$ENV_FILE" restart openclaw-gateway

HOST_PORT="$(awk -F= '/^OPENCLAW_GATEWAY_PORT=/{print $2}' "$ENV_FILE" | tail -n1)"
HOST_PORT="${HOST_PORT##*:}"
if [[ -z "$HOST_PORT" ]]; then
  HOST_PORT="18889"
fi

echo ""
echo "Mode applied: $MODE"
echo "Control UI: http://127.0.0.1:${HOST_PORT}"
echo "To verify:"
echo "  docker compose --env-file \"$ENV_FILE\" run --rm openclaw-cli status"
