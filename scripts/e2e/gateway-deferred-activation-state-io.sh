#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_ID="$(date -u +%Y-%m-%dT%H-%M-%SZ)-$$"
ARTIFACT_PARENT="${OPENCLAW_GATEWAY_DEFERRED_STATE_IO_ARTIFACT_ROOT:-${TMPDIR:-/tmp}/openclaw-gateway-deferred-state-io}"
ARTIFACT_DIR="${OPENCLAW_GATEWAY_DEFERRED_STATE_IO_ARTIFACT_DIR:-$ARTIFACT_PARENT/$RUN_ID}"
STATE_DIR="$ARTIFACT_DIR/state"
CONFIG_DIR="$ARTIFACT_DIR/config"
CONFIG_PATH="$CONFIG_DIR/openclaw.json"
TRACE_DIR="$ARTIFACT_DIR/strace"
TRACE_PREFIX="$TRACE_DIR/trace.log"
PRE_ACTIVATION_TRACE_DIR="$ARTIFACT_DIR/pre-activation-trace"
STDOUT_LOG="$ARTIFACT_DIR/stdout.log"
STDERR_LOG="$ARTIFACT_DIR/stderr.log"
HEALTHZ_BODY="$ARTIFACT_DIR/control-healthz.json"
ACTIVATE_BODY="$ARTIFACT_DIR/activate.json"
READYZ_BODY="$ARTIFACT_DIR/gateway-readyz.json"
SUMMARY_FILE="$ARTIFACT_DIR/summary.txt"
CONTROL_PORT="${OPENCLAW_TEST_CONTROL_PORT:-19792}"
GATEWAY_PORT="${OPENCLAW_TEST_GATEWAY_PORT:-18789}"
ACTIVATION_TOKEN="state-io-test-token"
GATEWAY_TOKEN="state-io-gateway-auth-token"
RESULT="UNKNOWN"
RESULT_NOTE="not-finished"
GATEWAY_PID=""
ARTIFACT_DIR_PRINTED=0

mkdir -p "$STATE_DIR" "$CONFIG_DIR" "$TRACE_DIR" "$PRE_ACTIVATION_TRACE_DIR"
chmod -R a+rwX "$ARTIFACT_DIR" || true

print_artifact_dir() {
  if [[ "$ARTIFACT_DIR_PRINTED" -eq 1 ]]; then
    return
  fi
  ARTIFACT_DIR_PRINTED=1
  printf 'Artifact directory: %s\n' "$ARTIFACT_DIR"
}

write_summary() {
  cat >"$SUMMARY_FILE" <<EOF
run_id=$RUN_ID
result=$RESULT
note=$RESULT_NOTE
artifact_dir=$ARTIFACT_DIR
root_dir=$ROOT_DIR
control_port=$CONTROL_PORT
gateway_port=$GATEWAY_PORT
launcher=node openclaw.mjs gateway run --allow-unconfigured --auth token
stdout_log=$STDOUT_LOG
stderr_log=$STDERR_LOG
trace_prefix=$TRACE_PREFIX
pre_activation_trace_dir=$PRE_ACTIVATION_TRACE_DIR
EOF
}

cleanup() {
  local exit_code=$?
  if [[ -n "$GATEWAY_PID" ]] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
    kill -TERM "$GATEWAY_PID" 2>/dev/null || true
    wait "$GATEWAY_PID" || true
  elif [[ -n "$GATEWAY_PID" ]]; then
    wait "$GATEWAY_PID" || true
  fi
  write_summary
  if [[ "$RESULT" == "UNKNOWN" ]]; then
    RESULT="FAIL"
    RESULT_NOTE="unexpected-exit"
    write_summary
  fi
  if [[ $exit_code -ne 0 ]]; then
    print_artifact_dir >&2
  fi
}
trap cleanup EXIT

skip() {
  RESULT="SKIP"
  RESULT_NOTE="$1"
  write_summary
  printf 'SKIP: %s\n' "$1" >&2
  print_artifact_dir >&2
  exit 2
}

fail() {
  RESULT="FAIL"
  RESULT_NOTE="$1"
  write_summary
  printf 'ERROR: %s\n' "$1" >&2
  print_artifact_dir >&2
  exit 1
}

assert_tool() {
  local tool=$1
  if ! command -v "$tool" >/dev/null 2>&1; then
    fail "required tool '$tool' is not installed"
  fi
}

wait_for_http_ok() {
  local url=$1
  local body_path=$2
  local attempts=$3
  local sleep_s=$4
  local attempt
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if curl -fsS --max-time 2 "$url" >"$body_path" 2>/dev/null; then
      return 0
    fi
    if [[ -n "$GATEWAY_PID" ]] && ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
      return 1
    fi
    sleep "$sleep_s"
  done
  return 1
}

snapshot_pre_activation_trace() {
  shopt -s nullglob
  local trace_files=("$TRACE_PREFIX"*)
  shopt -u nullglob
  if [[ ${#trace_files[@]} -eq 0 ]]; then
    fail "strace did not produce any trace files before activation"
  fi
  cp "${trace_files[@]}" "$PRE_ACTIVATION_TRACE_DIR/"
}

assert_no_matches() {
  local match_name=$1
  shift
  local matches_file="$ARTIFACT_DIR/${match_name}.matches.txt"
  if "$@" >"$matches_file" 2>&1; then
    fail "$match_name matched; see $matches_file"
  else
    local status=$?
    if [[ $status -gt 1 ]]; then
      fail "$match_name grep failed; see $matches_file"
    fi
  fi
  rm -f "$matches_file"
}

if [[ "$(uname -s)" != "Linux" ]]; then
  skip "gateway deferred state-I/O proof requires Linux strace/curl; run via Crabbox/Testbox"
fi

assert_tool strace
assert_tool curl
assert_tool node

if [[ ! -f "$ROOT_DIR/openclaw.mjs" ]]; then
  fail "missing openclaw.mjs launcher at repo root"
fi

if [[ ! -f "$ROOT_DIR/dist/entry.js" && ! -f "$ROOT_DIR/dist/entry.mjs" ]]; then
  fail "missing dist/entry.(m)js build output; run pnpm build first"
fi

printf 'Running gateway deferred zero-state-I/O proof (run_id=%s)\n' "$RUN_ID"
printf 'Using artifact directory: %s\n' "$ARTIFACT_DIR"

(
  cd "$ROOT_DIR"
  OPENCLAW_STATE_DIR="$STATE_DIR" \
  OPENCLAW_CONFIG_PATH="$CONFIG_PATH" \
  OPENCLAW_GATEWAY_DEFERRED_ACTIVATION_CONTROL_PORT="$CONTROL_PORT" \
  OPENCLAW_GATEWAY_DEFERRED_ACTIVATION_TOKEN="$ACTIVATION_TOKEN" \
  OPENCLAW_GATEWAY_TOKEN="$GATEWAY_TOKEN" \
  strace -ff -e trace=file,network -s 0 -o "$TRACE_PREFIX" \
    node openclaw.mjs gateway run --allow-unconfigured --auth token
) >"$STDOUT_LOG" 2>"$STDERR_LOG" &
GATEWAY_PID=$!

if ! wait_for_http_ok "http://127.0.0.1:${CONTROL_PORT}/healthz" "$HEALTHZ_BODY" 200 0.05; then
  fail "timed out waiting for deferred activation control /healthz"
fi

snapshot_pre_activation_trace

assert_no_matches \
  pre_activation_state_dir_access \
  grep -R -F -n "$STATE_DIR" "$PRE_ACTIVATION_TRACE_DIR"
assert_no_matches \
  pre_activation_config_dir_access \
  grep -R -F -n "$CONFIG_DIR" "$PRE_ACTIVATION_TRACE_DIR"
assert_no_matches \
  pre_activation_state_file_access \
  grep -R -E -n 'openclaw\.sqlite|gateway\.lock' "$PRE_ACTIVATION_TRACE_DIR"
assert_no_matches \
  pre_activation_gateway_port_access \
  grep -R -E -n "bind\\(.*${GATEWAY_PORT}|connect\\(.*${GATEWAY_PORT}" "$PRE_ACTIVATION_TRACE_DIR"

if ! curl -fsS --max-time 2 \
  -X POST \
  -H "x-openclaw-activation-token: ${ACTIVATION_TOKEN}" \
  -H 'content-type: application/json' \
  --data '{"activationId":"state-io-proof"}' \
  "http://127.0.0.1:${CONTROL_PORT}/activate" >"$ACTIVATE_BODY"; then
  fail "activation request failed"
fi

if ! wait_for_http_ok "http://127.0.0.1:${GATEWAY_PORT}/readyz" "$READYZ_BODY" 400 0.05; then
  fail "timed out waiting for gateway /readyz after activation"
fi

RESULT="PASS"
RESULT_NOTE="no pre-activation state/config/lock or gateway-port access detected in trace snapshot"
write_summary
printf 'PASS: %s\n' "$RESULT_NOTE"
print_artifact_dir
