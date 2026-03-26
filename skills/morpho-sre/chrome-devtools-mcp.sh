#!/usr/bin/env bash
set -euo pipefail

# Wrapper that ensures headless Chromium is running with CDP, then runs
# the chrome-devtools-mcp MCP server connected to it.
#
# Chromium runs inside the same container (no sidecar). All filesystem
# writes go to /tmp (compatible with readOnlyRootFilesystem).

CDP_PORT="${CDP_PORT:-9222}"
[[ "$CDP_PORT" =~ ^[0-9]+$ ]] || { printf 'chrome-devtools-mcp-wrapper: CDP_PORT must be numeric: %s\n' "$CDP_PORT" >&2; exit 1; }

CHROME_DATA_DIR="/tmp/chrome-devtools-data"
CHROME_PID_FILE="/tmp/chrome-devtools.pid"
CHROME_LOG="/tmp/chrome-devtools-chromium.log"

# Redirect Chromium's XDG/HOME writes to /tmp (read-only rootfs compat).
export HOME="/tmp/chrome-home"
export XDG_CONFIG_HOME="/tmp/chrome-home/.config"
export XDG_CACHE_HOME="/tmp/chrome-home/.cache"
export XDG_DATA_HOME="/tmp/chrome-home/.local/share"

die() {
  printf 'chrome-devtools-mcp-wrapper: %s\n' "$*" >&2
  exit 1
}

# Reap stale Chrome from a previous invocation that crashed.
reap_stale_chrome() {
  if [[ -f "$CHROME_PID_FILE" ]]; then
    local old_pid
    old_pid="$(cat "$CHROME_PID_FILE" 2>/dev/null || true)"
    if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
      kill "$old_pid" 2>/dev/null || true
      # Wait for process to exit; escalate to SIGKILL if SIGTERM is ignored.
      local w; for w in 1 2 3 4 5; do
        kill -0 "$old_pid" 2>/dev/null || break
        sleep 0.5
      done
      if kill -0 "$old_pid" 2>/dev/null; then
        kill -9 "$old_pid" 2>/dev/null || true
      fi
    fi
    rm -f "$CHROME_PID_FILE"
  fi
}

start_chrome() {
  mkdir -p "$CHROME_DATA_DIR" "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"

  command -v chromium >/dev/null 2>&1 || die 'chromium binary not found in PATH'

  reap_stale_chrome

  # Chromium sandbox disabled: container is hardened with non-root user,
  # no capabilities, no privilege escalation, read-only rootfs, and seccomp
  # RuntimeDefault. Container boundary provides isolation.
  # See scripts/k8s/manifests/deployment.yaml pod securityContext for details.
  chromium \
    --headless=new \
    --no-sandbox \
    --disable-gpu \
    --disable-dev-shm-usage \
    --disable-software-rasterizer \
    --disable-extensions \
    --disable-crash-reporter \
    --renderer-process-limit=4 \
    --user-data-dir="$CHROME_DATA_DIR" \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port="$CDP_PORT" \
    > "$CHROME_LOG" 2>&1 &
  local chrome_pid=$!

  # Store PID so future invocations can reap stale Chrome.
  printf '%s\n' "$chrome_pid" > "$CHROME_PID_FILE"

  # Wait for CDP to be ready (up to 15s). Check Chrome is still alive each iteration.
  local i
  for i in $(seq 1 30); do
    if ! kill -0 "$chrome_pid" 2>/dev/null; then
      rm -f "$CHROME_PID_FILE"
      die "Chromium process exited during startup (see $CHROME_LOG)"
    fi
    if curl -sSf --max-time 1 "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done

  # Kill orphaned Chrome on timeout to prevent resource leak and port blocking.
  kill "$chrome_pid" 2>/dev/null || true
  rm -f "$CHROME_PID_FILE"
  die "Chromium did not start within 15s (see $CHROME_LOG)"
}

# Clean up Chrome when MCP server exits (runs via trap instead of exec
# so the background Chrome doesn't become an orphan).
cleanup() {
  if [[ -f "$CHROME_PID_FILE" ]]; then
    local pid
    pid="$(cat "$CHROME_PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      # Wait briefly; escalate to SIGKILL if SIGTERM is ignored.
      local w; for w in 1 2 3 4 5; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
      done
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    fi
    rm -f "$CHROME_PID_FILE"
  fi
}
trap cleanup EXIT

# Start Chrome if not already running on CDP_PORT.
if ! curl -sSf --max-time 1 "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
  start_chrome
fi

chrome-devtools-mcp --browserUrl "http://127.0.0.1:${CDP_PORT}" "$@"
