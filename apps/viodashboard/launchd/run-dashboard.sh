#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_JS="$ROOT/src/config.mjs"
MODE_FILE="$ROOT/launchd/.run-mode"

CFG="$(CONFIG_JS="$CONFIG_JS" /opt/homebrew/bin/node --input-type=module <<'NODE'
const mod = await import(process.env.CONFIG_JS);
console.log(mod.APP_LOG_DIR);
console.log(mod.APP_SUPPORT_RUNTIME_DIR);
console.log(mod.DASHBOARD_APP_ROOT);
console.log(mod.CONFIG_PATH);
console.log(mod.gatewayPort);
NODE
)"
LOG_DIR="$(printf '%s\n' "$CFG" | sed -n '1p')"
RUNTIME_DIR="$(printf '%s\n' "$CFG" | sed -n '2p')"
SOURCE_DIR="$(printf '%s\n' "$CFG" | sed -n '3p')"
CONFIG_PATH="$(printf '%s\n' "$CFG" | sed -n '4p')"
GATEWAY_PORT="$(printf '%s\n' "$CFG" | sed -n '5p')"

RUN_MODE="${VIO_DASHBOARD_RUN_MODE:-}"
if [[ -z "$RUN_MODE" && -f "$MODE_FILE" ]]; then
  RUN_MODE="$(tr -d '[:space:]' < "$MODE_FILE")"
fi
if [[ -z "$RUN_MODE" ]]; then
  RUN_MODE="source"
fi

case "$RUN_MODE" in
  source)
    TARGET_DIR="$SOURCE_DIR"
    ;;
  runtime)
    TARGET_DIR="$RUNTIME_DIR"
    ;;
  *)
    echo "Invalid VioDashboard run mode: $RUN_MODE" >&2
    exit 1
    ;;
esac

mkdir -p "$LOG_DIR"
cd "$TARGET_DIR"
export VIO_DASHBOARD_APP_ROOT="$SOURCE_DIR"
export VIO_WRAPPER_PROJECT_ROOT="$PROJECT_ROOT"
export VIO_OPENCLAW_REPO_ROOT="$OPENCLAW_REPO_ROOT"
export VIO_WRAPPER_CONFIG_PATH="$CONFIG_PATH"
export VIO_WRAPPER_GATEWAY_PORT="$GATEWAY_PORT"
exec /opt/homebrew/bin/node src/server.mjs >> "$LOG_DIR/wrapper.out.log" 2>> "$LOG_DIR/wrapper.err.log"
port VIO_WRAPPER_CONFIG_PATH="$CONFIG_PATH"
export VIO_WRAPPER_GATEWAY_PORT="$GATEWAY_PORT"
exec /opt/homebrew/bin/node src/server.mjs >> "$LOG_DIR/wrapper.out.log" 2>> "$LOG_DIR/wrapper.err.log"
