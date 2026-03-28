#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

VM_NAME="macOS Tahoe"
SNAPSHOT_HINT="macOS 26.3.1 latest"
MODE="both"
PROVIDER="openai"
API_KEY_ENV=""
AUTH_CHOICE=""
AUTH_KEY_FLAG=""
MODEL_ID=""
INSTALL_URL="https://openclaw.ai/install.sh"
HOST_PORT="18425"
HOST_PORT_EXPLICIT=0
HOST_IP=""
LATEST_VERSION=""
INSTALL_VERSION=""
TARGET_PACKAGE_SPEC=""
KEEP_SERVER=0
CHECK_LATEST_REF=1
JSON_OUTPUT=0
DISCORD_TOKEN_ENV=""
DISCORD_TOKEN_VALUE=""
DISCORD_GUILD_ID=""
DISCORD_CHANNEL_ID=""
SNAPSHOT_ID=""
SNAPSHOT_STATE=""
SNAPSHOT_NAME=""
GUEST_OPENCLAW_BIN="/opt/homebrew/bin/openclaw"
GUEST_OPENCLAW_ENTRY="/opt/homebrew/lib/node_modules/openclaw/openclaw.mjs"
GUEST_NODE_BIN="/opt/homebrew/bin/node"
GUEST_NPM_BIN="/opt/homebrew/bin/npm"

MAIN_TGZ_DIR="$(mktemp -d)"
MAIN_TGZ_PATH=""
PACKED_MAIN_COMMIT_SHORT=""
SERVER_PID=""
RUN_DIR="$(mktemp -d /tmp/openclaw-parallels-smoke.XXXXXX)"
BUILD_LOCK_DIR="${TMPDIR:-/tmp}/openclaw-parallels-build.lock"

TIMEOUT_INSTALL_S=900
TIMEOUT_VERIFY_S=60
TIMEOUT_ONBOARD_S=180
TIMEOUT_GATEWAY_S=60
TIMEOUT_AGENT_S=120
TIMEOUT_PERMISSION_S=60
TIMEOUT_DASHBOARD_S=60
TIMEOUT_SNAPSHOT_S=180
TIMEOUT_DISCORD_S=180

FRESH_MAIN_VERSION="skip"
LATEST_INSTALLED_VERSION="skip"
UPGRADE_MAIN_VERSION="skip"
FRESH_GATEWAY_STATUS="skip"
UPGRADE_GATEWAY_STATUS="skip"
FRESH_AGENT_STATUS="skip"
UPGRADE_AGENT_STATUS="skip"
FRESH_DASHBOARD_STATUS="skip"
UPGRADE_DASHBOARD_STATUS="skip"
FRESH_DISCORD_STATUS="skip"
UPGRADE_DISCORD_STATUS="skip"

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
  if command -v cleanup_discord_smoke_messages >/dev/null 2>&1; then
    cleanup_discord_smoke_messages
  fi
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
                             Default: "macOS 26.3.1 latest"
  --mode <fresh|upgrade|both>
                             fresh   = fresh snapshot -> target package/current main tgz -> onboard smoke
                             upgrade = fresh snapshot -> latest release -> target package/current main tgz -> onboard smoke
                             both    = run both lanes
  --provider <openai|anthropic>
                             Provider auth/model lane. Default: openai
  --api-key-env <var>        Host env var name for provider API key.
                             Default: OPENAI_API_KEY for openai, ANTHROPIC_API_KEY for anthropic
  --openai-api-key-env <var> Alias for --api-key-env (backward compatible)
  --install-url <url>        Installer URL for latest release. Default: https://openclaw.ai/install.sh
  --host-port <port>         Host HTTP port for current-main tgz. Default: 18425
  --host-ip <ip>             Override Parallels host IP.
  --latest-version <ver>     Override npm latest version lookup.
  --install-version <ver>    Pin site-installer version/dist-tag for the baseline lane.
  --target-package-spec <npm-spec>
                             Install this npm package tarball instead of packing current main.
                             Example: openclaw@2026.3.13-beta.1
  --skip-latest-ref-check    Skip the known latest-release ref-mode precheck in upgrade lane.
  --keep-server              Leave temp host HTTP server running.
  --discord-token-env <var>  Host env var name for Discord bot token.
  --discord-guild-id <id>    Discord guild ID for smoke roundtrip.
  --discord-channel-id <id>  Discord channel ID for smoke roundtrip.
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
    --discord-token-env)
      DISCORD_TOKEN_ENV="$2"
      shift 2
      ;;
    --discord-guild-id)
      DISCORD_GUILD_ID="$2"
      shift 2
      ;;
    --discord-channel-id)
      DISCORD_CHANNEL_ID="$2"
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
  *)
    die "invalid --provider: $PROVIDER"
    ;;
esac

API_KEY_VALUE="${!API_KEY_ENV:-}"
[[ -n "$API_KEY_VALUE" ]] || die "$API_KEY_ENV is required"

if [[ -n "$DISCORD_TOKEN_ENV" || -n "$DISCORD_GUILD_ID" || -n "$DISCORD_CHANNEL_ID" ]]; then
  [[ -n "$DISCORD_TOKEN_ENV" ]] || die "--discord-token-env is required when Discord smoke args are set"
  [[ -n "$DISCORD_GUILD_ID" ]] || die "--discord-guild-id is required when Discord smoke args are set"
  [[ -n "$DISCORD_CHANNEL_ID" ]] || die "--discord-channel-id is required when Discord smoke args are set"
  DISCORD_TOKEN_VALUE="${!DISCORD_TOKEN_ENV:-}"
  [[ -n "$DISCORD_TOKEN_VALUE" ]] || die "$DISCORD_TOKEN_ENV is required for Discord smoke"
fi

discord_smoke_enabled() {
  [[ -n "$DISCORD_TOKEN_VALUE" && -n "$DISCORD_GUILD_ID" && -n "$DISCORD_CHANNEL_ID" ]]
}

discord_api_request() {
  local method="$1"
  local path="$2"
  local payload="${3:-}"
  local url="https://discord.com/api/v10$path"
  if [[ -n "$payload" ]]; then
    curl -fsS -X "$method" \
      -H "Authorization: Bot $DISCORD_TOKEN_VALUE" \
      -H "Content-Type: application/json" \
      --data "$payload" \
      "$url"
    return
  fi
  curl -fsS -X "$method" \
    -H "Authorization: Bot $DISCORD_TOKEN_VALUE" \
    "$url"
}

json_contains_string() {
  local needle="$1"
  python3 - "$needle" <<'PY'
import json
import sys

needle = sys.argv[1]
try:
    payload = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)

def contains(value):
    if isinstance(value, str):
        return needle in value
    if isinstance(value, list):
        return any(contains(item) for item in value)
    if isinstance(value, dict):
        return any(contains(item) for item in value.values())
    return False

raise SystemExit(0 if contains(payload) else 1)
PY
}

discord_delete_message_id_file() {
  local path="$1"
  [[ -f "$path" ]] || return 0
  [[ -s "$path" ]] || return 0
  discord_smoke_enabled || return 0

  local message_id
  message_id="$(tr -d '\r\n' <"$path")"
  [[ -n "$message_id" ]] || return 0

  set +e
  discord_api_request DELETE "/channels/$DISCORD_CHANNEL_ID/messages/$message_id" >/dev/null
  set -e
}

cleanup_discord_smoke_messages() {
  discord_smoke_enabled || return 0
  [[ -d "$RUN_DIR" ]] || return 0

  discord_delete_message_id_file "$RUN_DIR/fresh.discord-sent-message-id"
  discord_delete_message_id_file "$RUN_DIR/fresh.discord-host-message-id"
  discord_delete_message_id_file "$RUN_DIR/upgrade.discord-sent-message-id"
  discord_delete_message_id_file "$RUN_DIR/upgrade.discord-host-message-id"
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
  warn "host port 18425 busy; using $HOST_PORT"
  printf '%s\n' "$HOST_PORT"
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
    PATH=/opt/homebrew/bin:/opt/homebrew/opt/node/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin \
    "$@"
}

guest_current_user_cli() {
  local parts=() arg joined=""
  for arg in "$@"; do
    parts+=("$(shell_quote "$arg")")
  done
  joined="${parts[*]}"
  guest_current_user_sh "$joined"
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
  if [[ "$SNAPSHOT_STATE" == "poweroff" ]]; then
    wait_for_vm_status "stopped" || die "restored poweroff snapshot did not reach stopped state in $VM_NAME"
    say "Start restored poweroff snapshot $SNAPSHOT_NAME"
    prlctl start "$VM_NAME" >/dev/null
  fi
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
  local install_url_q version_arg_q
  install_url_q="$(shell_quote "$INSTALL_URL")"
  version_arg_q=""
  if [[ -n "$INSTALL_VERSION" ]]; then
    version_arg_q=" --version $(shell_quote "$INSTALL_VERSION")"
  fi
  guest_current_user_sh "$(cat <<EOF
export OPENCLAW_NO_ONBOARD=1
curl -fsSL $install_url_q -o /tmp/openclaw-install.sh
bash /tmp/openclaw-install.sh${version_arg_q}
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

extract_package_version_from_tgz() {
  tar -xOf "$1" package/package.json | python3 -c 'import json, sys; print(json.load(sys.stdin)["version"])'
}

extract_package_build_commit_from_tgz() {
  tar -xOf "$1" package/dist/build-info.json | python3 -c 'import json, sys; print(json.load(sys.stdin).get("commit", ""))'
}

pack_main_tgz() {
  local short_head pkg packed_commit
  if [[ -n "$TARGET_PACKAGE_SPEC" ]]; then
    say "Pack target package tgz: $TARGET_PACKAGE_SPEC"
    pkg="$(
      npm pack "$TARGET_PACKAGE_SPEC" --ignore-scripts --json --pack-destination "$MAIN_TGZ_DIR" \
        | python3 -c 'import json, sys; data = json.load(sys.stdin); print(data[-1]["filename"])'
    )"
    MAIN_TGZ_PATH="$MAIN_TGZ_DIR/$(basename "$pkg")"
    TARGET_EXPECT_VERSION="$(extract_package_version_from_tgz "$MAIN_TGZ_PATH")"
    say "Packed $MAIN_TGZ_PATH"
    say "Target package version: $TARGET_EXPECT_VERSION"
    return
  fi
  say "Pack current main tgz"
  ensure_current_build
  stage_pack_runtime_deps
  short_head="$(git rev-parse --short HEAD)"
  pkg="$(
    npm pack --ignore-scripts --json --pack-destination "$MAIN_TGZ_DIR" \
      | python3 -c 'import json, sys; data = json.load(sys.stdin); print(data[-1]["filename"])'
  )"
  MAIN_TGZ_PATH="$MAIN_TGZ_DIR/openclaw-main-$short_head.tgz"
  cp "$MAIN_TGZ_DIR/$pkg" "$MAIN_TGZ_PATH"
  packed_commit="$(extract_package_build_commit_from_tgz "$MAIN_TGZ_PATH")"
  [[ -n "$packed_commit" ]] || die "failed to read packed build commit from $MAIN_TGZ_PATH"
  PACKED_MAIN_COMMIT_SHORT="${packed_commit:0:7}"
  say "Packed $MAIN_TGZ_PATH"
  tar -xOf "$MAIN_TGZ_PATH" package/dist/build-info.json
}

verify_target_version() {
  if [[ -n "$TARGET_PACKAGE_SPEC" ]]; then
    verify_version_contains "$TARGET_EXPECT_VERSION"
    return
  fi
  [[ -n "$PACKED_MAIN_COMMIT_SHORT" ]] || die "packed main commit not captured"
  verify_version_contains "$PACKED_MAIN_COMMIT_SHORT"
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

current_control_ui_ready() {
  [[ -f "dist/control-ui/index.html" ]]
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
  if [[ "$build_commit" == "$head" ]] && current_control_ui_ready; then
    release_build_lock
    return
  fi
  say "Build dist for current head"
  pnpm build
  say "Build Control UI for current head"
  pnpm ui:build
  build_commit="$(current_build_commit)"
  release_build_lock
  [[ "$build_commit" == "$head" ]] || die "dist/build-info.json still does not match HEAD after build"
  current_control_ui_ready || die "dist/control-ui/index.html missing after ui build"
}

stage_pack_runtime_deps() {
  node scripts/stage-bundled-plugin-runtime-deps.mjs
}

start_server() {
  local host_ip="$1"
  say "Serve $(artifact_label) on $host_ip:$HOST_PORT"
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
  guest_current_user_cli \
    /usr/bin/env "$API_KEY_ENV=$API_KEY_VALUE" \
    "$GUEST_OPENCLAW_BIN" onboard \
    --non-interactive \
    --mode local \
    --auth-choice "$AUTH_CHOICE" \
    --secret-input-mode ref \
    --gateway-port 18789 \
    --gateway-bind loopback \
    --install-daemon \
    --skip-skills \
    --accept-risk \
    --json
}

verify_gateway() {
  guest_current_user_cli "$GUEST_OPENCLAW_BIN" gateway status --deep --require-rpc
}

show_gateway_status_compat() {
  if guest_current_user_cli "$GUEST_OPENCLAW_BIN" gateway status --help | grep -Fq -- "--require-rpc"; then
    guest_current_user_cli "$GUEST_OPENCLAW_BIN" gateway status --deep --require-rpc
    return
  fi
  guest_current_user_cli "$GUEST_OPENCLAW_BIN" gateway status --deep
}

verify_turn() {
  guest_current_user_cli "$GUEST_OPENCLAW_BIN" models set "$MODEL_ID"
  guest_current_user_cli \
    /usr/bin/env "$API_KEY_ENV=$API_KEY_VALUE" \
    "$GUEST_OPENCLAW_BIN" agent \
    --agent main \
    --message "Reply with exact ASCII text OK only." \
    --json
}

resolve_dashboard_url() {
  local dashboard_url
  dashboard_url="$(
    guest_current_user_cli "$GUEST_OPENCLAW_BIN" dashboard --no-open \
      | awk '/^Dashboard URL: / { sub(/^Dashboard URL: /, ""); print; exit }'
  )"
  dashboard_url="${dashboard_url//$'\r'/}"
  dashboard_url="${dashboard_url//$'\n'/}"
  [[ -n "$dashboard_url" ]] || {
    echo "failed to resolve dashboard URL from openclaw dashboard --no-open" >&2
    return 1
  }
  printf '%s\n' "$dashboard_url"
}

verify_dashboard_load() {
  local dashboard_url dashboard_http_url dashboard_url_q dashboard_http_url_q cmd
  dashboard_url="$(resolve_dashboard_url)"
  dashboard_http_url="${dashboard_url%%#*}"
  dashboard_url_q="$(shell_quote "$dashboard_url")"
  dashboard_http_url_q="$(shell_quote "$dashboard_http_url")"
  cmd="$(cat <<EOF
set -eu
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin:\${PATH:-}"
if [ -z "\${HOME:-}" ]; then export HOME="/Users/\$(id -un)"; fi
cd "\$HOME"
dashboard_url=$dashboard_url_q
dashboard_http_url=$dashboard_http_url_q
dashboard_port=\$(printf '%s\n' "\$dashboard_http_url" | sed -E 's#^https?://[^:/]+:([0-9]+).*\$#\1#')
if [ -z "\$dashboard_port" ] || [ "\$dashboard_port" = "\$dashboard_http_url" ]; then
  echo "failed to parse dashboard port from \$dashboard_http_url" >&2
  exit 1
fi
deadline=\$((SECONDS + 30))
dashboard_ready=0
while [ \$SECONDS -lt \$deadline ]; do
  if curl -fsSL "\$dashboard_http_url" >/tmp/openclaw-dashboard-smoke.html 2>/dev/null; then
    if grep -F '<title>OpenClaw Control</title>' /tmp/openclaw-dashboard-smoke.html >/dev/null; then
      if grep -F '<openclaw-app></openclaw-app>' /tmp/openclaw-dashboard-smoke.html >/dev/null; then
        dashboard_ready=1
        break
      fi
    fi
  fi
  sleep 1
done
[ "\$dashboard_ready" = "1" ] || {
  echo "dashboard HTML did not become ready at \$dashboard_http_url" >&2
  exit 1
}
grep -F '<title>OpenClaw Control</title>' /tmp/openclaw-dashboard-smoke.html >/dev/null
grep -F '<openclaw-app></openclaw-app>' /tmp/openclaw-dashboard-smoke.html >/dev/null
pkill -x Safari >/dev/null 2>&1 || true
open -a Safari "\$dashboard_url"
deadline=\$((SECONDS + 20))
while [ \$SECONDS -lt \$deadline ]; do
  if pgrep -x Safari >/dev/null 2>&1; then
    if lsof -nPiTCP:"\$dashboard_port" -sTCP:ESTABLISHED 2>/dev/null \
      | awk 'NR > 1 && \$1 != "node" { found = 1 } END { exit found ? 0 : 1 }'; then
      exit 0
    fi
  fi
  sleep 1
done
echo "Safari did not establish a dashboard client connection on port \$dashboard_port" >&2
exit 1
EOF
)"
  guest_current_user_exec /bin/sh -lc "$cmd"
}

configure_discord_smoke() {
  local guilds_json script
  guilds_json="$(
    DISCORD_GUILD_ID="$DISCORD_GUILD_ID" DISCORD_CHANNEL_ID="$DISCORD_CHANNEL_ID" python3 - <<'PY'
import json
import os

print(
    json.dumps(
        {
            os.environ["DISCORD_GUILD_ID"]: {
                "channels": {
                    os.environ["DISCORD_CHANNEL_ID"]: {
                        "allow": True,
                        "requireMention": False,
                    }
                }
            }
        }
    )
)
PY
  )"
  script="$(cat <<EOF
cat >/tmp/openclaw-discord-token <<'__OPENCLAW_TOKEN__'
$DISCORD_TOKEN_VALUE
__OPENCLAW_TOKEN__
cat >/tmp/openclaw-discord-guilds.json <<'__OPENCLAW_GUILDS__'
$guilds_json
__OPENCLAW_GUILDS__
token="\$(tr -d '\n' </tmp/openclaw-discord-token)"
guilds_json="\$(cat /tmp/openclaw-discord-guilds.json)"
$GUEST_NODE_BIN $GUEST_OPENCLAW_ENTRY config set channels.discord.token "\$token"
$GUEST_NODE_BIN $GUEST_OPENCLAW_ENTRY config set channels.discord.enabled true
$GUEST_NODE_BIN $GUEST_OPENCLAW_ENTRY config set channels.discord.groupPolicy allowlist
$GUEST_NODE_BIN $GUEST_OPENCLAW_ENTRY config set channels.discord.guilds "\$guilds_json" --strict-json
$GUEST_NODE_BIN $GUEST_OPENCLAW_ENTRY gateway restart
for _ in 1 2 3 4 5 6 7 8; do
  if $GUEST_NODE_BIN $GUEST_OPENCLAW_ENTRY gateway status --deep --require-rpc >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
$GUEST_NODE_BIN $GUEST_OPENCLAW_ENTRY channels status --probe --json
rm -f /tmp/openclaw-discord-token /tmp/openclaw-discord-guilds.json
EOF
)"
  prlctl exec "$VM_NAME" --current-user /usr/bin/env \
    PATH=/opt/homebrew/bin:/opt/homebrew/opt/node/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin \
    /bin/sh -lc "$script"
}

discord_message_id_from_send_log() {
  local path="$1"
  python3 - "$path" <<'PY'
import json
import pathlib
import sys

payload = json.loads(pathlib.Path(sys.argv[1]).read_text())
message_id = payload.get("payload", {}).get("messageId")
if not message_id:
    message_id = payload.get("payload", {}).get("result", {}).get("messageId")
if not message_id:
    raise SystemExit("messageId missing from send output")
print(message_id)
PY
}

wait_for_discord_host_visibility() {
  local nonce="$1"
  local response
  local deadline=$((SECONDS + TIMEOUT_DISCORD_S))
  while (( SECONDS < deadline )); do
    set +e
    response="$(discord_api_request GET "/channels/$DISCORD_CHANNEL_ID/messages?limit=20")"
    local rc=$?
    set -e
    if [[ $rc -eq 0 ]] && [[ -n "$response" ]] && printf '%s' "$response" | json_contains_string "$nonce"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

post_host_discord_message() {
  local nonce="$1"
  local id_file="$2"
  local payload response
  payload="$(
    NONCE="$nonce" python3 - <<'PY'
import json
import os

print(
    json.dumps(
        {
            "content": f"parallels-macos-smoke-inbound-{os.environ['NONCE']}",
            "flags": 4096,
        }
    )
)
PY
  )"
  response="$(discord_api_request POST "/channels/$DISCORD_CHANNEL_ID/messages" "$payload")"
  printf '%s' "$response" | python3 - "$id_file" <<'PY'
import json
import pathlib
import sys

payload = json.load(sys.stdin)
message_id = payload.get("id")
if not isinstance(message_id, str) or not message_id:
    raise SystemExit("host Discord post missing message id")
pathlib.Path(sys.argv[1]).write_text(f"{message_id}\n", encoding="utf-8")
PY
}

wait_for_guest_discord_readback() {
  local nonce="$1"
  local response rc
  local last_response_path="$RUN_DIR/discord-last-readback.json"
  local deadline=$((SECONDS + TIMEOUT_DISCORD_S))
  while (( SECONDS < deadline )); do
    set +e
    response="$(
      guest_current_user_exec \
      "$GUEST_OPENCLAW_BIN" \
      message read \
      --channel discord \
      --target "channel:$DISCORD_CHANNEL_ID" \
      --limit 20 \
      --json
    )"
    rc=$?
    set -e
    if [[ -n "$response" ]]; then
      printf '%s' "$response" >"$last_response_path"
    fi
    if [[ $rc -eq 0 ]] && [[ -n "$response" ]] && printf '%s' "$response" | json_contains_string "$nonce"; then
      return 0
    fi
    sleep 3
  done
  return 1
}

run_discord_roundtrip_smoke() {
  local phase="$1"
  local nonce outbound_nonce inbound_nonce outbound_message outbound_log sent_id_file host_id_file
  nonce="$(date +%s)-$RANDOM"
  outbound_nonce="$phase-out-$nonce"
  inbound_nonce="$phase-in-$nonce"
  outbound_message="parallels-macos-smoke-outbound-$outbound_nonce"
  outbound_log="$RUN_DIR/$phase.discord-send.json"
  sent_id_file="$RUN_DIR/$phase.discord-sent-message-id"
  host_id_file="$RUN_DIR/$phase.discord-host-message-id"

  guest_current_user_exec \
    "$GUEST_OPENCLAW_BIN" \
    message send \
    --channel discord \
    --target "channel:$DISCORD_CHANNEL_ID" \
    --message "$outbound_message" \
    --silent \
    --json >"$outbound_log"

  discord_message_id_from_send_log "$outbound_log" >"$sent_id_file"
  wait_for_discord_host_visibility "$outbound_nonce"
  post_host_discord_message "$inbound_nonce" "$host_id_file"
  wait_for_guest_discord_readback "$inbound_nonce"
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

show_restore_timeout_diagnostics() {
  warn "restore diagnostics for $VM_NAME"
  prlctl status "$VM_NAME" >&2 || true
  warn "snapshot list for $VM_NAME"
  prlctl snapshot-list "$VM_NAME" >&2 || true
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
    if [[ "$phase_id" == *.restore-snapshot ]]; then
      show_restore_timeout_diagnostics
    fi
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
    "provider": os.environ["SUMMARY_PROVIDER"],
    "snapshotHint": os.environ["SUMMARY_SNAPSHOT_HINT"],
    "snapshotId": os.environ["SUMMARY_SNAPSHOT_ID"],
    "mode": os.environ["SUMMARY_MODE"],
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
        "dashboard": os.environ["SUMMARY_FRESH_DASHBOARD_STATUS"],
        "discord": os.environ["SUMMARY_FRESH_DISCORD_STATUS"],
    },
    "upgrade": {
        "precheck": os.environ["SUMMARY_UPGRADE_PRECHECK_STATUS"],
        "status": os.environ["SUMMARY_UPGRADE_STATUS"],
        "latestVersionInstalled": os.environ["SUMMARY_LATEST_INSTALLED_VERSION"],
        "mainVersion": os.environ["SUMMARY_UPGRADE_MAIN_VERSION"],
        "gateway": os.environ["SUMMARY_UPGRADE_GATEWAY_STATUS"],
        "agent": os.environ["SUMMARY_UPGRADE_AGENT_STATUS"],
        "dashboard": os.environ["SUMMARY_UPGRADE_DASHBOARD_STATUS"],
        "discord": os.environ["SUMMARY_UPGRADE_DISCORD_STATUS"],
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
  show_gateway_status_compat || true
  set -e
  return 1
}

run_fresh_main_lane() {
  local snapshot_id="$1"
  local host_ip="$2"
  phase_run "fresh.restore-snapshot" "$TIMEOUT_SNAPSHOT_S" restore_snapshot "$snapshot_id"
  phase_run "fresh.install-main" "$TIMEOUT_INSTALL_S" install_main_tgz "$host_ip" "openclaw-main-fresh.tgz"
  FRESH_MAIN_VERSION="$(extract_last_version "$(phase_log_path fresh.install-main)")"
  phase_run "fresh.verify-main-version" "$TIMEOUT_VERIFY_S" verify_target_version
  phase_run "fresh.verify-bundle-permissions" "$TIMEOUT_PERMISSION_S" verify_bundle_permissions
  phase_run "fresh.onboard-ref" "$TIMEOUT_ONBOARD_S" run_ref_onboard
  phase_run "fresh.gateway-status" "$TIMEOUT_GATEWAY_S" verify_gateway
  FRESH_GATEWAY_STATUS="pass"
  phase_run "fresh.dashboard-load" "$TIMEOUT_DASHBOARD_S" verify_dashboard_load
  FRESH_DASHBOARD_STATUS="pass"
  phase_run "fresh.first-agent-turn" "$TIMEOUT_AGENT_S" verify_turn
  FRESH_AGENT_STATUS="pass"
  if discord_smoke_enabled; then
    FRESH_DISCORD_STATUS="fail"
    phase_run "fresh.discord-config" "$TIMEOUT_GATEWAY_S" configure_discord_smoke
    phase_run "fresh.discord-roundtrip" "$TIMEOUT_DISCORD_S" run_discord_roundtrip_smoke "fresh"
    FRESH_DISCORD_STATUS="pass"
  fi
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
  phase_run "upgrade.verify-main-version" "$TIMEOUT_VERIFY_S" verify_target_version
  phase_run "upgrade.verify-bundle-permissions" "$TIMEOUT_PERMISSION_S" verify_bundle_permissions
  phase_run "upgrade.onboard-ref" "$TIMEOUT_ONBOARD_S" run_ref_onboard
  phase_run "upgrade.gateway-status" "$TIMEOUT_GATEWAY_S" verify_gateway
  UPGRADE_GATEWAY_STATUS="pass"
  phase_run "upgrade.dashboard-load" "$TIMEOUT_DASHBOARD_S" verify_dashboard_load
  UPGRADE_DASHBOARD_STATUS="pass"
  phase_run "upgrade.first-agent-turn" "$TIMEOUT_AGENT_S" verify_turn
  UPGRADE_AGENT_STATUS="pass"
  if discord_smoke_enabled; then
    UPGRADE_DISCORD_STATUS="fail"
    phase_run "upgrade.discord-config" "$TIMEOUT_GATEWAY_S" configure_discord_smoke
    phase_run "upgrade.discord-roundtrip" "$TIMEOUT_DISCORD_S" run_discord_roundtrip_smoke "upgrade"
    UPGRADE_DISCORD_STATUS="pass"
  fi
}

FRESH_MAIN_STATUS="skip"
UPGRADE_STATUS="skip"
UPGRADE_PRECHECK_STATUS="skip"

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
if discord_smoke_enabled; then
  say "Discord smoke: guild=$DISCORD_GUILD_ID channel=$DISCORD_CHANNEL_ID"
else
  say "Discord smoke: disabled"
fi
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
  SUMMARY_PROVIDER="$PROVIDER" \
  SUMMARY_SNAPSHOT_HINT="$SNAPSHOT_HINT" \
  SUMMARY_SNAPSHOT_ID="$SNAPSHOT_ID" \
  SUMMARY_MODE="$MODE" \
  SUMMARY_LATEST_VERSION="$LATEST_VERSION" \
  SUMMARY_INSTALL_VERSION="$INSTALL_VERSION" \
  SUMMARY_TARGET_PACKAGE_SPEC="$TARGET_PACKAGE_SPEC" \
  SUMMARY_CURRENT_HEAD="$(git rev-parse --short HEAD)" \
  SUMMARY_RUN_DIR="$RUN_DIR" \
  SUMMARY_FRESH_MAIN_STATUS="$FRESH_MAIN_STATUS" \
  SUMMARY_FRESH_MAIN_VERSION="$FRESH_MAIN_VERSION" \
  SUMMARY_FRESH_GATEWAY_STATUS="$FRESH_GATEWAY_STATUS" \
  SUMMARY_FRESH_AGENT_STATUS="$FRESH_AGENT_STATUS" \
  SUMMARY_FRESH_DASHBOARD_STATUS="$FRESH_DASHBOARD_STATUS" \
  SUMMARY_FRESH_DISCORD_STATUS="$FRESH_DISCORD_STATUS" \
  SUMMARY_UPGRADE_PRECHECK_STATUS="$UPGRADE_PRECHECK_STATUS" \
  SUMMARY_UPGRADE_STATUS="$UPGRADE_STATUS" \
  SUMMARY_LATEST_INSTALLED_VERSION="$LATEST_INSTALLED_VERSION" \
  SUMMARY_UPGRADE_MAIN_VERSION="$UPGRADE_MAIN_VERSION" \
  SUMMARY_UPGRADE_GATEWAY_STATUS="$UPGRADE_GATEWAY_STATUS" \
  SUMMARY_UPGRADE_AGENT_STATUS="$UPGRADE_AGENT_STATUS" \
  SUMMARY_UPGRADE_DASHBOARD_STATUS="$UPGRADE_DASHBOARD_STATUS" \
  SUMMARY_UPGRADE_DISCORD_STATUS="$UPGRADE_DISCORD_STATUS" \
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
  printf '  fresh-main: %s (%s) discord=%s\n' "$FRESH_MAIN_STATUS" "$FRESH_MAIN_VERSION" "$FRESH_DISCORD_STATUS"
  printf '  latest->main precheck: %s (%s)\n' "$UPGRADE_PRECHECK_STATUS" "$LATEST_INSTALLED_VERSION"
  printf '  latest->main: %s (%s) discord=%s\n' "$UPGRADE_STATUS" "$UPGRADE_MAIN_VERSION" "$UPGRADE_DISCORD_STATUS"
  printf '  logs: %s\n' "$RUN_DIR"
  printf '  summary: %s\n' "$SUMMARY_JSON_PATH"
fi

if [[ "$FRESH_MAIN_STATUS" == "fail" || "$UPGRADE_STATUS" == "fail" ]]; then
  exit 1
fi
