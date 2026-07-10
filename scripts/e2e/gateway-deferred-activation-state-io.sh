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
GATEWAY_PGID=""
ARTIFACT_DIR_PRINTED=0
WAIT_FAILURE_REASON=""

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
launcher=node openclaw.mjs gateway run --allow-unconfigured --auth token --port $GATEWAY_PORT
stdout_log=$STDOUT_LOG
stderr_log=$STDERR_LOG
trace_prefix=$TRACE_PREFIX
pre_activation_trace_dir=$PRE_ACTIVATION_TRACE_DIR
EOF
}

on_signal() {
  local signal_name=$1
  local exit_code=$2
  if [[ "$RESULT" == "UNKNOWN" ]]; then
    RESULT="FAIL"
    RESULT_NOTE="interrupted-by-${signal_name}"
  fi
  exit "$exit_code"
}

cleanup() {
  local exit_code=$?
  trap - EXIT

  if [[ -n "$GATEWAY_PGID" ]]; then
    # A parked process group ignores TERM until it is continued, so cleanup always
    # resumes the traced tree before sending the bounded TERM/KILL shutdown.
    kill -CONT -- "-$GATEWAY_PGID" 2>/dev/null || true
    kill -TERM -- "-$GATEWAY_PGID" 2>/dev/null || true
    if ! wait_for_process_group_exit 80 0.05; then
      kill -KILL -- "-$GATEWAY_PGID" 2>/dev/null || true
      wait_for_process_group_exit 40 0.05 || true
    fi
  fi

  if [[ -n "$GATEWAY_PID" ]]; then
    wait "$GATEWAY_PID" 2>/dev/null || true
  fi

  if [[ "$RESULT" == "UNKNOWN" ]]; then
    RESULT="FAIL"
    RESULT_NOTE="unexpected-exit"
  fi
  write_summary

  if [[ $exit_code -ne 0 ]]; then
    print_artifact_dir >&2
  fi

  exit "$exit_code"
}
trap cleanup EXIT
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM
trap 'on_signal HUP 129' HUP

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

fail_phase() {
  local phase=$1
  local detail=$2
  fail "${phase}: ${detail}; stderr_log=${STDERR_LOG}; artifact_dir=${ARTIFACT_DIR}"
}

assert_tool() {
  local tool=$1
  if ! command -v "$tool" >/dev/null 2>&1; then
    fail "required tool '$tool' is not installed"
  fi
}

list_process_group_members() {
  local pgid=$1
  ps -o pid=,pgid=,state= -e | awk -v pgid="$pgid" '$2 == pgid { print $1 " " $3 }'
}

process_group_has_members() {
  local pgid=$1
  local members
  members="$(list_process_group_members "$pgid")"
  [[ -n "$members" ]]
}

process_group_is_stopped() {
  local pgid=$1
  local saw_member=0
  local pid state

  while read -r pid state; do
    if [[ -z "${pid:-}" ]]; then
      continue
    fi
    saw_member=1
    case "$state" in
      T|t|Z|z|X|x) ;;
      *) return 1 ;;
    esac
  done < <(list_process_group_members "$pgid")

  [[ $saw_member -eq 1 ]]
}

wait_for_process_group_exit() {
  local attempts=$1
  local sleep_s=$2
  local attempt

  if [[ -z "$GATEWAY_PGID" ]]; then
    return 0
  fi

  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if ! process_group_has_members "$GATEWAY_PGID"; then
      return 0
    fi
    sleep "$sleep_s"
  done

  return 1
}

wait_for_http_ok() {
  local url=$1
  local body_path=$2
  local attempts=$3
  local sleep_s=$4
  local attempt

  WAIT_FAILURE_REASON=""
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if curl -fsS --max-time 2 "$url" >"$body_path" 2>/dev/null; then
      return 0
    fi
    if [[ -n "$GATEWAY_PGID" ]] && ! process_group_has_members "$GATEWAY_PGID"; then
      WAIT_FAILURE_REASON="process-group-exited"
      return 1
    fi
    sleep "$sleep_s"
  done

  WAIT_FAILURE_REASON="timeout"
  return 1
}

wait_for_process_group_stopped() {
  local attempts=$1
  local sleep_s=$2
  local attempt

  WAIT_FAILURE_REASON=""
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if [[ -n "$GATEWAY_PGID" ]] && process_group_is_stopped "$GATEWAY_PGID"; then
      return 0
    fi
    if [[ -n "$GATEWAY_PGID" ]] && ! process_group_has_members "$GATEWAY_PGID"; then
      WAIT_FAILURE_REASON="process-group-exited"
      return 1
    fi
    sleep "$sleep_s"
  done

  WAIT_FAILURE_REASON="timeout"
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
    fail "${match_name} matched; see ${matches_file}"
  else
    local status=$?
    if [[ $status -gt 1 ]]; then
      fail "${match_name} grep failed; see ${matches_file}"
    fi
  fi
  rm -f "$matches_file"
}

if [[ "$(uname -s)" != "Linux" ]]; then
  skip "gateway deferred state-I/O proof requires Linux strace/curl; run via Crabbox/Testbox"
fi

assert_tool awk
assert_tool curl
assert_tool grep
assert_tool node
assert_tool ps
assert_tool setsid
assert_tool strace

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
  exec setsid env \
    OPENCLAW_STATE_DIR="$STATE_DIR" \
    OPENCLAW_CONFIG_PATH="$CONFIG_PATH" \
    OPENCLAW_GATEWAY_DEFERRED_ACTIVATION_CONTROL_PORT="$CONTROL_PORT" \
    OPENCLAW_GATEWAY_DEFERRED_ACTIVATION_TOKEN="$ACTIVATION_TOKEN" \
    OPENCLAW_GATEWAY_TOKEN="$GATEWAY_TOKEN" \
    strace -ff -e trace=file,network -s 0 -o "$TRACE_PREFIX" \
      node openclaw.mjs gateway run --allow-unconfigured --auth token --port "$GATEWAY_PORT"
) >"$STDOUT_LOG" 2>"$STDERR_LOG" &
GATEWAY_PID=$!
GATEWAY_PGID=$GATEWAY_PID

if ! wait_for_http_ok "http://127.0.0.1:${CONTROL_PORT}/healthz" "$HEALTHZ_BODY" 200 0.05; then
  case "$WAIT_FAILURE_REASON" in
    process-group-exited)
      fail_phase "control-healthz" "process group exited before deferred activation control /healthz became ready"
      ;;
    timeout)
      fail_phase "control-healthz" "timed out waiting for deferred activation control /healthz"
      ;;
    *)
      fail_phase "control-healthz" "wait failed (${WAIT_FAILURE_REASON:-unknown})"
      ;;
  esac
fi

# Freeze the dedicated traced process group so the strace files stay quiescent
# while the pre-activation snapshot and negative-match assertions run.
if ! kill -STOP -- "-$GATEWAY_PGID" 2>/dev/null; then
  fail_phase "park-before-snapshot" "failed to stop the dedicated process group"
fi

if ! wait_for_process_group_stopped 200 0.01; then
  case "$WAIT_FAILURE_REASON" in
    process-group-exited)
      fail_phase "park-before-snapshot" "process group exited before all traced members reached the stopped state"
      ;;
    timeout)
      fail_phase "park-before-snapshot" "timed out waiting for all traced members to reach the stopped state"
      ;;
    *)
      fail_phase "park-before-snapshot" "wait failed (${WAIT_FAILURE_REASON:-unknown})"
      ;;
  esac
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

kill -CONT -- "-$GATEWAY_PGID" 2>/dev/null || true

if ! curl -fsS --max-time 2 \
  -X POST \
  -H "x-openclaw-activation-token: ${ACTIVATION_TOKEN}" \
  -H 'content-type: application/json' \
  --data '{"activationId":"state-io-proof"}' \
  "http://127.0.0.1:${CONTROL_PORT}/activate" >"$ACTIVATE_BODY"; then
  fail_phase "activation" "activation request failed"
fi

if ! wait_for_http_ok "http://127.0.0.1:${GATEWAY_PORT}/readyz" "$READYZ_BODY" 400 0.05; then
  case "$WAIT_FAILURE_REASON" in
    process-group-exited)
      fail_phase "post-activation-readyz" "process group exited before gateway /readyz became ready"
      ;;
    timeout)
      fail_phase "post-activation-readyz" "timed out waiting for gateway /readyz after activation"
      ;;
    *)
      fail_phase "post-activation-readyz" "wait failed (${WAIT_FAILURE_REASON:-unknown})"
      ;;
  esac
fi

RESULT="PASS"
RESULT_NOTE="no pre-activation state/config/lock or gateway-port access detected in quiesced trace snapshot"
write_summary
printf 'PASS: %s\n' "$RESULT_NOTE"
print_artifact_dir
