#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

VM_NAME="macOS Tahoe"
SNAPSHOT_HINT="macOS 26.3.1 fresh"
MODE="both"
OPENAI_API_KEY_ENV="OPENAI_API_KEY"
INSTALL_URL="https://openclaw.ai/install.sh"
HOST_PORT="18425"
HOST_PORT_EXPLICIT=0
HOST_IP=""
LATEST_VERSION=""
KEEP_SERVER=0
CHECK_LATEST_REF=1
JSON_OUTPUT=0
GUEST_OPENCLAW_BIN="/opt/homebrew/bin/openclaw"
GUEST_OPENCLAW_ENTRY="/opt/homebrew/lib/node_modules/openclaw/openclaw.mjs"
GUEST_NODE_BIN="/opt/homebrew/bin/node"
GUEST_NPM_BIN="/opt/homebrew/bin/npm"

MAIN_TGZ_DIR="$(mktemp -d)"
MAIN_TGZ_PATH=""
SERVER_PID=""
RUN_DIR="$(mktemp -d /tmp/openclaw-parallels-smoke.XXXXXX)"

TIMEOUT_INSTALL_S=900
TIMEOUT_VERIFY_S=60
TIMEOUT_ONBOARD_S=180
TIMEOUT_GATEWAY_S=60
TIMEOUT_AGENT_S=120
TIMEOUT_PERMISSION_S=60
TIMEOUT_SNAPSHOT_S=180

FRESH_MAIN_VERSION="skip"
LATEST_INSTALLED_VERSION="skip"
UPGRADE_MAIN_VERSION="skip"
FRESH_GATEWAY_STATUS="skip"
UPGRADE_GATEWAY_STATUS="skip"
FRESH_AGENT_STATUS="skip"
UPGRADE_AGENT_STATUS="skip"

say() {
  printf '==> %s\n' "$*"
}

warn() {
  printf 'warn: %s\n' "$*" >&2
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$MAIN_TGZ_DIR"
  if [[ "${KEEP_SERVER:-0}" -eq 0 ]]; then
    :
  fi
}

trap cleanup EXIT

shell_quote() {
  local value="$1"
  printf "'%s'" "$(printf '%s' "$value" | sed "s/'/'\"'\"'/g")"
}

usage() {
  cat <<'EOF'
Usage: bash scripts/e2e/parallels-macos-smoke.sh [options]

Options:
  --vm <name>                Parallels VM name. Default: "macOS Tahoe"
  --snapshot-hint <name>     Snapshot name substring/fuzzy match.
                             Default: "macOS 26.3.1 fresh"
  --mode <fresh|upgrade|both>
                             fresh   = fresh snapshot -> current main tgz -> onboard smoke
                             upgrade = fresh snapshot -> latest release -> current main tgz -> onboard smoke
                             both    = run both lanes
  --openai-api-key-env <var> Host env var name for OpenAI API key.
                             Default: OPENAI_API_KEY
  --install-url <url>        Installer URL for latest release. Default: https://openclaw.ai/install.sh
  --host-port <port>         Host HTTP port for current-main tgz. Default: 18425
  --host-ip <ip>             Override Parallels host IP.
  --latest-version <ver>     Override npm latest version lookup.
  --skip-latest-ref-check    Skip the known latest-release ref-mode precheck in upgrade lane.
  --keep-server              Leave temp host HTTP server running.
  --json                     Print machine-readable JSON summary.
  -h, --help                 Show help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vm)
      VM_NAME="$2"
      shift 2
      ;;
    --snapshot-hint)
      SNAPSHOT_HINT="$2"
      shift 2
      ;;
    --mode)
      MODE="$2"
      shift 2
      ;;
    --openai-api-key-env)
      OPENAI_API_KEY_ENV="$2"
      shift 2
      ;;
    --install-url)
      INSTALL_URL="$2"
      shift 2
      ;;
    --host-port)
      HOST_PORT="$2"
      HOST_PORT_EXPLICIT=1
      shift 2
      ;;
    --host-ip)
      HOST_IP="$2"
      shift 2
      ;;
    --latest-version)
      LATEST_VERSION="$2"
      shift 2
      ;;
    --skip-latest-ref-check)
      CHECK_LATEST_REF=0
      shift
      ;;
    --keep-server)
      KEEP_SERVER=1
      shift
      ;;
    --json)
      JSON_OUTPUT=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown arg: $1"
      ;;
  esac
done

case "$MODE" in
  fresh|upgrade|both) ;;
  *)
    die "invalid --mode: $MODE"
    ;;
esac

OPENAI_API_KEY_VALUE="${!OPENAI_API_KEY_ENV:-}"
[[ -n "$OPENAI_API_KEY_VALUE" ]] || die "$OPENAI_API_KEY_ENV is required"

resolve_snapshot_id() {
  local json hint
  json="$(prlctl snapshot-list "$VM_NAME" --json)"
  hint="$SNAPSHOT_HINT"
  SNAPSHOT_JSON="$json" SNAPSHOT_HINT="$hint" python3 - <<'PY'
import difflib
import json
import os
import sys

payload = json.loads(os.environ["SNAPSHOT_JSON"])
hint = os.environ["SNAPSHOT_HINT"].strip().lower()
best_id = None
best_score = -1.0
for snapshot_id, meta in payload.items():
    name = str(meta.get("name", "")).strip()
    lowered = name.lower()
    score = 0.0
    if lowered == hint:
        score = 10.0
    elif hint and hint in lowered:
        score = 5.0 + len(hint) / max(len(lowered), 1)
    else:
        score = difflib.SequenceMatcher(None, hint, lowered).ratio()
    if score > best_score:
        best_score = score
        best_id = snapshot_id
if not best_id:
    sys.exit("no snapshot matched")
print(best_id)
PY
}

resolve_host_ip() {
  if [[ -n "$HOST_IP" ]]; then
    printf '%s\n' "$HOST_IP"
    return
  fi

  local detected
  detected="$(ifconfig | awk '/inet 10\.211\./ { print $2; exit }')"
  [[ -n "$detected" ]] || die "failed to detect Parallels host IP; pass --host-ip"
  printf '%s\n' "$detected"
}

is_host_port_free() {
  local port="$1"
  python3 - "$port" <<'PY'
import socket
import sys

port = int(sys.argv[1])
sock = socket.socket()
try:
    sock.bind(("0.0.0.0", port))
except OSError:
    raise SystemExit(1)
finally:
    sock.close()
PY
}

allocate_host_port() {
  python3 - <<'PY'
import socket

sock = socket.socket()
sock.bind(("0.0.0.0", 0))
print(sock.getsockname()[1])
sock.close()
PY
}

resolve_host_port() {
  if is_host_port_free "$HOST_PORT"; then
    printf '%s\n' "$HOST_PORT"
    return
  fi
  if [[ "$HOST_PORT_EXPLICIT" -eq 1 ]]; then
    die "host port $HOST_PORT already in use"
  fi
  HOST_PORT="$(allocate_host_port)"
  warn "host port 18425 busy; using $HOST_PORT"
  printf '%s\n' "$HOST_PORT"
}

wait_for_current_user() {
  local deadline
  deadline=$((SECONDS + TIMEOUT_SNAPSHOT_S))
  while (( SECONDS < deadline )); do
    if prlctl exec "$VM_NAME" --current-user whoami >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

guest_current_user_exec() {
  prlctl exec "$VM_NAME" --current-user /usr/bin/env \
    PATH=/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin \
    "$@"
}

guest_script() {
  local mode script
  mode="$1"
  script="$2"
  PRL_GUEST_VM_NAME="$VM_NAME" PRL_GUEST_MODE="$mode" PRL_GUEST_SCRIPT="$script" /opt/homebrew/bin/expect <<'EOF'
log_user 1
set timeout -1
match_max 1048576

set vm $env(PRL_GUEST_VM_NAME)
set mode $env(PRL_GUEST_MODE)
set script $env(PRL_GUEST_SCRIPT)
set cmd [list prlctl enter $vm]
if {$mode eq "current-user"} {
  lappend cmd --current-user
}

spawn {*}$cmd
send -- "printf '__OPENCLAW_READY__\\n'\r"
expect "__OPENCLAW_READY__"
log_user 0
send -- "export PS1='' PROMPT='' PROMPT2='' RPROMPT=''\r"
send -- "stty -echo\r"

send -- "cat >/tmp/openclaw-prl.sh <<'__OPENCLAW_SCRIPT__'\r"
send -- $script
if {![string match "*\n" $script]} {
  send -- "\r"
}
send -- "__OPENCLAW_SCRIPT__\r"
send -- "/bin/bash /tmp/openclaw-prl.sh; rc=\$?; rm -f /tmp/openclaw-prl.sh; printf '__OPENCLAW_RC__:%s\\n' \"\$rc\"; exit \"\$rc\"\r"
log_user 1

set rc 1
expect {
  -re {__OPENCLAW_RC__:(-?[0-9]+)} {
    set rc $expect_out(1,string)
    exp_continue
  }
  eof {}
}
catch wait result
exit $rc
EOF
}

guest_current_user_sh() {
  local script
  script=$'set -eu\n'
  script+=$'set -o pipefail\n'
  script+=$'trap "" PIPE\n'
  script+=$'umask 022\n'
  script+=$'export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"\n'
  script+=$'if [ -z "${HOME:-}" ]; then export HOME="/Users/$(id -un)"; fi\n'
  script+=$'cd "$HOME"\n'
  script+="$1"
  guest_script current-user "$script"
}

restore_snapshot() {
  local snapshot_id="$1"
  say "Restore snapshot $SNAPSHOT_HINT ($snapshot_id)"
  prlctl snapshot-switch "$VM_NAME" --id "$snapshot_id" >/dev/null
  wait_for_current_user || die "desktop user did not become ready in $VM_NAME"
}

resolve_latest_version() {
  if [[ -n "$LATEST_VERSION" ]]; then
    printf '%s\n' "$LATEST_VERSION"
    return
  fi
  npm view openclaw version --userconfig "$(mktemp)"
}

install_latest_release() {
  local install_url_q
  install_url_q="$(shell_quote "$INSTALL_URL")"
  guest_current_user_sh "$(cat <<EOF
export OPENCLAW_NO_ONBOARD=1
curl -fsSL $install_url_q -o /tmp/openclaw-install.sh
bash /tmp/openclaw-install.sh
$GUEST_OPENCLAW_BIN --version
EOF
)"
}

verify_version_contains() {
  local needle="$1"
  local version
  version="$(
    guest_current_user_exec "$GUEST_OPENCLAW_BIN" --version
  )"
  printf '%s\n' "$version"
  case "$version" in
    *"$needle"*) ;;
    *)
      echo "version mismatch: expected substring $needle" >&2
      return 1
      ;;
  esac
}

pack_main_tgz() {
  say "Pack current main tgz"
  local short_head pkg
  short_head="$(git rev-parse --short HEAD)"
  pkg="$(
    npm pack --ignore-scripts --json --pack-destination "$MAIN_TGZ_DIR" \
      | python3 -c 'import json, sys; data = json.load(sys.stdin); print(data[-1]["filename"])'
  )"
  MAIN_TGZ_PATH="$MAIN_TGZ_DIR/openclaw-main-$short_head.tgz"
  cp "$MAIN_TGZ_DIR/$pkg" "$MAIN_TGZ_PATH"
  say "Packed $MAIN_TGZ_PATH"
  tar -xOf "$MAIN_TGZ_PATH" package/dist/build-info.json
}

start_server() {
  local host_ip="$1"
  say "Serve current main tgz on $host_ip:$HOST_PORT"
  (
    cd "$MAIN_TGZ_DIR"
    exec python3 -m http.server "$HOST_PORT" --bind 0.0.0.0
  ) >/tmp/openclaw-parallels-http.log 2>&1 &
  SERVER_PID=$!
  sleep 1
  kill -0 "$SERVER_PID" >/dev/null 2>&1 || die "failed to start host HTTP server"
}

install_main_tgz() {
  local host_ip="$1"
  local temp_name="$2"
  local tgz_url_q
  tgz_url_q="$(shell_quote "http://$host_ip:$HOST_PORT/$(basename "$MAIN_TGZ_PATH")")"
  guest_current_user_sh "$(cat <<EOF
curl -fsSL $tgz_url_q -o /tmp/$temp_name
$GUEST_NPM_BIN install -g /tmp/$temp_name
$GUEST_OPENCLAW_BIN --version
EOF
)"
}

verify_bundle_permissions() {
  local npm_q cmd
  npm_q="$(shell_quote "$GUEST_NPM_BIN")"
  cmd="$(cat <<EOF
root=\$($npm_q root -g); check_path() { local path="\$1"; [ -e "\$path" ] || return 0; local perm perm_oct; perm=\$(/usr/bin/stat -f '%OLp' "\$path"); perm_oct=\$((8#\$perm)); if (( perm_oct & 0002 )); then echo "world-writable install artifact: \$path (\$perm)" >&2; exit 1; fi; }; check_path "\$root/openclaw"; check_path "\$root/openclaw/extensions"; if [ -d "\$root/openclaw/extensions" ]; then while IFS= read -r -d '' extension_dir; do check_path "\$extension_dir"; done < <(/usr/bin/find "\$root/openclaw/extensions" -mindepth 1 -maxdepth 1 -type d -print0); fi
EOF
)"
  guest_current_user_exec /bin/bash -lc "$cmd"
}

run_ref_onboard() {
  guest_current_user_exec \
    /usr/bin/env "OPENAI_API_KEY=$OPENAI_API_KEY_VALUE" \
    "$GUEST_NODE_BIN" "$GUEST_OPENCLAW_ENTRY" onboard \
    --non-interactive \
    --mode local \
    --auth-choice openai-api-key \
    --secret-input-mode ref \
    --gateway-port 18789 \
    --gateway-bind loopback \
    --install-daemon \
    --skip-skills \
    --accept-risk \
    --json
}

verify_gateway() {
  guest_current_user_exec "$GUEST_NODE_BIN" "$GUEST_OPENCLAW_ENTRY" gateway status --deep
}

verify_turn() {
  guest_current_user_exec "$GUEST_NODE_BIN" "$GUEST_OPENCLAW_ENTRY" agent --agent main --message ping --json
}

phase_log_path() {
  printf '%s/%s.log\n' "$RUN_DIR" "$1"
}

extract_last_version() {
  local log_path="$1"
  python3 - "$log_path" <<'PY'
import pathlib
import re
import sys

text = pathlib.Path(sys.argv[1]).read_text(errors="replace")
matches = re.findall(r"OpenClaw [^\r\n]+ \([0-9a-f]{7,}\)", text)
print(matches[-1] if matches else "")
PY
}

show_log_excerpt() {
  local log_path="$1"
  warn "log tail: $log_path"
  tail -n 80 "$log_path" >&2 || true
}

phase_run() {
  local phase_id="$1"
  local timeout_s="$2"
  shift 2

  local log_path pid start rc timed_out
  log_path="$(phase_log_path "$phase_id")"
  say "$phase_id"
  start=$SECONDS
  timed_out=0

  (
    "$@"
  ) >"$log_path" 2>&1 &
  pid=$!

  while kill -0 "$pid" >/dev/null 2>&1; do
    if (( SECONDS - start >= timeout_s )); then
      timed_out=1
      kill "$pid" >/dev/null 2>&1 || true
      sleep 2
      kill -9 "$pid" >/dev/null 2>&1 || true
      break
    fi
    sleep 1
  done

  set +e
  wait "$pid"
  rc=$?
  set -e

  if (( timed_out )); then
    warn "$phase_id timed out after ${timeout_s}s"
    printf 'timeout after %ss\n' "$timeout_s" >>"$log_path"
    show_log_excerpt "$log_path"
    return 124
  fi

  if [[ $rc -ne 0 ]]; then
    warn "$phase_id failed (rc=$rc)"
    show_log_excerpt "$log_path"
    return "$rc"
  fi

  return 0
}

write_summary_json() {
  local summary_path="$RUN_DIR/summary.json"
  python3 - "$summary_path" <<'PY'
import json
import os
import sys

summary = {
    "vm": os.environ["SUMMARY_VM"],
    "snapshotHint": os.environ["SUMMARY_SNAPSHOT_HINT"],
    "snapshotId": os.environ["SUMMARY_SNAPSHOT_ID"],
    "mode": os.environ["SUMMARY_MODE"],
    "latestVersion": os.environ["SUMMARY_LATEST_VERSION"],
    "currentHead": os.environ["SUMMARY_CURRENT_HEAD"],
    "runDir": os.environ["SUMMARY_RUN_DIR"],
    "freshMain": {
        "status": os.environ["SUMMARY_FRESH_MAIN_STATUS"],
        "version": os.environ["SUMMARY_FRESH_MAIN_VERSION"],
        "gateway": os.environ["SUMMARY_FRESH_GATEWAY_STATUS"],
        "agent": os.environ["SUMMARY_FRESH_AGENT_STATUS"],
    },
    "upgrade": {
        "precheck": os.environ["SUMMARY_UPGRADE_PRECHECK_STATUS"],
        "status": os.environ["SUMMARY_UPGRADE_STATUS"],
        "latestVersionInstalled": os.environ["SUMMARY_LATEST_INSTALLED_VERSION"],
        "mainVersion": os.environ["SUMMARY_UPGRADE_MAIN_VERSION"],
        "gateway": os.environ["SUMMARY_UPGRADE_GATEWAY_STATUS"],
        "agent": os.environ["SUMMARY_UPGRADE_AGENT_STATUS"],
    },
}
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(summary, handle, indent=2, sort_keys=True)
print(sys.argv[1])
PY
}

capture_latest_ref_failure() {
  set +e
  run_ref_onboard
  local rc=$?
  set -e
  if [[ $rc -eq 0 ]]; then
    say "Latest release ref-mode onboard passed"
    return 0
  fi
  warn "Latest release ref-mode onboard failed pre-upgrade"
  set +e
  guest_current_user_exec "$GUEST_NODE_BIN" "$GUEST_OPENCLAW_ENTRY" gateway status --deep || true
  set -e
  return 1
}

run_fresh_main_lane() {
  local snapshot_id="$1"
  local host_ip="$2"
  phase_run "fresh.restore-snapshot" "$TIMEOUT_SNAPSHOT_S" restore_snapshot "$snapshot_id"
  phase_run "fresh.install-main" "$TIMEOUT_INSTALL_S" install_main_tgz "$host_ip" "openclaw-main-fresh.tgz"
  FRESH_MAIN_VERSION="$(extract_last_version "$(phase_log_path fresh.install-main)")"
  phase_run "fresh.verify-main-version" "$TIMEOUT_VERIFY_S" verify_version_contains "$(git rev-parse --short=7 HEAD)"
  phase_run "fresh.verify-bundle-permissions" "$TIMEOUT_PERMISSION_S" verify_bundle_permissions
  phase_run "fresh.onboard-ref" "$TIMEOUT_ONBOARD_S" run_ref_onboard
  phase_run "fresh.gateway-status" "$TIMEOUT_GATEWAY_S" verify_gateway
  FRESH_GATEWAY_STATUS="pass"
  phase_run "fresh.first-agent-turn" "$TIMEOUT_AGENT_S" verify_turn
  FRESH_AGENT_STATUS="pass"
}

run_upgrade_lane() {
  local snapshot_id="$1"
  local host_ip="$2"
  phase_run "upgrade.restore-snapshot" "$TIMEOUT_SNAPSHOT_S" restore_snapshot "$snapshot_id"
  phase_run "upgrade.install-latest" "$TIMEOUT_INSTALL_S" install_latest_release
  LATEST_INSTALLED_VERSION="$(extract_last_version "$(phase_log_path upgrade.install-latest)")"
  phase_run "upgrade.verify-latest-version" "$TIMEOUT_VERIFY_S" verify_version_contains "$LATEST_VERSION"
  if [[ "$CHECK_LATEST_REF" -eq 1 ]]; then
    if phase_run "upgrade.latest-ref-precheck" "$TIMEOUT_ONBOARD_S" capture_latest_ref_failure; then
      UPGRADE_PRECHECK_STATUS="latest-ref-pass"
    else
      UPGRADE_PRECHECK_STATUS="latest-ref-fail"
    fi
  else
    UPGRADE_PRECHECK_STATUS="skipped"
  fi
  phase_run "upgrade.install-main" "$TIMEOUT_INSTALL_S" install_main_tgz "$host_ip" "openclaw-main-upgrade.tgz"
  UPGRADE_MAIN_VERSION="$(extract_last_version "$(phase_log_path upgrade.install-main)")"
  phase_run "upgrade.verify-main-version" "$TIMEOUT_VERIFY_S" verify_version_contains "$(git rev-parse --short=7 HEAD)"
  phase_run "upgrade.verify-bundle-permissions" "$TIMEOUT_PERMISSION_S" verify_bundle_permissions
  phase_run "upgrade.onboard-ref" "$TIMEOUT_ONBOARD_S" run_ref_onboard
  phase_run "upgrade.gateway-status" "$TIMEOUT_GATEWAY_S" verify_gateway
  UPGRADE_GATEWAY_STATUS="pass"
  phase_run "upgrade.first-agent-turn" "$TIMEOUT_AGENT_S" verify_turn
  UPGRADE_AGENT_STATUS="pass"
}

FRESH_MAIN_STATUS="skip"
UPGRADE_STATUS="skip"
UPGRADE_PRECHECK_STATUS="skip"

SNAPSHOT_ID="$(resolve_snapshot_id)"
LATEST_VERSION="$(resolve_latest_version)"
HOST_IP="$(resolve_host_ip)"
HOST_PORT="$(resolve_host_port)"

say "VM: $VM_NAME"
say "Snapshot hint: $SNAPSHOT_HINT"
say "Latest npm version: $LATEST_VERSION"
say "Current head: $(git rev-parse --short HEAD)"
say "Run logs: $RUN_DIR"

pack_main_tgz
start_server "$HOST_IP"

if [[ "$MODE" == "fresh" || "$MODE" == "both" ]]; then
  set +e
  run_fresh_main_lane "$SNAPSHOT_ID" "$HOST_IP"
  fresh_rc=$?
  set -e
  if [[ $fresh_rc -eq 0 ]]; then
    FRESH_MAIN_STATUS="pass"
  else
    FRESH_MAIN_STATUS="fail"
  fi
fi

if [[ "$MODE" == "upgrade" || "$MODE" == "both" ]]; then
  set +e
  run_upgrade_lane "$SNAPSHOT_ID" "$HOST_IP"
  upgrade_rc=$?
  set -e
  if [[ $upgrade_rc -eq 0 ]]; then
    UPGRADE_STATUS="pass"
  else
    UPGRADE_STATUS="fail"
  fi
fi

if [[ "$KEEP_SERVER" -eq 0 && -n "${SERVER_PID:-}" ]]; then
  kill "$SERVER_PID" >/dev/null 2>&1 || true
  SERVER_PID=""
fi

SUMMARY_JSON_PATH="$(
  SUMMARY_VM="$VM_NAME" \
  SUMMARY_SNAPSHOT_HINT="$SNAPSHOT_HINT" \
  SUMMARY_SNAPSHOT_ID="$SNAPSHOT_ID" \
  SUMMARY_MODE="$MODE" \
  SUMMARY_LATEST_VERSION="$LATEST_VERSION" \
  SUMMARY_CURRENT_HEAD="$(git rev-parse --short HEAD)" \
  SUMMARY_RUN_DIR="$RUN_DIR" \
  SUMMARY_FRESH_MAIN_STATUS="$FRESH_MAIN_STATUS" \
  SUMMARY_FRESH_MAIN_VERSION="$FRESH_MAIN_VERSION" \
  SUMMARY_FRESH_GATEWAY_STATUS="$FRESH_GATEWAY_STATUS" \
  SUMMARY_FRESH_AGENT_STATUS="$FRESH_AGENT_STATUS" \
  SUMMARY_UPGRADE_PRECHECK_STATUS="$UPGRADE_PRECHECK_STATUS" \
  SUMMARY_UPGRADE_STATUS="$UPGRADE_STATUS" \
  SUMMARY_LATEST_INSTALLED_VERSION="$LATEST_INSTALLED_VERSION" \
  SUMMARY_UPGRADE_MAIN_VERSION="$UPGRADE_MAIN_VERSION" \
  SUMMARY_UPGRADE_GATEWAY_STATUS="$UPGRADE_GATEWAY_STATUS" \
  SUMMARY_UPGRADE_AGENT_STATUS="$UPGRADE_AGENT_STATUS" \
  write_summary_json
)"

if [[ "$JSON_OUTPUT" -eq 1 ]]; then
  cat "$SUMMARY_JSON_PATH"
else
  printf '\nSummary:\n'
  printf '  fresh-main: %s (%s)\n' "$FRESH_MAIN_STATUS" "$FRESH_MAIN_VERSION"
  printf '  latest->main precheck: %s (%s)\n' "$UPGRADE_PRECHECK_STATUS" "$LATEST_INSTALLED_VERSION"
  printf '  latest->main: %s (%s)\n' "$UPGRADE_STATUS" "$UPGRADE_MAIN_VERSION"
  printf '  logs: %s\n' "$RUN_DIR"
  printf '  summary: %s\n' "$SUMMARY_JSON_PATH"
fi

if [[ "$FRESH_MAIN_STATUS" == "fail" || "$UPGRADE_STATUS" == "fail" ]]; then
  exit 1
fi
