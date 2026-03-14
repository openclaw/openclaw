#!/usr/bin/env bash
set -euo pipefail

VM_NAME="Windows 11"
SNAPSHOT_HINT="pre-openclaw-native-e2e-2026-03-12"
MODE="both"
OPENAI_API_KEY_ENV="OPENAI_API_KEY"
INSTALL_URL="https://openclaw.ai/install.ps1"
HOST_PORT="18426"
HOST_PORT_EXPLICIT=0
HOST_IP=""
LATEST_VERSION=""
JSON_OUTPUT=0
KEEP_SERVER=0
CHECK_LATEST_REF=1

MAIN_TGZ_DIR="$(mktemp -d)"
MAIN_TGZ_PATH=""
MINGIT_ZIP_PATH=""
MINGIT_ZIP_NAME=""
SERVER_PID=""
RUN_DIR="$(mktemp -d /tmp/openclaw-parallels-windows.XXXXXX)"

TIMEOUT_SNAPSHOT_S=240
TIMEOUT_INSTALL_S=1200
TIMEOUT_VERIFY_S=120
TIMEOUT_ONBOARD_S=240
TIMEOUT_GATEWAY_S=120
TIMEOUT_AGENT_S=180

FRESH_MAIN_STATUS="skip"
FRESH_MAIN_VERSION="skip"
FRESH_GATEWAY_STATUS="skip"
FRESH_AGENT_STATUS="skip"
UPGRADE_STATUS="skip"
UPGRADE_PRECHECK_STATUS="skip"
LATEST_INSTALLED_VERSION="skip"
UPGRADE_MAIN_VERSION="skip"
UPGRADE_GATEWAY_STATUS="skip"
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
}

trap cleanup EXIT

usage() {
  cat <<'EOF'
Usage: bash scripts/e2e/parallels-windows-smoke.sh [options]

Options:
  --vm <name>                Parallels VM name. Default: "Windows 11"
  --snapshot-hint <name>     Snapshot name substring/fuzzy match.
                             Default: "pre-openclaw-native-e2e-2026-03-12"
  --mode <fresh|upgrade|both>
  --openai-api-key-env <var> Host env var name for OpenAI API key.
                             Default: OPENAI_API_KEY
  --install-url <url>        Installer URL for latest release. Default: https://openclaw.ai/install.ps1
  --host-port <port>         Host HTTP port for current-main tgz. Default: 18426
  --host-ip <ip>             Override Parallels host IP.
  --latest-version <ver>     Override npm latest version lookup.
  --skip-latest-ref-check    Skip latest-release ref-mode precheck.
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

ps_single_quote() {
  printf "%s" "$1" | sed "s/'/''/g"
}

ps_array_literal() {
  local arg quoted parts=()
  for arg in "$@"; do
    quoted="$(ps_single_quote "$arg")"
    parts+=("'$quoted'")
  done
  local joined=""
  local part
  for part in "${parts[@]}"; do
    if [[ -n "$joined" ]]; then
      joined+=", "
    fi
    joined+="$part"
  done
  printf '@(%s)' "$joined"
}

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
  warn "host port 18426 busy; using $HOST_PORT"
  printf '%s\n' "$HOST_PORT"
}

guest_exec() {
  prlctl exec "$VM_NAME" --current-user "$@"
}

guest_powershell() {
  local script="$1"
  local encoded
  encoded="$(
    SCRIPT_CONTENT="$script" python3 - <<'PY'
import base64
import os

script = "$ProgressPreference = 'SilentlyContinue'\n" + os.environ["SCRIPT_CONTENT"]
payload = script.encode("utf-16le")
print(base64.b64encode(payload).decode("ascii"))
PY
  )"
  guest_exec powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand "$encoded"
}

guest_run_openclaw() {
  local env_name="${1:-}"
  local env_value="${2:-}"
  shift 2

  local args_literal stdout_name stderr_name env_name_q env_value_q
  args_literal="$(ps_array_literal "$@")"
  stdout_name="openclaw-stdout-$RANDOM-$RANDOM.log"
  stderr_name="openclaw-stderr-$RANDOM-$RANDOM.log"
  env_name_q="$(ps_single_quote "$env_name")"
  env_value_q="$(ps_single_quote "$env_value")"

  guest_powershell "$(cat <<EOF
\$stdout = Join-Path \$env:TEMP '$stdout_name'
\$stderr = Join-Path \$env:TEMP '$stderr_name'
try {
  if ('${env_name_q}' -ne '') {
    Set-Item -Path ('Env:' + '${env_name_q}') -Value '${env_value_q}'
  }
  \$proc = Start-Process -FilePath (Join-Path \$env:APPDATA 'npm\openclaw.cmd') -ArgumentList $args_literal -NoNewWindow -PassThru -RedirectStandardOutput \$stdout -RedirectStandardError \$stderr
  \$proc.WaitForExit()
  if (Test-Path \$stdout) {
    Get-Content \$stdout
  }
  if (Test-Path \$stderr) {
    Get-Content \$stderr
  }
  exit \$proc.ExitCode
} finally {
  Remove-Item \$stdout, \$stderr -Force -ErrorAction SilentlyContinue
}
EOF
)"
}

restore_snapshot() {
  local snapshot_id="$1"
  say "Restore snapshot $SNAPSHOT_HINT ($snapshot_id)"
  prlctl snapshot-switch "$VM_NAME" --id "$snapshot_id" >/dev/null
}

verify_windows_user_ready() {
  guest_exec cmd.exe /d /s /c "echo ready"
}

wait_for_guest_ready() {
  local deadline
  deadline=$((SECONDS + TIMEOUT_SNAPSHOT_S))
  while (( SECONDS < deadline )); do
    if verify_windows_user_ready >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  return 1
}

phase_log_path() {
  printf '%s/%s.log\n' "$RUN_DIR" "$1"
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

  local log_path pid rc timed_out
  log_path="$(phase_log_path "$phase_id")"
  say "$phase_id"
  timed_out=0

  (
    "$@"
  ) >"$log_path" 2>&1 &
  pid=$!

  (
    sleep "$timeout_s"
    kill "$pid" >/dev/null 2>&1 || true
    sleep 2
    kill -9 "$pid" >/dev/null 2>&1 || true
  ) &
  local killer_pid=$!

  set +e
  wait "$pid"
  rc=$?
  set -e

  if kill -0 "$killer_pid" >/dev/null 2>&1; then
    kill "$killer_pid" >/dev/null 2>&1 || true
    wait "$killer_pid" >/dev/null 2>&1 || true
  else
    timed_out=1
  fi

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

resolve_latest_version() {
  if [[ -n "$LATEST_VERSION" ]]; then
    printf '%s\n' "$LATEST_VERSION"
    return
  fi
  npm view openclaw version --userconfig "$(mktemp)"
}

resolve_mingit_download() {
  python3 - <<'PY'
import json
import urllib.request

req = urllib.request.Request(
    "https://api.github.com/repos/git-for-windows/git/releases/latest",
    headers={
        "User-Agent": "openclaw-parallels-smoke",
        "Accept": "application/vnd.github+json",
    },
)
with urllib.request.urlopen(req, timeout=30) as response:
    data = json.load(response)

assets = data.get("assets", [])
preferred_names = [
    "MinGit-2.53.0.2-arm64.zip",
    "MinGit-2.53.0.2-64-bit.zip",
]

best = None
for wanted in preferred_names:
    for asset in assets:
      if asset.get("name") == wanted:
        best = asset
        break
    if best:
      break

if best is None:
  for asset in assets:
    name = asset.get("name", "")
    if name.startswith("MinGit-") and name.endswith(".zip") and "busybox" not in name:
      best = asset
      break

if best is None:
  raise SystemExit("no MinGit asset found")

print(best["name"])
print(best["browser_download_url"])
PY
}

current_build_commit() {
  python3 - <<'PY'
import json
import pathlib

path = pathlib.Path("dist/build-info.json")
if not path.exists():
    print("")
else:
    print(json.loads(path.read_text()).get("commit", ""))
PY
}

ensure_current_build() {
  local head build_commit
  head="$(git rev-parse HEAD)"
  build_commit="$(current_build_commit)"
  if [[ "$build_commit" == "$head" ]]; then
    return
  fi
  say "Build dist for current head"
  pnpm build
  build_commit="$(current_build_commit)"
  [[ "$build_commit" == "$head" ]] || die "dist/build-info.json still does not match HEAD after build"
}

ensure_guest_git() {
  local host_ip="$1"
  local mingit_url
  mingit_url="http://$host_ip:$HOST_PORT/$MINGIT_ZIP_NAME"
  if guest_exec cmd.exe /d /s /c "where git.exe >nul 2>nul && git.exe --version"; then
    return
  fi
  guest_exec cmd.exe /d /s /c "if exist \"%LOCALAPPDATA%\\OpenClaw\\deps\\portable-git\" rmdir /s /q \"%LOCALAPPDATA%\\OpenClaw\\deps\\portable-git\""
  guest_exec cmd.exe /d /s /c "mkdir \"%LOCALAPPDATA%\\OpenClaw\\deps\\portable-git\""
  guest_exec cmd.exe /d /s /c "curl.exe -fsSL \"$mingit_url\" -o \"%TEMP%\\$MINGIT_ZIP_NAME\""
  guest_exec cmd.exe /d /s /c "tar.exe -xf \"%TEMP%\\$MINGIT_ZIP_NAME\" -C \"%LOCALAPPDATA%\\OpenClaw\\deps\\portable-git\""
  guest_exec cmd.exe /d /s /c "del /q \"%TEMP%\\$MINGIT_ZIP_NAME\" & set \"PATH=%LOCALAPPDATA%\\OpenClaw\\deps\\portable-git\\cmd;%LOCALAPPDATA%\\OpenClaw\\deps\\portable-git\\mingw64\\bin;%LOCALAPPDATA%\\OpenClaw\\deps\\portable-git\\usr\\bin;%PATH%\" && git.exe --version"
}

pack_main_tgz() {
  say "Pack current main tgz"
  ensure_current_build
  local mingit_name mingit_url
  mapfile -t mingit_meta < <(resolve_mingit_download)
  mingit_name="${mingit_meta[0]}"
  mingit_url="${mingit_meta[1]}"
  MINGIT_ZIP_NAME="$mingit_name"
  MINGIT_ZIP_PATH="$MAIN_TGZ_DIR/$mingit_name"
  if [[ ! -f "$MINGIT_ZIP_PATH" ]]; then
    say "Download $MINGIT_ZIP_NAME"
    curl -fsSL "$mingit_url" -o "$MINGIT_ZIP_PATH"
  fi
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
  local artifact probe_url attempt
  artifact="$(basename "$MAIN_TGZ_PATH")"
  attempt=0
  while :; do
    attempt=$((attempt + 1))
    say "Serve current main tgz on $host_ip:$HOST_PORT"
    (
      cd "$MAIN_TGZ_DIR"
      exec python3 -m http.server "$HOST_PORT" --bind 0.0.0.0
    ) >/tmp/openclaw-parallels-windows-http.log 2>&1 &
    SERVER_PID=$!
    sleep 1
    probe_url="http://127.0.0.1:$HOST_PORT/$artifact"
    if kill -0 "$SERVER_PID" >/dev/null 2>&1 && curl -fsSI "$probe_url" >/dev/null 2>&1; then
      return 0
    fi
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
    SERVER_PID=""
    if [[ "$HOST_PORT_EXPLICIT" -eq 1 || $attempt -ge 3 ]]; then
      die "failed to start reachable host HTTP server on port $HOST_PORT"
    fi
    HOST_PORT="$(allocate_host_port)"
    warn "retrying host HTTP server on port $HOST_PORT"
  done
}

install_latest_release() {
  local install_url_q
  install_url_q="$(ps_single_quote "$INSTALL_URL")"
  guest_powershell "$(cat <<EOF
\$ProgressPreference = 'SilentlyContinue'
\$script = Invoke-RestMethod -Uri '$install_url_q'
& ([scriptblock]::Create(\$script)) -NoOnboard
& (Join-Path \$env:APPDATA 'npm\openclaw.cmd') --version
EOF
)"
}

install_main_tgz() {
  local host_ip="$1"
  local temp_name="$2"
  local tgz_url
  tgz_url="http://$host_ip:$HOST_PORT/$(basename "$MAIN_TGZ_PATH")"
  guest_exec cmd.exe /d /s /c "set \"PATH=%LOCALAPPDATA%\\OpenClaw\\deps\\portable-git\\cmd;%LOCALAPPDATA%\\OpenClaw\\deps\\portable-git\\mingw64\\bin;%LOCALAPPDATA%\\OpenClaw\\deps\\portable-git\\usr\\bin;%PATH%\" && curl.exe -fsSL \"$tgz_url\" -o \"%TEMP%\\$temp_name\" && npm.cmd install -g \"%TEMP%\\$temp_name\" --no-fund --no-audit && \"%APPDATA%\\npm\\openclaw.cmd\" --version"
}

verify_version_contains() {
  local needle="$1"
  local version
  version="$(guest_run_openclaw "" "" "--version")"
  printf '%s\n' "$version"
  case "$version" in
    *"$needle"*) ;;
    *)
      echo "version mismatch: expected substring $needle" >&2
      return 1
      ;;
  esac
}

run_ref_onboard() {
  local openai_key_q runner_name log_name done_name done_status
  openai_key_q="$(ps_single_quote "$OPENAI_API_KEY_VALUE")"
  runner_name="openclaw-onboard-$RANDOM-$RANDOM.ps1"
  log_name="openclaw-onboard-$RANDOM-$RANDOM.log"
  done_name="openclaw-onboard-$RANDOM-$RANDOM.done"

  guest_powershell "$(cat <<EOF
\$runner = Join-Path \$env:TEMP '$runner_name'
\$log = Join-Path \$env:TEMP '$log_name'
\$done = Join-Path \$env:TEMP '$done_name'
Remove-Item \$runner, \$log, \$done -Force -ErrorAction SilentlyContinue
@'
\$ErrorActionPreference = 'Stop'
\$PSNativeCommandUseErrorActionPreference = \$false
\$log = Join-Path \$env:TEMP '$log_name'
\$done = Join-Path \$env:TEMP '$done_name'
\$env:OPENAI_API_KEY = '$openai_key_q'
try {
  \$openclaw = Join-Path \$env:APPDATA 'npm\openclaw.cmd'
  \$cmdLine = ('"{0}" onboard --non-interactive --mode local --auth-choice openai-api-key --secret-input-mode ref --gateway-port 18789 --gateway-bind loopback --install-daemon --skip-skills --accept-risk --json > "{1}" 2>&1' -f \$openclaw, \$log)
  & cmd.exe /d /s /c \$cmdLine
  Set-Content -Path \$done -Value ([string]\$LASTEXITCODE)
} catch {
  if (Test-Path \$log) {
    Add-Content -Path \$log -Value (\$_ | Out-String)
  } else {
    (\$_ | Out-String) | Set-Content -Path \$log
  }
  Set-Content -Path \$done -Value '1'
}
'@ | Set-Content -Path \$runner
Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', \$runner) -WindowStyle Hidden | Out-Null
EOF
)"

  while :; do
    done_status="$(
      guest_powershell "\$done = Join-Path \$env:TEMP '$done_name'; if (Test-Path \$done) { (Get-Content \$done -Raw).Trim() }"
    )"
    done_status="${done_status//$'\r'/}"
    if [[ -n "$done_status" ]]; then
      guest_powershell "\$log = Join-Path \$env:TEMP '$log_name'; if (Test-Path \$log) { Get-Content \$log }"
      [[ "$done_status" == "0" ]]
      return $?
    fi
    sleep 2
  done
}

verify_gateway() {
  guest_run_openclaw "" "" gateway status --deep
}

verify_turn() {
  guest_run_openclaw "" "" agent --agent main --message ping --json
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
  verify_gateway || true
  set -e
  return 1
}

run_fresh_main_lane() {
  local snapshot_id="$1"
  local host_ip="$2"
  phase_run "fresh.restore-snapshot" "$TIMEOUT_SNAPSHOT_S" restore_snapshot "$snapshot_id" || return $?
  phase_run "fresh.wait-for-user" "$TIMEOUT_SNAPSHOT_S" wait_for_guest_ready || return $?
  phase_run "fresh.ensure-git" "$TIMEOUT_INSTALL_S" ensure_guest_git "$host_ip" || return $?
  phase_run "fresh.install-main" "$TIMEOUT_INSTALL_S" install_main_tgz "$host_ip" "openclaw-main-fresh.tgz" || return $?
  FRESH_MAIN_VERSION="$(extract_last_version "$(phase_log_path fresh.install-main)")"
  phase_run "fresh.verify-main-version" "$TIMEOUT_VERIFY_S" verify_version_contains "$(git rev-parse --short=7 HEAD)" || return $?
  phase_run "fresh.onboard-ref" "$TIMEOUT_ONBOARD_S" run_ref_onboard || return $?
  phase_run "fresh.gateway-status" "$TIMEOUT_GATEWAY_S" verify_gateway || return $?
  FRESH_GATEWAY_STATUS="pass"
  phase_run "fresh.first-agent-turn" "$TIMEOUT_AGENT_S" verify_turn || return $?
  FRESH_AGENT_STATUS="pass"
}

run_upgrade_lane() {
  local snapshot_id="$1"
  local host_ip="$2"
  phase_run "upgrade.restore-snapshot" "$TIMEOUT_SNAPSHOT_S" restore_snapshot "$snapshot_id" || return $?
  phase_run "upgrade.wait-for-user" "$TIMEOUT_SNAPSHOT_S" wait_for_guest_ready || return $?
  phase_run "upgrade.install-latest" "$TIMEOUT_INSTALL_S" install_latest_release || return $?
  LATEST_INSTALLED_VERSION="$(extract_last_version "$(phase_log_path upgrade.install-latest)")"
  phase_run "upgrade.verify-latest-version" "$TIMEOUT_VERIFY_S" verify_version_contains "$LATEST_VERSION" || return $?
  if [[ "$CHECK_LATEST_REF" -eq 1 ]]; then
    if phase_run "upgrade.latest-ref-precheck" "$TIMEOUT_ONBOARD_S" capture_latest_ref_failure; then
      UPGRADE_PRECHECK_STATUS="latest-ref-pass"
    else
      UPGRADE_PRECHECK_STATUS="latest-ref-fail"
    fi
  else
    UPGRADE_PRECHECK_STATUS="skipped"
  fi
  phase_run "upgrade.ensure-git" "$TIMEOUT_INSTALL_S" ensure_guest_git "$host_ip" || return $?
  phase_run "upgrade.install-main" "$TIMEOUT_INSTALL_S" install_main_tgz "$host_ip" "openclaw-main-upgrade.tgz" || return $?
  UPGRADE_MAIN_VERSION="$(extract_last_version "$(phase_log_path upgrade.install-main)")"
  phase_run "upgrade.verify-main-version" "$TIMEOUT_VERIFY_S" verify_version_contains "$(git rev-parse --short=7 HEAD)" || return $?
  phase_run "upgrade.onboard-ref" "$TIMEOUT_ONBOARD_S" run_ref_onboard || return $?
  phase_run "upgrade.gateway-status" "$TIMEOUT_GATEWAY_S" verify_gateway || return $?
  UPGRADE_GATEWAY_STATUS="pass"
  phase_run "upgrade.first-agent-turn" "$TIMEOUT_AGENT_S" verify_turn || return $?
  UPGRADE_AGENT_STATUS="pass"
}

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
