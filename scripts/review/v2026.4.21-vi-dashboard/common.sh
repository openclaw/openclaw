#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"

REVIEW_ID="v2026.4.21-vi-dashboard"
REVIEW_BRANCH="review/v2026.4.21-vi-dashboard"
REVIEW_PROFILE="review-v2026-4-21-vi-dashboard"
REVIEW_PORT="19821"
REVIEW_HOST="127.0.0.1"
REVIEW_BASE_URL="http://${REVIEW_HOST}:${REVIEW_PORT}/"
REVIEW_SYSTEMD_UNIT_NAME="openclaw-gateway-review-v2026-4-21"
REVIEW_SYSTEMD_UNIT="${REVIEW_SYSTEMD_UNIT_NAME}.service"

REVIEW_STATE_DIR="${OPENCLAW_REVIEW_STATE_DIR:-$HOME/.openclaw-${REVIEW_PROFILE}}"
REVIEW_CONFIG_PATH="${OPENCLAW_REVIEW_CONFIG_PATH:-$REVIEW_STATE_DIR/openclaw.json}"
REVIEW_WORKSPACE_DIR="${OPENCLAW_REVIEW_WORKSPACE_DIR:-$REVIEW_STATE_DIR/workspace}"
REVIEW_LOG_DIR="${OPENCLAW_REVIEW_LOG_DIR:-$REVIEW_STATE_DIR/logs}"
REVIEW_RUN_LOG="${OPENCLAW_REVIEW_RUN_LOG:-$REVIEW_LOG_DIR/review-gateway.log}"
REVIEW_PID_FILE="${OPENCLAW_REVIEW_PID_FILE:-$REVIEW_STATE_DIR/review-gateway.pid}"
REVIEW_TOKEN_FILE="${OPENCLAW_REVIEW_TOKEN_FILE:-$REVIEW_STATE_DIR/review-gateway.token}"

SOURCE_STATE_DIR="${OPENCLAW_SOURCE_STATE_DIR:-$HOME/.openclaw}"
SOURCE_CONFIG_PATH="${OPENCLAW_SOURCE_CONFIG_PATH:-$SOURCE_STATE_DIR/openclaw.json}"

review_require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

review_ensure_layout() {
  mkdir -p "$REVIEW_STATE_DIR" "$REVIEW_WORKSPACE_DIR" "$REVIEW_LOG_DIR"
}

review_generate_token() {
  review_ensure_layout
  if [[ ! -s "$REVIEW_TOKEN_FILE" ]]; then
    if command -v openssl >/dev/null 2>&1; then
      openssl rand -hex 32 >"$REVIEW_TOKEN_FILE"
    else
      od -An -N32 -tx1 /dev/urandom | tr -d ' \n' >"$REVIEW_TOKEN_FILE"
    fi
    chmod 600 "$REVIEW_TOKEN_FILE"
  fi
  REVIEW_GATEWAY_TOKEN="$(tr -d '\r\n' <"$REVIEW_TOKEN_FILE")"
  if [[ -z "${REVIEW_GATEWAY_TOKEN}" ]]; then
    echo "Review gateway token is empty: $REVIEW_TOKEN_FILE" >&2
    exit 1
  fi
}

review_export_env() {
  review_generate_token
  export OPENCLAW_PROFILE="$REVIEW_PROFILE"
  export OPENCLAW_STATE_DIR="$REVIEW_STATE_DIR"
  export OPENCLAW_CONFIG_PATH="$REVIEW_CONFIG_PATH"
  export OPENCLAW_GATEWAY_TOKEN="$REVIEW_GATEWAY_TOKEN"
  export OPENCLAW_SKIP_CHANNELS="1"
  export OPENCLAW_SKIP_CRON="1"
}

review_ensure_cli_dist() {
  if [[ -f "$REPO_ROOT/dist/entry.js" || -f "$REPO_ROOT/dist/entry.mjs" ]]; then
    return 0
  fi
  echo "CLI dist missing; building runtime..."
  (
    cd "$REPO_ROOT"
    pnpm build
  )
}

review_repo_cmd() {
  (
    cd "$REPO_ROOT"
    review_export_env
    node openclaw.mjs "$@"
  )
}

review_ensure_control_ui_dist() {
  review_ensure_cli_dist
  if [[ -f "$REPO_ROOT/dist/control-ui/index.html" ]]; then
    return 0
  fi
  echo "Control UI dist missing; building UI assets..."
  (
    cd "$REPO_ROOT"
    pnpm ui:build
  )
}

review_read_pid() {
  if [[ -f "$REVIEW_PID_FILE" ]]; then
    tr -d '[:space:]' <"$REVIEW_PID_FILE"
  fi
}

review_pid_alive() {
  local pid="${1:-}"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

review_port_listening() {
  ss -ltn "( sport = :${REVIEW_PORT} )" 2>/dev/null | tail -n +2 | grep -q .
}

review_port_owner() {
  ss -ltnp "( sport = :${REVIEW_PORT} )" 2>/dev/null | sed -n '2p'
}

review_gateway_connect_ok() {
  review_repo_cmd gateway status --json | jq -e '.rpc.ok == true' >/dev/null 2>&1
}

review_wait_for_ready() {
  local pid="${1:-}"
  local attempt
  for attempt in $(seq 1 60); do
    if review_gateway_connect_ok; then
      return 0
    fi
    if [[ -n "$pid" ]]; then
      if ! review_pid_alive "$pid"; then
        return 1
      fi
    fi
    if command -v systemctl >/dev/null 2>&1 && ! review_systemd_active; then
      return 1
    fi
    sleep 1
  done
  return 1
}

review_systemd_active() {
  systemctl --user is-active --quiet "$REVIEW_SYSTEMD_UNIT"
}

review_systemd_failed() {
  systemctl --user is-failed --quiet "$REVIEW_SYSTEMD_UNIT"
}

review_systemd_main_pid() {
  systemctl --user show --property=MainPID --value "$REVIEW_SYSTEMD_UNIT" 2>/dev/null | tr -d '[:space:]'
}

review_print_summary() {
  cat <<EOF
review_id=${REVIEW_ID}
review_branch=${REVIEW_BRANCH}
repo_root=${REPO_ROOT}
base_url=${REVIEW_BASE_URL}
port=${REVIEW_PORT}
state_dir=${REVIEW_STATE_DIR}
config_path=${REVIEW_CONFIG_PATH}
workspace_dir=${REVIEW_WORKSPACE_DIR}
log_path=${REVIEW_RUN_LOG}
pid_file=${REVIEW_PID_FILE}
token_file=${REVIEW_TOKEN_FILE}
source_config=${SOURCE_CONFIG_PATH}
systemd_unit=${REVIEW_SYSTEMD_UNIT}
EOF
}
