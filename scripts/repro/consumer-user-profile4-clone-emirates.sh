#!/usr/bin/env bash
set -euo pipefail

# This helper exists because Chrome refuses remote debugging on the user's
# normal data dir. The workaround is to clone the real profile into a throwaway
# user-data-dir that still carries the user's cookies/session state.
#
# We keep this separate from the clean debug-profile helper because these are
# two different experiments:
# 1) clean Chrome automation reliability
# 2) "real-ish" Chrome state via a cloned daily profile

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BENCH_HOME="${OPENCLAW_HOME:-/tmp/openclaw-consumer-bench}"
BENCH_PROFILE="${OPENCLAW_PROFILE:-consumer-test}"
SOURCE_CHROME_DIR="${OPENCLAW_SOURCE_CHROME_DIR:-$HOME/Library/Application Support/Google/Chrome}"
SOURCE_PROFILE_NAME="${OPENCLAW_SOURCE_PROFILE_NAME:-Profile 4}"
CLONE_CHROME_DIR="${OPENCLAW_CLONE_CHROME_DIR:-/tmp/openclaw-chrome-profile4-clone}"
DEBUG_CHROME_URL="${OPENCLAW_CHROME_MCP_BROWSER_URL:-http://127.0.0.1:9333}"
DEBUG_CHROME_PORT="${DEBUG_CHROME_URL##*:}"
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-19011}"
GATEWAY_LOG="${OPENCLAW_GATEWAY_LOG:-/tmp/oc-bench-19011.log}"
GATEWAY_PID_FILE="${OPENCLAW_GATEWAY_PID_FILE:-/tmp/oc-bench-19011.pid}"
CHROME_BIN="${OPENCLAW_CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

usage() {
  cat <<'EOF'
Usage:
  scripts/repro/consumer-user-profile4-clone-emirates.sh prepare
  scripts/repro/consumer-user-profile4-clone-emirates.sh prepare-run
  scripts/repro/consumer-user-profile4-clone-emirates.sh run

Commands:
  prepare
    Clone the user's real Chrome profile into a throwaway user-data-dir,
    launch Chrome with remote debugging, restart the consumer benchmark gateway,
    and verify the user browser lane can open emirates.com.

  prepare-run
    Do the full clone-profile prep and immediately launch the Emirates
    benchmark so the CDP lane cannot decay between steps.

  run
    Run the watched Emirates benchmark against the cloned profile lane.
EOF
}

require_token() {
  python3 - <<'PY'
import json
print(json.load(open('/tmp/openclaw-consumer-bench/.openclaw/openclaw.json'))['gateway']['auth']['token'])
PY
}

wait_for_cdp() {
  local attempts="${1:-20}"
  local sleep_s="${2:-1}"
  for ((i=1; i<=attempts; i++)); do
    if curl -fsS "${DEBUG_CHROME_URL}/json/version" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$sleep_s"
  done
  return 1
}

wait_for_gateway() {
  local attempts="${1:-25}"
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

prepare_clone() {
  cd "$ROOT_DIR"

  # We only clone the top-level Local State plus the specific profile folder.
  # That is the minimum Chrome metadata needed to preserve the user's session
  # state without copying the entire home Chrome tree.
  pkill -f "Google Chrome.*remote-debugging-port=${DEBUG_CHROME_PORT}" || true
  sleep 1

  # If the prior clone-backed instance left helpers behind, kill only the
  # processes still touching the clone dir. We explicitly avoid killing the
  # user's normal Chrome here; this lane should live alongside it.
  if [ -d "$CLONE_CHROME_DIR" ]; then
    mapfile -t clone_pids < <(lsof -t +D "$CLONE_CHROME_DIR" 2>/dev/null | awk '!seen[$0]++')
    if [ "${#clone_pids[@]}" -gt 0 ]; then
      kill "${clone_pids[@]}" 2>/dev/null || true
      sleep 1
      kill -9 "${clone_pids[@]}" 2>/dev/null || true
    fi
  fi

  rm -rf "$CLONE_CHROME_DIR"
  mkdir -p "$CLONE_CHROME_DIR"
  cp "${SOURCE_CHROME_DIR}/Local State" "${CLONE_CHROME_DIR}/Local State"
  rsync -a --delete \
    "${SOURCE_CHROME_DIR}/${SOURCE_PROFILE_NAME}/" \
    "${CLONE_CHROME_DIR}/${SOURCE_PROFILE_NAME}/"

  # Chrome requires a non-default user-data-dir for remote debugging on macOS.
  # We point it at the clone and keep the original profile name inside that dir.
  open -na "Google Chrome" --args \
    --remote-debugging-port="${DEBUG_CHROME_PORT}" \
    --user-data-dir="${CLONE_CHROME_DIR}" \
    --profile-directory="${SOURCE_PROFILE_NAME}" \
    --restore-last-session \
    --no-first-run \
    --no-default-browser-check \
    >/tmp/openclaw-profile4-clone-chrome.log 2>&1 &

  if ! wait_for_cdp 20 1; then
    echo "Chrome CDP never came up at ${DEBUG_CHROME_URL}" >&2
    tail -n 80 /tmp/openclaw-profile4-clone-chrome.log >&2 || true
    exit 1
  fi

  export OPENCLAW_HOME="$BENCH_HOME"
  export OPENCLAW_PROFILE="$BENCH_PROFILE"
  export OPENCLAW_CHROME_MCP_BROWSER_URL="$DEBUG_CHROME_URL"

  pkill -f "dist/entry.js gateway run --bind loopback --port ${GATEWAY_PORT}" || true
  nohup node dist/entry.js gateway run --bind loopback --port "$GATEWAY_PORT" --force \
    >"$GATEWAY_LOG" 2>&1 &
  echo $! >"$GATEWAY_PID_FILE"

  if ! wait_for_gateway 25 1; then
    echo "Gateway did not become ready after clone-profile prep." >&2
    tail -n 120 "$GATEWAY_LOG" >&2 || true
    exit 1
  fi

  local token
  token="$(require_token)"

  # This direct open is the proof gate. If it fails, the lane is not ready and
  # we should not waste the user's time with the full agent benchmark.
  node dist/entry.js browser \
    --url "ws://127.0.0.1:${GATEWAY_PORT}" \
    --token "$token" \
    --browser-profile user \
    open https://www.emirates.com/ >/tmp/openclaw-profile4-clone-open.txt

  echo "Clone-profile lane ready."
  echo "CDP: ${DEBUG_CHROME_URL}"
  echo "Gateway log: ${GATEWAY_LOG}"
  echo "Open proof:"
  cat /tmp/openclaw-profile4-clone-open.txt
}

run_task() {
  cd "$ROOT_DIR"
  export OPENCLAW_HOME="$BENCH_HOME"
  export OPENCLAW_PROFILE="$BENCH_PROFILE"
  export OPENCLAW_CHROME_MCP_BROWSER_URL="$DEBUG_CHROME_URL"

  if ! curl -fsS "${DEBUG_CHROME_URL}/json/version" >/dev/null 2>&1; then
    echo "Clone-profile CDP is not reachable at ${DEBUG_CHROME_URL}. Run 'prepare' first." >&2
    exit 1
  fi

  node dist/entry.js agent --local --agent main --json --timeout 300 \
    --message 'Use only browser profile="user". Open emirates.com. Search one-way flights from Denpasar (DPS) to Dubai (DXB) for March 22, 2026. Take a snapshot or screenshot before each major action. Stop as soon as visible flight options load. Return RESULT: PASS with the visible options and any obvious constraints, or RESULT: FAIL with the exact blocker. Do not purchase anything.'
}

cmd="${1:-}"
case "$cmd" in
  prepare)
    prepare_clone
    ;;
  prepare-run)
    prepare_clone
    run_task
    ;;
  run)
    run_task
    ;;
  *)
    usage
    exit 1
    ;;
esac
