#!/usr/bin/env bash
set -euo pipefail

# This helper exists because the "user" browser lane depends on two different
# processes sharing the same explicit Chrome CDP target:
# 1) the benchmark gateway on port 19011
# 2) the local agent process we launch for the visible browser task
#
# We also want a hard reset path for the dedicated debug Chrome profile so we
# can remove sticky Google Flights state without touching the user's normal
# daily browser profile.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BENCH_HOME="${OPENCLAW_HOME:-/tmp/openclaw-consumer-bench}"
BENCH_PROFILE="${OPENCLAW_PROFILE:-consumer-test}"
DEBUG_CHROME_DIR="${OPENCLAW_DEBUG_CHROME_DIR:-/tmp/openclaw-chrome-debug}"
DEBUG_CHROME_URL="${OPENCLAW_CHROME_MCP_BROWSER_URL:-http://127.0.0.1:9333}"
DEBUG_CHROME_PORT="${DEBUG_CHROME_URL##*:}"
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-19011}"
GATEWAY_LOG="${OPENCLAW_GATEWAY_LOG:-/tmp/oc-bench-19011.log}"
GATEWAY_PID_FILE="${OPENCLAW_GATEWAY_PID_FILE:-/tmp/oc-bench-19011.pid}"

usage() {
  cat <<'EOF'
Usage:
  scripts/repro/consumer-user-google-flights-reset.sh reset
  scripts/repro/consumer-user-google-flights-reset.sh run-user
  scripts/repro/consumer-user-google-flights-reset.sh run-openclaw

Commands:
  reset
    Fully reset the dedicated debug Chrome profile on port 9333 and restart the
    benchmark gateway on port 19011 with the explicit Chrome attach URL baked in.

  run-user
    Run the visible Google Flights benchmark on the "user" browser lane in the
    foreground. Assumes `reset` has already been run successfully.

  run-openclaw
    Run the same visible Google Flights benchmark on the managed "openclaw"
    browser lane in the foreground.
EOF
}

require_token() {
  python3 - <<'PY'
import json
print(json.load(open('/tmp/openclaw-consumer-bench/.openclaw/openclaw.json'))['gateway']['auth']['token'])
PY
}

wait_for_gateway() {
  local attempts="${1:-20}"
  local sleep_s="${2:-1}"
  local token

  for ((i=1; i<=attempts; i++)); do
    if ! token="$(require_token 2>/dev/null)"; then
      sleep "$sleep_s"
      continue
    fi

    if node dist/entry.js browser \
      --url "ws://127.0.0.1:${GATEWAY_PORT}" \
      --token "$token" \
      --browser-profile user \
      status >/dev/null 2>&1; then
      return 0
    fi

    sleep "$sleep_s"
  done

  return 1
}

reset_lane() {
  cd "$ROOT_DIR"

  # Kill only the dedicated debug Chrome instance we own on port 9333, then
  # wipe its throwaway profile directory. This leaves the user's normal Chrome
  # profile alone while removing sticky Google Flights/session state.
  pkill -f "Google Chrome.*remote-debugging-port=${DEBUG_CHROME_PORT}" || true
  sleep 1

  # Chrome can leave helper processes attached briefly after the parent exits.
  # If anything still holds the dedicated debug profile, kill those processes
  # too so the wipe is deterministic instead of failing half way through.
  if [ -d "$DEBUG_CHROME_DIR" ]; then
    mapfile -t debug_pids < <(lsof -t +D "$DEBUG_CHROME_DIR" 2>/dev/null | awk '!seen[$0]++')
    if [ "${#debug_pids[@]}" -gt 0 ]; then
      kill "${debug_pids[@]}" 2>/dev/null || true
      sleep 1
      kill -9 "${debug_pids[@]}" 2>/dev/null || true
    fi
  fi

  rm -rf "$DEBUG_CHROME_DIR"
  mkdir -p "$DEBUG_CHROME_DIR"

  # Relaunch a clean Chrome dedicated to CDP automation. We keep it separate
  # from the user's daily browser so resets are safe and deterministic.
  open -na "Google Chrome" --args \
    --remote-debugging-port="${DEBUG_CHROME_PORT}" \
    --user-data-dir="$DEBUG_CHROME_DIR" \
    --no-first-run \
    --no-default-browser-check

  sleep 3
  curl -fsS "${DEBUG_CHROME_URL}/json/version" >/dev/null

  # Restart the benchmark gateway so the gateway process itself inherits the
  # explicit attach target. Setting the env var only on client commands is not
  # enough; both gateway and local agent need to agree on the same CDP URL.
  pkill -f "dist/entry.js gateway run --bind loopback --port ${GATEWAY_PORT}" || true
  export OPENCLAW_HOME="$BENCH_HOME"
  export OPENCLAW_PROFILE="$BENCH_PROFILE"
  export OPENCLAW_CHROME_MCP_BROWSER_URL="$DEBUG_CHROME_URL"

  nohup node dist/entry.js gateway run --bind loopback --port "$GATEWAY_PORT" --force \
    >"$GATEWAY_LOG" 2>&1 &
  echo $! >"$GATEWAY_PID_FILE"
  if ! wait_for_gateway 25 1; then
    echo "Gateway did not become ready after reset." >&2
    echo "Gateway log: $GATEWAY_LOG" >&2
    tail -n 120 "$GATEWAY_LOG" >&2 || true
    exit 1
  fi

  TOKEN="$(require_token)"
  node dist/entry.js browser \
    --url "ws://127.0.0.1:${GATEWAY_PORT}" \
    --token "$TOKEN" \
    --browser-profile user \
    status

  echo
  echo "Reset complete."
  echo "Chrome CDP: ${DEBUG_CHROME_URL}"
  echo "Gateway log: ${GATEWAY_LOG}"
}

run_user() {
  cd "$ROOT_DIR"
  export OPENCLAW_HOME="$BENCH_HOME"
  export OPENCLAW_PROFILE="$BENCH_PROFILE"
  export OPENCLAW_CHROME_MCP_BROWSER_URL="$DEBUG_CHROME_URL"

  node dist/entry.js agent --local --agent main --json --timeout 180 \
    --message 'Use only the browser tool with profile="user". Open Google Flights, search NYC to London in April, compare the top 3 options by total price and duration, and reply with RESULT: PASS plus a concise summary, or RESULT: FAIL plus the concrete blocker.'
}

run_openclaw() {
  cd "$ROOT_DIR"
  export OPENCLAW_HOME="$BENCH_HOME"
  export OPENCLAW_PROFILE="$BENCH_PROFILE"

  node dist/entry.js agent --local --agent main --json --timeout 180 \
    --message 'Use only the browser tool with profile="openclaw". Open Google Flights, search NYC to London in April, compare the top 3 options by total price and duration, and reply with RESULT: PASS plus a concise summary, or RESULT: FAIL plus the concrete blocker.'
}

cmd="${1:-}"
case "$cmd" in
  reset)
    reset_lane
    ;;
  run-user)
    run_user
    ;;
  run-openclaw)
    run_openclaw
    ;;
  *)
    usage
    exit 1
    ;;
esac
