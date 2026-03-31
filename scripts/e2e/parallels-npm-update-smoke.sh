#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

MACOS_VM="macOS Tahoe"
WINDOWS_VM="Windows 11"
LINUX_VM="Ubuntu 24.04.3 ARM64"
PROVIDER="openai"
API_KEY_ENV=""
AUTH_CHOICE=""
AUTH_KEY_FLAG=""
MODEL_ID=""
PACKAGE_SPEC=""
JSON_OUTPUT=0
RUN_DIR="$(mktemp -d /tmp/openclaw-parallels-npm-update.XXXXXX)"
MAIN_TGZ_DIR="$(mktemp -d)"
MAIN_TGZ_PATH=""
WINDOWS_UPDATE_SCRIPT_PATH=""
SERVER_PID=""
HOST_IP=""
HOST_PORT=""
LATEST_VERSION=""
CURRENT_HEAD=""
CURRENT_HEAD_SHORT=""
API_KEY_VALUE=""

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
  --provider <openai|anthropic|minimax>
                             Provider auth/model lane. Default: openai
  --api-key-env <var>        Host env var name for provider API key.
                             Default: OPENAI_API_KEY for openai, ANTHROPIC_API_KEY for anthropic
  --openai-api-key-env <var> Alias for --api-key-env (backward compatible)
  --json                     Print machine-readable JSON summary.
  -h, --help                 Show help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    --package-spec)
      PACKAGE_SPEC="$2"
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

resolve_linux_vm_name() {
  local json requested
  json="$(prlctl list --all --json)"
  requested="$LINUX_VM"
  PRL_VM_JSON="$json" REQUESTED_VM_NAME="$requested" python3 - <<'PY'
import difflib
import json
import os
import sys

payload = json.loads(os.environ["PRL_VM_JSON"])
requested = os.environ["REQUESTED_VM_NAME"].strip()
requested_lower = requested.lower()
names = [str(item.get("name", "")).strip() for item in payload if str(item.get("name", "")).strip()]

if requested in names:
    print(requested)
    raise SystemExit(0)

ubuntu_names = [name for name in names if "ubuntu" in name.lower()]
if not ubuntu_names:
    sys.exit(f"default vm not found and no Ubuntu fallback available: {requested}")

best_name = max(
    ubuntu_names,
    key=lambda name: difflib.SequenceMatcher(None, requested_lower, name.lower()).ratio(),
)
print(best_name)
PY
}

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

write_windows_update_script() {
  WINDOWS_UPDATE_SCRIPT_PATH="$MAIN_TGZ_DIR/openclaw-main-update.ps1"
  cat >"$WINDOWS_UPDATE_SCRIPT_PATH" <<'EOF'
param(
  [Parameter(Mandatory = $true)][string]$TgzUrl,
  [Parameter(Mandatory = $true)][string]$HeadShort,
  [Parameter(Mandatory = $true)][string]$SessionId,
  [Parameter(Mandatory = $true)][string]$ModelId,
  [Parameter(Mandatory = $true)][string]$ProviderKeyEnv,
  [Parameter(Mandatory = $true)][string]$ProviderKey,
  [Parameter(Mandatory = $true)][string]$LogPath,
  [Parameter(Mandatory = $true)][string]$DonePath
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

function Invoke-Logged {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][scriptblock]$Command
  )

  $output = $null
  $previousErrorActionPreference = $ErrorActionPreference
  $previousNativeErrorPreference = $PSNativeCommandUseErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $PSNativeCommandUseErrorActionPreference = $false
    # Merge native stderr into stdout before logging so npm/openclaw warnings do not
    # surface as PowerShell error records and abort a healthy in-place update.
    $output = & $Command *>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $previousNativeErrorPreference
  }

  if ($null -ne $output) {
    $output | Tee-Object -FilePath $LogPath -Append | Out-Null
  }

  if ($exitCode -ne 0) {
    throw "$Label failed with exit code $exitCode"
  }
}

function Invoke-CaptureLogged {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][scriptblock]$Command
  )

  $previousErrorActionPreference = $ErrorActionPreference
  $previousNativeErrorPreference = $PSNativeCommandUseErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $PSNativeCommandUseErrorActionPreference = $false
    $output = & $Command *>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $previousNativeErrorPreference
  }

  if ($null -ne $output) {
    $output | Tee-Object -FilePath $LogPath -Append | Out-Null
  }

  if ($exitCode -ne 0) {
    throw "$Label failed with exit code $exitCode"
  }

  return ($output | Out-String).Trim()
}

try {
  $env:PATH = "$env:LOCALAPPDATA\OpenClaw\deps\portable-git\cmd;$env:LOCALAPPDATA\OpenClaw\deps\portable-git\mingw64\bin;$env:LOCALAPPDATA\OpenClaw\deps\portable-git\usr\bin;$env:PATH"
  $tgz = Join-Path $env:TEMP 'openclaw-main-update.tgz'
  Remove-Item $tgz, $LogPath, $DonePath -Force -ErrorAction SilentlyContinue
  Set-Item -Path ('Env:' + $ProviderKeyEnv) -Value $ProviderKey
  Invoke-Logged 'download current tgz' { curl.exe -fsSL $TgzUrl -o $tgz }
  Invoke-Logged 'npm install current tgz' { npm.cmd install -g $tgz --no-fund --no-audit }
  $openclaw = Join-Path $env:APPDATA 'npm\openclaw.cmd'
  $version = Invoke-CaptureLogged 'openclaw --version' { & $openclaw --version }
  if ($version -notmatch [regex]::Escape($HeadShort)) {
    throw "version mismatch: expected substring $HeadShort"
  }
  Invoke-Logged 'openclaw models set' { & $openclaw models set $ModelId }
  # Windows can keep the old hashed dist modules alive across in-place global npm upgrades.
  # Restart the gateway/service before verifying status or the next agent turn.
  Invoke-Logged 'openclaw gateway restart' { & $openclaw gateway restart }
  Start-Sleep -Seconds 5
  Invoke-Logged 'openclaw gateway status' { & $openclaw gateway status --deep --require-rpc }
  Invoke-CaptureLogged 'openclaw agent' { & $openclaw agent --agent main --session-id $SessionId --message 'Reply with exact ASCII text OK only.' --json } | Out-Null
  $exitCode = $LASTEXITCODE
  if ($null -eq $exitCode) {
    $exitCode = 0
  }
  Set-Content -Path $DonePath -Value ([string]$exitCode)
  exit $exitCode
} catch {
  if (Test-Path $LogPath) {
    Add-Content -Path $LogPath -Value ($_ | Out-String)
  } else {
    ($_ | Out-String) | Set-Content -Path $LogPath
  }
  Set-Content -Path $DonePath -Value '1'
  exit 1
}
EOF
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
matches = [match for match in matches if re.search(r"OpenClaw \d", match)]
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
  host_timeout_exec "$timeout_s" prlctl exec "$WINDOWS_VM" --current-user powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand "$encoded"
}

run_windows_script_via_log() {
  local script_url="$1"
  local tgz_url="$2"
  local head_short="$3"
  local session_id="$4"
  local model_id="$5"
  local provider_key_env="$6"
  local provider_key="$7"
  local runner_name log_name done_name done_status launcher_state
  local start_seconds poll_deadline startup_checked poll_rc state_rc log_rc
  runner_name="openclaw-update-$RANDOM-$RANDOM.ps1"
  log_name="openclaw-update-$RANDOM-$RANDOM.log"
  done_name="openclaw-update-$RANDOM-$RANDOM.done"
  start_seconds="$SECONDS"
  poll_deadline=$((SECONDS + 900))
  startup_checked=0

  guest_powershell "$(cat <<EOF
\$runner = Join-Path \$env:TEMP '$runner_name'
\$log = Join-Path \$env:TEMP '$log_name'
\$done = Join-Path \$env:TEMP '$done_name'
Remove-Item \$runner, \$log, \$done -Force -ErrorAction SilentlyContinue
curl.exe -fsSL '$script_url' -o \$runner
Start-Process powershell.exe -ArgumentList @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', \$runner,
  '-TgzUrl', '$tgz_url',
  '-HeadShort', '$head_short',
  '-SessionId', '$session_id',
  '-ModelId', '$model_id',
  '-ProviderKeyEnv', '$provider_key_env',
  '-ProviderKey', '$provider_key',
  '-LogPath', \$log,
  '-DonePath', \$done
) -WindowStyle Hidden | Out-Null
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
      warn "windows update helper poll failed; retrying"
      if (( SECONDS >= poll_deadline )); then
        warn "windows update helper timed out while polling done file"
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
        warn "windows update helper log drain failed after completion"
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
        warn "windows update helper failed to materialize guest files"
        return 1
      fi
    fi
    if (( SECONDS >= poll_deadline )); then
      set +e
      guest_powershell_poll 20 "\$log = Join-Path \$env:TEMP '$log_name'; if (Test-Path \$log) { Get-Content \$log }"
      log_rc=$?
      set -e
      if [[ $log_rc -ne 0 ]]; then
        warn "windows update helper log drain failed after timeout"
      fi
      warn "windows update helper timed out waiting for done file"
      return 1
    fi
    sleep 2
  done
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
/opt/homebrew/bin/openclaw models set "$MODEL_ID"
/opt/homebrew/bin/openclaw gateway status --deep --require-rpc
/usr/bin/env "$API_KEY_ENV=$API_KEY_VALUE" /opt/homebrew/bin/openclaw agent --agent main --session-id parallels-npm-update-macos-$head_short --message "Reply with exact ASCII text OK only." --json
EOF
  prlctl exec "$MACOS_VM" --current-user /bin/bash /tmp/openclaw-main-update.sh
}

run_windows_update() {
  local tgz_url="$1"
  local head_short="$2"
  local script_url="$3"
  run_windows_script_via_log \
    "$script_url" \
    "$tgz_url" \
    "$head_short" \
    "parallels-npm-update-windows-$head_short" \
    "$MODEL_ID" \
    "$API_KEY_ENV" \
    "$API_KEY_VALUE"
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
openclaw models set "$MODEL_ID"
openclaw agent --local --agent main --session-id parallels-npm-update-linux-$head_short --message "Reply with exact ASCII text OK only." --json
EOF
  prlctl exec "$LINUX_VM" /usr/bin/env "$API_KEY_ENV=$API_KEY_VALUE" /bin/bash /tmp/openclaw-main-update.sh
}

write_summary_json() {
  local summary_path="$RUN_DIR/summary.json"
  python3 - "$summary_path" <<'PY'
import json
import os
import sys

summary = {
    "packageSpec": os.environ["SUMMARY_PACKAGE_SPEC"],
    "provider": os.environ["SUMMARY_PROVIDER"],
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
            "mode": "local-with-provider-env",
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

RESOLVED_LINUX_VM="$(resolve_linux_vm_name)"
if [[ "$RESOLVED_LINUX_VM" != "$LINUX_VM" ]]; then
  warn "requested VM $LINUX_VM not found; using $RESOLVED_LINUX_VM"
  LINUX_VM="$RESOLVED_LINUX_VM"
fi

say "Run fresh npm baseline: $PACKAGE_SPEC"
bash "$ROOT_DIR/scripts/e2e/parallels-macos-smoke.sh" \
  --mode fresh \
  --provider "$PROVIDER" \
  --api-key-env "$API_KEY_ENV" \
  --target-package-spec "$PACKAGE_SPEC" \
  --json >"$RUN_DIR/macos-fresh.log" 2>&1 &
macos_fresh_pid=$!

bash "$ROOT_DIR/scripts/e2e/parallels-windows-smoke.sh" \
  --mode fresh \
  --provider "$PROVIDER" \
  --api-key-env "$API_KEY_ENV" \
  --target-package-spec "$PACKAGE_SPEC" \
  --json >"$RUN_DIR/windows-fresh.log" 2>&1 &
windows_fresh_pid=$!

bash "$ROOT_DIR/scripts/e2e/parallels-linux-smoke.sh" \
  --mode fresh \
  --provider "$PROVIDER" \
  --api-key-env "$API_KEY_ENV" \
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
write_windows_update_script
start_server

tgz_url="http://$HOST_IP:$HOST_PORT/$(basename "$MAIN_TGZ_PATH")"
windows_update_script_url="http://$HOST_IP:$HOST_PORT/$(basename "$WINDOWS_UPDATE_SCRIPT_PATH")"

say "Run same-guest update to current main"
run_macos_update "$tgz_url" "$CURRENT_HEAD_SHORT" >"$RUN_DIR/macos-update.log" 2>&1 &
macos_update_pid=$!
run_windows_update "$tgz_url" "$CURRENT_HEAD_SHORT" "$windows_update_script_url" >"$RUN_DIR/windows-update.log" 2>&1 &
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
SUMMARY_PROVIDER="$PROVIDER" \
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
