#!/usr/bin/env bash
set -euo pipefail

VM_NAME="Windows 11"
SNAPSHOT_HINT="pre-openclaw-native-e2e-2026-03-12"
MODE="both"
PROVIDER="openai"
API_KEY_ENV=""
AUTH_CHOICE=""
AUTH_KEY_FLAG=""
MODEL_ID=""
INSTALL_URL="https://openclaw.ai/install.ps1"
HOST_PORT="18426"
HOST_PORT_EXPLICIT=0
HOST_IP=""
LATEST_VERSION=""
INSTALL_VERSION=""
TARGET_PACKAGE_SPEC=""
JSON_OUTPUT=0
KEEP_SERVER=0
CHECK_LATEST_REF=1
SNAPSHOT_ID=""
SNAPSHOT_STATE=""
SNAPSHOT_NAME=""

MAIN_TGZ_DIR="$(mktemp -d)"
MAIN_TGZ_PATH=""
MINGIT_ZIP_PATH=""
MINGIT_ZIP_NAME=""
WINDOWS_ONBOARD_SCRIPT_PATH=""
SERVER_PID=""
RUN_DIR="$(mktemp -d /tmp/openclaw-parallels-windows.XXXXXX)"
BUILD_LOCK_DIR="${TMPDIR:-/tmp}/openclaw-parallels-build.lock"

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

artifact_label() {
  if [[ -n "$TARGET_PACKAGE_SPEC" ]]; then
    printf 'target package tgz'
    return
  fi
  printf 'current main tgz'
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
  --provider <openai|anthropic|minimax>
                             Provider auth/model lane. Default: openai
  --api-key-env <var>        Host env var name for provider API key.
                             Default: OPENAI_API_KEY for openai, ANTHROPIC_API_KEY for anthropic
  --openai-api-key-env <var> Alias for --api-key-env (backward compatible)
  --install-url <url>        Installer URL for latest release. Default: https://openclaw.ai/install.ps1
  --host-port <port>         Host HTTP port for current-main tgz. Default: 18426
  --host-ip <ip>             Override Parallels host IP.
  --latest-version <ver>     Override npm latest version lookup.
  --install-version <ver>    Pin site-installer version/dist-tag for the baseline lane.
  --target-package-spec <npm-spec>
                             Install this npm package tarball instead of packing current main.
                             Example: openclaw@2026.3.13-beta.1
  --skip-latest-ref-check    Skip latest-release ref-mode precheck.
  --keep-server              Leave temp host HTTP server running.
  --json                     Print machine-readable JSON summary.
  -h, --help                 Show help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
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
    --provider)
      PROVIDER="$2"
      shift 2
      ;;
    --api-key-env|--openai-api-key-env)
      API_KEY_ENV="$2"
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
    --install-version)
      INSTALL_VERSION="$2"
      shift 2
      ;;
    --target-package-spec)
      TARGET_PACKAGE_SPEC="$2"
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

case "$PROVIDER" in
  openai)
    AUTH_CHOICE="openai-api-key"
    AUTH_KEY_FLAG="openai-api-key"
    MODEL_ID="openai/gpt-5.4"
    [[ -n "$API_KEY_ENV" ]] || API_KEY_ENV="OPENAI_API_KEY"
    ;;
  anthropic)
    AUTH_CHOICE="apiKey"
    AUTH_KEY_FLAG="anthropic-api-key"
    MODEL_ID="anthropic/claude-sonnet-4-6"
    [[ -n "$API_KEY_ENV" ]] || API_KEY_ENV="ANTHROPIC_API_KEY"
    ;;
  minimax)
    AUTH_CHOICE="minimax-global-api"
    AUTH_KEY_FLAG="minimax-api-key"
    MODEL_ID="minimax/MiniMax-M2.7"
    [[ -n "$API_KEY_ENV" ]] || API_KEY_ENV="MINIMAX_API_KEY"
    ;;
  *)
    die "invalid --provider: $PROVIDER"
    ;;
esac

API_KEY_VALUE="${!API_KEY_ENV:-}"
[[ -n "$API_KEY_VALUE" ]] || die "$API_KEY_ENV is required"

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

resolve_snapshot_info() {
  local json hint
  json="$(prlctl snapshot-list "$VM_NAME" --json)"
  hint="$SNAPSHOT_HINT"
  SNAPSHOT_JSON="$json" SNAPSHOT_HINT="$hint" python3 - <<'PY'
import difflib
import json
import os
import re
import sys

payload = json.loads(os.environ["SNAPSHOT_JSON"])
hint = os.environ["SNAPSHOT_HINT"].strip().lower()
best_id = None
best_meta = None
best_score = -1.0

def aliases(name: str) -> list[str]:
    values = [name]
    for pattern in (
        r"^(.*)-poweroff$",
        r"^(.*)-poweroff-\d{4}-\d{2}-\d{2}$",
    ):
        match = re.match(pattern, name)
        if match:
            values.append(match.group(1))
    return values

for snapshot_id, meta in payload.items():
    name = str(meta.get("name", "")).strip()
    lowered = name.lower()
    score = 0.0
    for alias in aliases(lowered):
        if alias == hint:
            score = max(score, 10.0)
        elif hint and hint in alias:
            score = max(score, 5.0 + len(hint) / max(len(alias), 1))
        else:
            score = max(score, difflib.SequenceMatcher(None, hint, alias).ratio())
    if str(meta.get("state", "")).lower() == "poweroff":
        score += 0.5
    if score > best_score:
        best_score = score
        best_id = snapshot_id
        best_meta = meta
if not best_id:
    sys.exit("no snapshot matched")
print(
    "\t".join(
        [
            best_id,
            str(best_meta.get("state", "")).strip(),
            str(best_meta.get("name", "")).strip(),
        ]
    )
)
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

host_timeout_exec() {
  local timeout_s="$1"
  shift
  HOST_TIMEOUT_S="$timeout_s" python3 - "$@" <<'PY'
import os
import subprocess
import sys

timeout = int(os.environ["HOST_TIMEOUT_S"])
args = sys.argv[1:]

try:
    completed = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
except subprocess.TimeoutExpired as exc:
    if exc.stdout:
        sys.stdout.buffer.write(exc.stdout)
    if exc.stderr:
        sys.stderr.buffer.write(exc.stderr)
    sys.stderr.write(f"host timeout after {timeout}s\n")
    raise SystemExit(124)

if completed.stdout:
    sys.stdout.buffer.write(completed.stdout)
if completed.stderr:
    sys.stderr.buffer.write(completed.stderr)
raise SystemExit(completed.returncode)
PY
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

guest_powershell_poll() {
  local timeout_s="$1"
  local script="$2"
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
  host_timeout_exec "$timeout_s" prlctl exec "$VM_NAME" --current-user powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand "$encoded"
}

guest_run_openclaw() {
  local env_name="${1:-}"
  local env_value="${2:-}"
  shift 2

  local args_literal env_name_q env_value_q
  args_literal="$(ps_array_literal "$@")"
  env_name_q="$(ps_single_quote "$env_name")"
  env_value_q="$(ps_single_quote "$env_value")"

  guest_powershell "$(cat <<EOF
\$openclaw = Join-Path \$env:APPDATA 'npm\openclaw.cmd'
\$args = $args_literal
if ('${env_name_q}' -ne '') {
  Set-Item -Path ('Env:' + '${env_name_q}') -Value '${env_value_q}'
}
# openclaw.cmd preserves multi-word --message args reliably here; Start-Process
# against the shim can re-split argv and make Commander reject the turn.
\$output = & \$openclaw @args 2>&1
if (\$null -ne \$output) {
  \$output | ForEach-Object { \$_ }
}
exit \$LASTEXITCODE
EOF
)"
}

run_windows_retry() {
  local label="$1"
  local max_attempts="$2"
  shift 2

  local attempt rc
  rc=0
  for (( attempt = 1; attempt <= max_attempts; attempt++ )); do
    printf '%s attempt %d/%d\n' "$label" "$attempt" "$max_attempts"
    set +e
    "$@"
    rc=$?
    set -e
    if [[ $rc -eq 0 ]]; then
      return 0
    fi
    warn "$label attempt $attempt failed (rc=$rc)"
    if (( attempt < max_attempts )); then
      wait_for_guest_ready >/dev/null 2>&1 || true
      sleep 5
    fi
  done
  return "$rc"
}

restore_snapshot() {
  local snapshot_id="$1"
  say "Restore snapshot $SNAPSHOT_HINT ($snapshot_id)"
  prlctl snapshot-switch "$VM_NAME" --id "$snapshot_id" >/dev/null
  if [[ "$SNAPSHOT_STATE" == "poweroff" ]]; then
    wait_for_vm_status "stopped" || die "restored poweroff snapshot did not reach stopped state in $VM_NAME"
    say "Start restored poweroff snapshot $SNAPSHOT_NAME"
    prlctl start "$VM_NAME" >/dev/null
  fi
}

verify_windows_user_ready() {
  guest_exec cmd.exe /d /s /c "echo ready"
}

wait_for_vm_status() {
  local expected="$1"
  local deadline status
  deadline=$((SECONDS + TIMEOUT_SNAPSHOT_S))
  while (( SECONDS < deadline )); do
    status="$(prlctl status "$VM_NAME" 2>/dev/null || true)"
    if [[ "$status" == *" $expected" ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
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
    "provider": os.environ["SUMMARY_PROVIDER"],
    "latestVersion": os.environ["SUMMARY_LATEST_VERSION"],
    "installVersion": os.environ["SUMMARY_INSTALL_VERSION"],
    "targetPackageSpec": os.environ["SUMMARY_TARGET_PACKAGE_SPEC"],
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

acquire_build_lock() {
  local owner_pid=""
  while ! mkdir "$BUILD_LOCK_DIR" 2>/dev/null; do
    if [[ -f "$BUILD_LOCK_DIR/pid" ]]; then
      owner_pid="$(cat "$BUILD_LOCK_DIR/pid" 2>/dev/null || true)"
      if [[ -n "$owner_pid" ]] && ! kill -0 "$owner_pid" >/dev/null 2>&1; then
        warn "Removing stale Parallels build lock"
        rm -rf "$BUILD_LOCK_DIR"
        continue
      fi
    fi
    sleep 1
  done
  printf '%s\n' "$$" >"$BUILD_LOCK_DIR/pid"
}

release_build_lock() {
  if [[ -d "$BUILD_LOCK_DIR" ]]; then
    rm -rf "$BUILD_LOCK_DIR"
  fi
}

ensure_current_build() {
  local head build_commit
  acquire_build_lock
  head="$(git rev-parse HEAD)"
  build_commit="$(current_build_commit)"
  if [[ "$build_commit" == "$head" ]]; then
    release_build_lock
    return
  fi
  say "Build dist for current head"
  pnpm build
  build_commit="$(current_build_commit)"
  release_build_lock
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
  guest_exec cmd.exe /d /s /c "if not exist \"%LOCALAPPDATA%\\OpenClaw\\deps\" mkdir \"%LOCALAPPDATA%\\OpenClaw\\deps\""
  guest_exec cmd.exe /d /s /c "mkdir \"%LOCALAPPDATA%\\OpenClaw\\deps\\portable-git\""
  guest_exec cmd.exe /d /s /c "curl.exe -fsSL \"$mingit_url\" -o \"%TEMP%\\$MINGIT_ZIP_NAME\""
  guest_exec cmd.exe /d /s /c "tar.exe -xf \"%TEMP%\\$MINGIT_ZIP_NAME\" -C \"%LOCALAPPDATA%\\OpenClaw\\deps\\portable-git\""
  guest_exec cmd.exe /d /s /c "del /q \"%TEMP%\\$MINGIT_ZIP_NAME\" & set \"PATH=%LOCALAPPDATA%\\OpenClaw\\deps\\portable-git\\cmd;%LOCALAPPDATA%\\OpenClaw\\deps\\portable-git\\mingw64\\bin;%LOCALAPPDATA%\\OpenClaw\\deps\\portable-git\\usr\\bin;%PATH%\" && git.exe --version"
}

pack_main_tgz() {
  local mingit_name mingit_url short_head pkg
  if [[ -n "$TARGET_PACKAGE_SPEC" ]]; then
    say "Pack target package tgz: $TARGET_PACKAGE_SPEC"
    mapfile -t mingit_meta < <(resolve_mingit_download)
    mingit_name="${mingit_meta[0]}"
    mingit_url="${mingit_meta[1]}"
    MINGIT_ZIP_NAME="$mingit_name"
    MINGIT_ZIP_PATH="$MAIN_TGZ_DIR/$mingit_name"
    if [[ ! -f "$MINGIT_ZIP_PATH" ]]; then
      say "Download $MINGIT_ZIP_NAME"
      curl -fsSL "$mingit_url" -o "$MINGIT_ZIP_PATH"
    fi
    pkg="$(
      npm pack "$TARGET_PACKAGE_SPEC" --ignore-scripts --json --pack-destination "$MAIN_TGZ_DIR" \
        | python3 -c 'import json, sys; data = json.load(sys.stdin); print(data[-1]["filename"])'
    )"
    MAIN_TGZ_PATH="$MAIN_TGZ_DIR/$(basename "$pkg")"
    TARGET_EXPECT_VERSION="$(tar -xOf "$MAIN_TGZ_PATH" package/package.json | python3 -c "import json, sys; print(json.load(sys.stdin)['version'])")"
    say "Packed $MAIN_TGZ_PATH"
    say "Target package version: $TARGET_EXPECT_VERSION"
    return
  fi
  say "Pack current main tgz"
  ensure_current_build
  mapfile -t mingit_meta < <(resolve_mingit_download)
  mingit_name="${mingit_meta[0]}"
  mingit_url="${mingit_meta[1]}"
  MINGIT_ZIP_NAME="$mingit_name"
  MINGIT_ZIP_PATH="$MAIN_TGZ_DIR/$mingit_name"
  if [[ ! -f "$MINGIT_ZIP_PATH" ]]; then
    say "Download $MINGIT_ZIP_NAME"
    curl -fsSL "$mingit_url" -o "$MINGIT_ZIP_PATH"
  fi
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

verify_target_version() {
  if [[ -n "$TARGET_PACKAGE_SPEC" ]]; then
    verify_version_contains "$TARGET_EXPECT_VERSION"
    return
  fi
  verify_version_contains "$(git rev-parse --short=7 HEAD)"
}

start_server() {
  local host_ip="$1"
  local artifact probe_url attempt
  artifact="$(basename "$MAIN_TGZ_PATH")"
  attempt=0
  while :; do
    attempt=$((attempt + 1))
    say "Serve $(artifact_label) on $host_ip:$HOST_PORT"
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
  local install_url_q version_flag_q
  install_url_q="$(ps_single_quote "$INSTALL_URL")"
  version_flag_q=""
  if [[ -n "$INSTALL_VERSION" ]]; then
    version_flag_q="-Tag '$(ps_single_quote "$INSTALL_VERSION")' "
  fi
  local install_script
  install_script="$(cat <<EOF
\$ProgressPreference = 'SilentlyContinue'
\$script = Invoke-RestMethod -Uri '$install_url_q'
& ([scriptblock]::Create(\$script)) ${version_flag_q}-NoOnboard
& (Join-Path \$env:APPDATA 'npm\openclaw.cmd') --version
EOF
)"
  run_windows_retry "latest release installer" 2 guest_powershell "$install_script"
}

install_main_tgz() {
  local host_ip="$1"
  local temp_name="$2"
  local tgz_url
  tgz_url="http://$host_ip:$HOST_PORT/$(basename "$MAIN_TGZ_PATH")"
  # Global npm installs on the Windows guest can stay silent for long stretches.
  # Treat the phase log plus retry wrapper as the primary signal before assuming
  # the guest hung.
  run_windows_retry "main tgz install" 2 \
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

write_onboard_runner_script() {
  WINDOWS_ONBOARD_SCRIPT_PATH="$MAIN_TGZ_DIR/openclaw-onboard-$PROVIDER.ps1"
  cat >"$WINDOWS_ONBOARD_SCRIPT_PATH" <<EOF
param(
  [Parameter(Mandatory = \$true)][string]\$LogPath,
  [Parameter(Mandatory = \$true)][string]\$DonePath
)

\$ErrorActionPreference = 'Stop'
\$PSNativeCommandUseErrorActionPreference = \$false

try {
  \$openclaw = Join-Path \$env:APPDATA 'npm\openclaw.cmd'
  \$cmdLine = ('"{0}" onboard --non-interactive --mode local --auth-choice ${AUTH_CHOICE} --secret-input-mode ref --gateway-port 18789 --gateway-bind loopback --install-daemon --skip-skills --accept-risk --json > "{1}" 2>&1' -f \$openclaw, \$LogPath)
  & cmd.exe /d /s /c \$cmdLine
  Set-Content -Path \$DonePath -Value ([string]\$LASTEXITCODE)
} catch {
  if (Test-Path \$LogPath) {
    Add-Content -Path \$LogPath -Value (\$_ | Out-String)
  } else {
    (\$_ | Out-String) | Set-Content -Path \$LogPath
  }
  Set-Content -Path \$DonePath -Value '1'
}
EOF
}

run_ref_onboard() {
  local api_key_env_q api_key_value_q script_url
  local runner_name log_name done_name done_status launcher_state
  local poll_rc state_rc log_rc start_seconds poll_deadline startup_checked
  api_key_env_q="$(ps_single_quote "$API_KEY_ENV")"
  api_key_value_q="$(ps_single_quote "$API_KEY_VALUE")"
  write_onboard_runner_script
  script_url="http://$HOST_IP:$HOST_PORT/$(basename "$WINDOWS_ONBOARD_SCRIPT_PATH")"
  runner_name="openclaw-onboard-$RANDOM-$RANDOM.ps1"
  log_name="openclaw-onboard-$RANDOM-$RANDOM.log"
  done_name="openclaw-onboard-$RANDOM-$RANDOM.done"
  start_seconds="$SECONDS"
  poll_deadline=$((SECONDS + TIMEOUT_ONBOARD_S + 60))
  startup_checked=0

  guest_powershell "$(cat <<EOF
\$runner = Join-Path \$env:TEMP '$runner_name'
\$log = Join-Path \$env:TEMP '$log_name'
\$done = Join-Path \$env:TEMP '$done_name'
Remove-Item \$runner, \$log, \$done -Force -ErrorAction SilentlyContinue
Set-Item -Path ('Env:' + '${api_key_env_q}') -Value '${api_key_value_q}'
curl.exe -fsSL '$script_url' -o \$runner
Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', \$runner, '-LogPath', \$log, '-DonePath', \$done) -WindowStyle Hidden | Out-Null
EOF
)"

  while :; do
    set +e
    done_status="$(
      guest_powershell_poll 20 "\$done = Join-Path \$env:TEMP '$done_name'; if (Test-Path \$done) { (Get-Content \$done -Raw).Trim() }"
    )"
    poll_rc=$?
    set -e
    done_status="${done_status//$'\r'/}"
    if [[ $poll_rc -ne 0 ]]; then
      warn "windows onboard helper poll failed; retrying"
      if (( SECONDS >= poll_deadline )); then
        warn "windows onboard helper timed out while polling done file"
        return 1
      fi
      sleep 2
      continue
    fi
    if [[ -n "$done_status" ]]; then
      set +e
      guest_powershell_poll 20 "\$log = Join-Path \$env:TEMP '$log_name'; if (Test-Path \$log) { Get-Content \$log }"
      log_rc=$?
      set -e
      if [[ $log_rc -ne 0 ]]; then
        warn "windows onboard helper log drain failed after completion"
      fi
      [[ "$done_status" == "0" ]]
      return $?
    fi
    if [[ "$startup_checked" -eq 0 && $((SECONDS - start_seconds)) -ge 20 ]]; then
      set +e
      launcher_state="$(
        guest_powershell_poll 20 "\$runner = Join-Path \$env:TEMP '$runner_name'; \$log = Join-Path \$env:TEMP '$log_name'; \$done = Join-Path \$env:TEMP '$done_name'; 'runner=' + (Test-Path \$runner) + ' log=' + (Test-Path \$log) + ' done=' + (Test-Path \$done)"
      )"
      state_rc=$?
      set -e
      launcher_state="${launcher_state//$'\r'/}"
      startup_checked=1
      if [[ $state_rc -eq 0 && "$launcher_state" == *"runner=False"* && "$launcher_state" == *"log=False"* && "$launcher_state" == *"done=False"* ]]; then
        warn "windows onboard helper failed to materialize guest files"
        return 1
      fi
    fi
    if (( SECONDS >= poll_deadline )); then
      set +e
      guest_powershell_poll 20 "\$log = Join-Path \$env:TEMP '$log_name'; if (Test-Path \$log) { Get-Content \$log }"
      log_rc=$?
      set -e
      if [[ $log_rc -ne 0 ]]; then
        warn "windows onboard helper log drain failed after timeout"
      fi
      warn "windows onboard helper timed out waiting for done file"
      return 1
    fi
    sleep 2
  done
}

verify_gateway() {
  guest_run_openclaw "" "" gateway status --deep --require-rpc
}

restart_gateway() {
  local runner_name log_name done_name done_status launcher_state
  local poll_rc state_rc log_rc start_seconds poll_deadline startup_checked
  runner_name="openclaw-gateway-restart-$RANDOM-$RANDOM.ps1"
  log_name="openclaw-gateway-restart-$RANDOM-$RANDOM.log"
  done_name="openclaw-gateway-restart-$RANDOM-$RANDOM.done"
  start_seconds="$SECONDS"
  poll_deadline=$((SECONDS + TIMEOUT_GATEWAY_S + 60))
  startup_checked=0

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
try {
  \$openclaw = Join-Path \$env:APPDATA 'npm\openclaw.cmd'
  & \$openclaw gateway restart *>&1 | Tee-Object -FilePath \$log -Append | Out-Null
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
    set +e
    done_status="$(
      guest_powershell_poll 20 "\$done = Join-Path \$env:TEMP '$done_name'; if (Test-Path \$done) { (Get-Content \$done -Raw).Trim() }"
    )"
    poll_rc=$?
    set -e
    done_status="${done_status//$'\r'/}"
    if [[ $poll_rc -ne 0 ]]; then
      warn "windows gateway restart helper poll failed; retrying"
      if (( SECONDS >= poll_deadline )); then
        warn "windows gateway restart helper timed out while polling done file"
        return 1
      fi
      sleep 2
      continue
    fi
    if [[ -n "$done_status" ]]; then
      set +e
      guest_powershell_poll 20 "\$log = Join-Path \$env:TEMP '$log_name'; if (Test-Path \$log) { Get-Content \$log }"
      log_rc=$?
      set -e
      if [[ $log_rc -ne 0 ]]; then
        warn "windows gateway restart helper log drain failed after completion"
      fi
      [[ "$done_status" == "0" ]]
      return $?
    fi
    if [[ "$startup_checked" -eq 0 && $((SECONDS - start_seconds)) -ge 20 ]]; then
      set +e
      launcher_state="$(
        guest_powershell_poll 20 "\$runner = Join-Path \$env:TEMP '$runner_name'; \$log = Join-Path \$env:TEMP '$log_name'; \$done = Join-Path \$env:TEMP '$done_name'; 'runner=' + (Test-Path \$runner) + ' log=' + (Test-Path \$log) + ' done=' + (Test-Path \$done)"
      )"
      state_rc=$?
      set -e
      launcher_state="${launcher_state//$'\r'/}"
      startup_checked=1
      if [[ $state_rc -eq 0 && "$launcher_state" == *"runner=False"* && "$launcher_state" == *"log=False"* && "$launcher_state" == *"done=False"* ]]; then
        warn "windows gateway restart helper failed to materialize guest files"
        return 1
      fi
    fi
    if (( SECONDS >= poll_deadline )); then
      set +e
      guest_powershell_poll 20 "\$log = Join-Path \$env:TEMP '$log_name'; if (Test-Path \$log) { Get-Content \$log }"
      log_rc=$?
      set -e
      if [[ $log_rc -ne 0 ]]; then
        warn "windows gateway restart helper log drain failed after timeout"
      fi
      warn "windows gateway restart helper timed out waiting for done file"
      return 1
    fi
    sleep 2
  done
}

show_gateway_status_compat() {
  if guest_run_openclaw "" "" gateway status --help | grep -Fq -- "--require-rpc"; then
    guest_run_openclaw "" "" gateway status --deep --require-rpc
    return
  fi
  guest_run_openclaw "" "" gateway status --deep
}

verify_turn() {
  guest_run_openclaw "" "" models set "$MODEL_ID"
  guest_run_openclaw "$API_KEY_ENV" "$API_KEY_VALUE" \
    agent --agent main --message "Reply with exact ASCII text OK only." --json
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
  show_gateway_status_compat || true
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
  phase_run "fresh.verify-main-version" "$TIMEOUT_VERIFY_S" verify_target_version || return $?
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
  phase_run "upgrade.verify-main-version" "$TIMEOUT_VERIFY_S" verify_target_version || return $?
  phase_run "upgrade.gateway-restart" "$TIMEOUT_GATEWAY_S" restart_gateway || return $?
  phase_run "upgrade.onboard-ref" "$TIMEOUT_ONBOARD_S" run_ref_onboard || return $?
  phase_run "upgrade.gateway-status" "$TIMEOUT_GATEWAY_S" verify_gateway || return $?
  UPGRADE_GATEWAY_STATUS="pass"
  phase_run "upgrade.first-agent-turn" "$TIMEOUT_AGENT_S" verify_turn || return $?
  UPGRADE_AGENT_STATUS="pass"
}

IFS=$'\t' read -r SNAPSHOT_ID SNAPSHOT_STATE SNAPSHOT_NAME <<<"$(resolve_snapshot_info)"
[[ -n "$SNAPSHOT_ID" ]] || die "failed to resolve snapshot id"
[[ -n "$SNAPSHOT_NAME" ]] || SNAPSHOT_NAME="$SNAPSHOT_HINT"
LATEST_VERSION="$(resolve_latest_version)"
HOST_IP="$(resolve_host_ip)"
HOST_PORT="$(resolve_host_port)"

say "VM: $VM_NAME"
say "Snapshot hint: $SNAPSHOT_HINT"
say "Resolved snapshot: $SNAPSHOT_NAME [$SNAPSHOT_STATE]"
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
  SUMMARY_PROVIDER="$PROVIDER" \
  SUMMARY_LATEST_VERSION="$LATEST_VERSION" \
  SUMMARY_INSTALL_VERSION="$INSTALL_VERSION" \
  SUMMARY_TARGET_PACKAGE_SPEC="$TARGET_PACKAGE_SPEC" \
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
  if [[ -n "$TARGET_PACKAGE_SPEC" ]]; then
    printf '  target-package: %s\n' "$TARGET_PACKAGE_SPEC"
  fi
  if [[ -n "$INSTALL_VERSION" ]]; then
    printf '  baseline-install-version: %s\n' "$INSTALL_VERSION"
  fi
  printf '  fresh-main: %s (%s)\n' "$FRESH_MAIN_STATUS" "$FRESH_MAIN_VERSION"
  printf '  latest->main precheck: %s (%s)\n' "$UPGRADE_PRECHECK_STATUS" "$LATEST_INSTALLED_VERSION"
  printf '  latest->main: %s (%s)\n' "$UPGRADE_STATUS" "$UPGRADE_MAIN_VERSION"
  printf '  logs: %s\n' "$RUN_DIR"
  printf '  summary: %s\n' "$SUMMARY_JSON_PATH"
fi

if [[ "$FRESH_MAIN_STATUS" == "fail" || "$UPGRADE_STATUS" == "fail" ]]; then
  exit 1
fi
