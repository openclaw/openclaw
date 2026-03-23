#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

MACOS_VM="macOS Tahoe"
WINDOWS_VM="Windows 11"
LINUX_VM="Ubuntu 25.10"
OPENAI_API_KEY_ENV="OPENAI_API_KEY"
PACKAGE_SPEC=""
JSON_OUTPUT=0
RUN_DIR="$(mktemp -d /tmp/openclaw-parallels-npm-update.XXXXXX)"
MAIN_TGZ_DIR="$(mktemp -d)"
MAIN_TGZ_PATH=""
SERVER_PID=""
HOST_IP=""
HOST_PORT=""
LATEST_VERSION=""
CURRENT_HEAD=""
CURRENT_HEAD_SHORT=""
OPENAI_API_KEY_VALUE=""

MACOS_FRESH_STATUS="skip"
WINDOWS_FRESH_STATUS="skip"
LINUX_FRESH_STATUS="skip"
MACOS_UPDATE_STATUS="skip"
WINDOWS_UPDATE_STATUS="skip"
LINUX_UPDATE_STATUS="skip"
MACOS_UPDATE_VERSION="skip"
WINDOWS_UPDATE_VERSION="skip"
LINUX_UPDATE_VERSION="skip"

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
Usage: bash scripts/e2e/parallels-npm-update-smoke.sh [options]

Options:
  --package-spec <npm-spec>  Baseline npm package spec. Default: openclaw@latest
  --openai-api-key-env <var> Host env var name for OpenAI API key. Default: OPENAI_API_KEY
  --json                     Print machine-readable JSON summary.
  -h, --help                 Show help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --package-spec)
      PACKAGE_SPEC="$2"
      shift 2
      ;;
    --openai-api-key-env)
      OPENAI_API_KEY_ENV="$2"
      shift 2
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

OPENAI_API_KEY_VALUE="${!OPENAI_API_KEY_ENV:-}"
[[ -n "$OPENAI_API_KEY_VALUE" ]] || die "$OPENAI_API_KEY_ENV is required"

resolve_latest_version() {
  npm view openclaw version --userconfig "$(mktemp)"
}

resolve_host_ip() {
  local detected
  detected="$(ifconfig | awk '/inet 10\.211\./ { print $2; exit }')"
  [[ -n "$detected" ]] || die "failed to detect Parallels host IP"
  printf '%s\n' "$detected"
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

ensure_current_build() {
  say "Build dist for current head"
  pnpm build
}

pack_main_tgz() {
  local pkg
  CURRENT_HEAD="$(git rev-parse HEAD)"
  CURRENT_HEAD_SHORT="$(git rev-parse --short=7 HEAD)"
  ensure_current_build
  pkg="$(
    npm pack --ignore-scripts --json --pack-destination "$MAIN_TGZ_DIR" \
      | python3 -c 'import json, sys; data = json.load(sys.stdin); print(data[-1]["filename"])'
  )"
  MAIN_TGZ_PATH="$MAIN_TGZ_DIR/openclaw-main-$CURRENT_HEAD_SHORT.tgz"
  cp "$MAIN_TGZ_DIR/$pkg" "$MAIN_TGZ_PATH"
}

start_server() {
  HOST_IP="$(resolve_host_ip)"
  HOST_PORT="$(allocate_host_port)"
  say "Serve current main tgz on $HOST_IP:$HOST_PORT"
  (
    cd "$MAIN_TGZ_DIR"
    exec python3 -m http.server "$HOST_PORT" --bind 0.0.0.0
  ) >/tmp/openclaw-parallels-npm-update-http.log 2>&1 &
  SERVER_PID=$!
  sleep 1
  kill -0 "$SERVER_PID" >/dev/null 2>&1 || die "failed to start host HTTP server"
}

wait_job() {
  local label="$1"
  local pid="$2"
  if wait "$pid"; then
    return 0
  fi
  warn "$label failed"
  return 1
}

extract_last_version() {
  local log_path="$1"
  python3 - "$log_path" <<'PY'
import pathlib
import re
import sys

text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
matches = re.findall(r"OpenClaw [^\r\n]+", text)
print(matches[-1] if matches else "")
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
  prlctl exec "$WINDOWS_VM" --current-user powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand "$encoded"
}

run_macos_update() {
  local tgz_url="$1"
  local head_short="$2"
  cat <<EOF | prlctl exec "$MACOS_VM" --current-user /usr/bin/tee /tmp/openclaw-main-update.sh >/dev/null
set -euo pipefail
export PATH=/opt/homebrew/bin:/opt/homebrew/opt/node/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin
if [ -z "\${HOME:-}" ]; then export HOME="/Users/\$(id -un)"; fi
cd "\$HOME"
curl -fsSL "$tgz_url" -o /tmp/openclaw-main-update.tgz
/opt/homebrew/bin/npm install -g /tmp/openclaw-main-update.tgz
version="\$(/opt/homebrew/bin/openclaw --version)"
printf '%s\n' "\$version"
case "\$version" in
  *"$head_short"*) ;;
  *)
    echo "version mismatch: expected substring $head_short" >&2
    exit 1
    ;;
esac
/opt/homebrew/bin/openclaw models set openai/gpt-5.4
/opt/homebrew/bin/node /opt/homebrew/lib/node_modules/openclaw/openclaw.mjs gateway status --deep --require-rpc
/opt/homebrew/bin/node /opt/homebrew/lib/node_modules/openclaw/openclaw.mjs agent --agent main --session-id parallels-npm-update-macos-$head_short --message "Reply with exact ASCII text OK only." --json
EOF
  prlctl exec "$MACOS_VM" --current-user /bin/bash /tmp/openclaw-main-update.sh
}

run_windows_update() {
  local tgz_url="$1"
  local head_short="$2"
  guest_powershell "$(cat <<EOF
\$env:PATH = "\$env:LOCALAPPDATA\OpenClaw\deps\portable-git\cmd;\$env:LOCALAPPDATA\OpenClaw\deps\portable-git\mingw64\bin;\$env:LOCALAPPDATA\OpenClaw\deps\portable-git\usr\bin;\$env:PATH"
\$tgz = Join-Path \$env:TEMP 'openclaw-main-update.tgz'
curl.exe -fsSL '$tgz_url' -o \$tgz
npm.cmd install -g \$tgz --no-fund --no-audit
\$openclaw = Join-Path \$env:APPDATA 'npm\openclaw.cmd'
\$version = & \$openclaw --version
\$version
if (\$version -notmatch '$head_short') {
  throw 'version mismatch: expected substring $head_short'
}
& \$openclaw models set openai/gpt-5.4
& \$openclaw gateway status --deep --require-rpc
& \$openclaw agent --agent main --session-id parallels-npm-update-windows-$head_short --message 'Reply with exact ASCII text OK only.' --json
EOF
)"
}

run_linux_update() {
  local tgz_url="$1"
  local head_short="$2"
  cat <<EOF | prlctl exec "$LINUX_VM" /usr/bin/tee /tmp/openclaw-main-update.sh >/dev/null
set -euo pipefail
export HOME=/root
cd "\$HOME"
curl -fsSL "$tgz_url" -o /tmp/openclaw-main-update.tgz
npm install -g /tmp/openclaw-main-update.tgz --no-fund --no-audit
version="\$(openclaw --version)"
printf '%s\n' "\$version"
case "\$version" in
  *"$head_short"*) ;;
  *)
    echo "version mismatch: expected substring $head_short" >&2
    exit 1
    ;;
esac
openclaw models set openai/gpt-5.4
openclaw agent --local --agent main --session-id parallels-npm-update-linux-$head_short --message "Reply with exact ASCII text OK only." --json
EOF
  prlctl exec "$LINUX_VM" /usr/bin/env "OPENAI_API_KEY=$OPENAI_API_KEY_VALUE" /bin/bash /tmp/openclaw-main-update.sh
}

write_summary_json() {
  local summary_path="$RUN_DIR/summary.json"
  python3 - "$summary_path" <<'PY'
import json
import os
import sys

summary = {
    "packageSpec": os.environ["SUMMARY_PACKAGE_SPEC"],
    "latestVersion": os.environ["SUMMARY_LATEST_VERSION"],
    "currentHead": os.environ["SUMMARY_CURRENT_HEAD"],
    "runDir": os.environ["SUMMARY_RUN_DIR"],
    "fresh": {
        "macos": {"status": os.environ["SUMMARY_MACOS_FRESH_STATUS"]},
        "windows": {"status": os.environ["SUMMARY_WINDOWS_FRESH_STATUS"]},
        "linux": {"status": os.environ["SUMMARY_LINUX_FRESH_STATUS"]},
    },
    "update": {
        "macos": {
            "status": os.environ["SUMMARY_MACOS_UPDATE_STATUS"],
            "version": os.environ["SUMMARY_MACOS_UPDATE_VERSION"],
        },
        "windows": {
            "status": os.environ["SUMMARY_WINDOWS_UPDATE_STATUS"],
            "version": os.environ["SUMMARY_WINDOWS_UPDATE_VERSION"],
        },
        "linux": {
            "status": os.environ["SUMMARY_LINUX_UPDATE_STATUS"],
            "version": os.environ["SUMMARY_LINUX_UPDATE_VERSION"],
            "mode": "local-with-openai-env",
        },
    },
}
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(summary, handle, indent=2, sort_keys=True)
print(sys.argv[1])
PY
}

LATEST_VERSION="$(resolve_latest_version)"
if [[ -z "$PACKAGE_SPEC" ]]; then
  PACKAGE_SPEC="openclaw@$LATEST_VERSION"
fi

say "Run fresh npm baseline: $PACKAGE_SPEC"
bash "$ROOT_DIR/scripts/e2e/parallels-macos-smoke.sh" \
  --mode fresh \
  --target-package-spec "$PACKAGE_SPEC" \
  --json >"$RUN_DIR/macos-fresh.log" 2>&1 &
macos_fresh_pid=$!

bash "$ROOT_DIR/scripts/e2e/parallels-windows-smoke.sh" \
  --mode fresh \
  --target-package-spec "$PACKAGE_SPEC" \
  --json >"$RUN_DIR/windows-fresh.log" 2>&1 &
windows_fresh_pid=$!

bash "$ROOT_DIR/scripts/e2e/parallels-linux-smoke.sh" \
  --mode fresh \
  --target-package-spec "$PACKAGE_SPEC" \
  --json >"$RUN_DIR/linux-fresh.log" 2>&1 &
linux_fresh_pid=$!

wait_job "macOS fresh" "$macos_fresh_pid" && MACOS_FRESH_STATUS="pass" || MACOS_FRESH_STATUS="fail"
wait_job "Windows fresh" "$windows_fresh_pid" && WINDOWS_FRESH_STATUS="pass" || WINDOWS_FRESH_STATUS="fail"
wait_job "Linux fresh" "$linux_fresh_pid" && LINUX_FRESH_STATUS="pass" || LINUX_FRESH_STATUS="fail"

[[ "$MACOS_FRESH_STATUS" == "pass" ]] || die "macOS fresh baseline failed"
[[ "$WINDOWS_FRESH_STATUS" == "pass" ]] || die "Windows fresh baseline failed"
[[ "$LINUX_FRESH_STATUS" == "pass" ]] || die "Linux fresh baseline failed"

pack_main_tgz
start_server

tgz_url="http://$HOST_IP:$HOST_PORT/$(basename "$MAIN_TGZ_PATH")"

say "Run same-guest update to current main"
run_macos_update "$tgz_url" "$CURRENT_HEAD_SHORT" >"$RUN_DIR/macos-update.log" 2>&1 &
macos_update_pid=$!
run_windows_update "$tgz_url" "$CURRENT_HEAD_SHORT" >"$RUN_DIR/windows-update.log" 2>&1 &
windows_update_pid=$!
run_linux_update "$tgz_url" "$CURRENT_HEAD_SHORT" >"$RUN_DIR/linux-update.log" 2>&1 &
linux_update_pid=$!

wait_job "macOS update" "$macos_update_pid" && MACOS_UPDATE_STATUS="pass" || MACOS_UPDATE_STATUS="fail"
wait_job "Windows update" "$windows_update_pid" && WINDOWS_UPDATE_STATUS="pass" || WINDOWS_UPDATE_STATUS="fail"
wait_job "Linux update" "$linux_update_pid" && LINUX_UPDATE_STATUS="pass" || LINUX_UPDATE_STATUS="fail"

[[ "$MACOS_UPDATE_STATUS" == "pass" ]] || die "macOS update failed"
[[ "$WINDOWS_UPDATE_STATUS" == "pass" ]] || die "Windows update failed"
[[ "$LINUX_UPDATE_STATUS" == "pass" ]] || die "Linux update failed"

MACOS_UPDATE_VERSION="$(extract_last_version "$RUN_DIR/macos-update.log")"
WINDOWS_UPDATE_VERSION="$(extract_last_version "$RUN_DIR/windows-update.log")"
LINUX_UPDATE_VERSION="$(extract_last_version "$RUN_DIR/linux-update.log")"

SUMMARY_PACKAGE_SPEC="$PACKAGE_SPEC" \
SUMMARY_LATEST_VERSION="$LATEST_VERSION" \
SUMMARY_CURRENT_HEAD="$CURRENT_HEAD_SHORT" \
SUMMARY_RUN_DIR="$RUN_DIR" \
SUMMARY_MACOS_FRESH_STATUS="$MACOS_FRESH_STATUS" \
SUMMARY_WINDOWS_FRESH_STATUS="$WINDOWS_FRESH_STATUS" \
SUMMARY_LINUX_FRESH_STATUS="$LINUX_FRESH_STATUS" \
SUMMARY_MACOS_UPDATE_STATUS="$MACOS_UPDATE_STATUS" \
SUMMARY_WINDOWS_UPDATE_STATUS="$WINDOWS_UPDATE_STATUS" \
SUMMARY_LINUX_UPDATE_STATUS="$LINUX_UPDATE_STATUS" \
SUMMARY_MACOS_UPDATE_VERSION="$MACOS_UPDATE_VERSION" \
SUMMARY_WINDOWS_UPDATE_VERSION="$WINDOWS_UPDATE_VERSION" \
SUMMARY_LINUX_UPDATE_VERSION="$LINUX_UPDATE_VERSION" \
write_summary_json >/dev/null

if [[ "$JSON_OUTPUT" -eq 1 ]]; then
  cat "$RUN_DIR/summary.json"
else
  say "Run dir: $RUN_DIR"
  cat "$RUN_DIR/summary.json"
fi
