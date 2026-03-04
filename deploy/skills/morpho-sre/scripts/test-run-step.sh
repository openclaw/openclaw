#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/sentinel-triage.sh"

extract_function() {
  local fn="$1"
  sed -n "/^${fn}()[[:space:]]*{/,/^}/p" "$SCRIPT_PATH"
}

# Portable timeout shim for macOS/Bash3 test environments.
TMP_BIN_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_BIN_DIR"' EXIT
cat > "${TMP_BIN_DIR}/timeout" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
duration="$1"
shift
seconds="${duration%s}"
"$@" &
cmd_pid=$!
(
  sleep "$seconds"
  kill -TERM "$cmd_pid" 2>/dev/null || true
) &
watchdog_pid=$!
set +e
wait "$cmd_pid"
rc=$?
set -e
kill "$watchdog_pid" 2>/dev/null || true
wait "$watchdog_pid" 2>/dev/null || true
if [[ "$rc" -eq 143 || "$rc" -eq 142 || "$rc" -eq 137 ]]; then
  exit 124
fi
exit "$rc"
EOS
chmod +x "${TMP_BIN_DIR}/timeout"
PATH="${TMP_BIN_DIR}:$PATH"

log() {
  :
}

HAS_TIMEOUT=1
TIMEOUT_IMPL=timeout

eval "$(extract_function now_ms)"
eval "$(extract_function parse_timeout_seconds)"
eval "$(extract_function run_with_timeout)"
eval "$(extract_function run_step)"

fail() {
  echo "FAIL: $*"
  exit 1
}

run_step 1 "fast_step" 5 no 'echo hello'
[[ "${STEP_STATUS_1:-}" == "ok" ]] || fail "expected STEP_STATUS_1=ok, got '${STEP_STATUS_1:-}'"
[[ "${STEP_OUTPUT_1:-}" == "hello" ]] || fail "expected STEP_OUTPUT_1='hello', got '${STEP_OUTPUT_1:-}'"
latency_1="${STEP_LATENCY_1:-}"
[[ "$latency_1" =~ ^[0-9]+$ ]] || fail "expected numeric STEP_LATENCY_1, got '$latency_1'"
echo "PASS: successful step"

run_step 2 "slow_step" 1 no 'sleep 10; echo late'
[[ "${STEP_STATUS_2:-}" == "timeout" ]] || fail "expected STEP_STATUS_2=timeout, got '${STEP_STATUS_2:-}'"
[[ -z "${STEP_OUTPUT_2:-}" ]] || fail "expected empty STEP_OUTPUT_2 on timeout"
echo "PASS: timeout step"

run_step 3 "error_step" 5 no 'exit 7'
[[ "${STEP_STATUS_3:-}" == "error" ]] || fail "expected STEP_STATUS_3=error, got '${STEP_STATUS_3:-}'"
[[ -z "${STEP_OUTPUT_3:-}" ]] || fail "expected empty STEP_OUTPUT_3 on error"
echo "PASS: error step (non-required)"

if run_step 4 "required_fail" 5 yes 'exit 1'; then
  fail "required failure should return non-zero"
fi
[[ "${STEP_STATUS_4:-}" == "error" ]] || fail "expected STEP_STATUS_4=error"
echo "PASS: required error aborts"

if run_step 5 "required_timeout" 1 yes 'sleep 10'; then
  fail "required timeout should return non-zero"
fi
[[ "${STEP_STATUS_5:-}" == "timeout" ]] || fail "expected STEP_STATUS_5=timeout"
echo "PASS: required timeout aborts"

echo

echo "All run_step tests passed."
