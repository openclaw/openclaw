#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
NODE="${OPENCLAW_NODE_BIN:-$(command -v node)}"
CLI="$ROOT/openclaw.mjs"
EXPECTED_ENTRY="$ROOT/dist/index.js"
PREFLIGHT="$ROOT/scripts/local-runtime-preflight.sh"
PLIST="$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
LAUNCHD_DOMAIN="gui/${UID}"
LAUNCHD_LABEL="ai.openclaw.gateway"
LAUNCHD_TARGET="${LAUNCHD_DOMAIN}/${LAUNCHD_LABEL}"
DEFERRED_RESTART_DELAY_SECONDS="${OPENCLAW_DEFERRED_RESTART_DELAY_SECONDS:-1}"
HELPER_LOG_PATH="${OPENCLAW_RESTART_HELPER_LOG:-/tmp/openclaw-restart-helper.log}"

if [[ ! -x "$NODE" ]]; then
  echo "ERROR: node runtime not found. Install Node 22+ or set OPENCLAW_NODE_BIN." >&2
  exit 1
fi

if [[ -x "$PREFLIGHT" ]]; then
  "$PREFLIGHT" --quiet
fi

is_self_restart_context() {
  # OPENCLAW_RESTART_DETACHED is set when the gateway asks us to restart from
  # inside an active command. LAUNCH_JOB_LABEL/XPC_SERVICE_NAME are set when
  # this script is running under the same launchd job being restarted.
  if [[ "${OPENCLAW_RESTART_DETACHED:-0}" == "1" ]]; then
    return 0
  fi
  if [[ "${LAUNCH_JOB_LABEL:-}" == "$LAUNCHD_LABEL" ]]; then
    return 0
  fi
  if [[ "${XPC_SERVICE_NAME:-}" == "$LAUNCHD_LABEL" ]]; then
    return 0
  fi
  return 1
}

schedule_detached_restart() {
  local helper_script
  helper_script="$(mktemp "${TMPDIR:-/tmp}/openclaw-restart-detached.XXXXXX.sh")"
  cat >"$helper_script" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

LAUNCHD_TARGET="$1"
LAUNCHD_DOMAIN="$2"
PLIST="$3"
DELAY_SECONDS="$4"
HELPER_SCRIPT="$0"

sleep "$DELAY_SECONDS"
launchctl bootout "$LAUNCHD_TARGET" >/dev/null 2>&1 || true
launchctl bootstrap "$LAUNCHD_DOMAIN" "$PLIST" >/dev/null
launchctl kickstart -k "$LAUNCHD_TARGET" >/dev/null
rm -f "$HELPER_SCRIPT"
EOF
  chmod 700 "$helper_script"
  nohup "$helper_script" "$LAUNCHD_TARGET" "$LAUNCHD_DOMAIN" "$PLIST" "$DEFERRED_RESTART_DELAY_SECONDS" >"$HELPER_LOG_PATH" 2>&1 </dev/null &
  local helper_pid="$!"
  disown || true
  echo "OK: scheduled detached gateway restart helper (pid ${helper_pid})."
  echo "Helper log: ${HELPER_LOG_PATH}"
}

# Reinstall service definition from the local fork.
"$NODE" "$CLI" daemon install --force --runtime node >/dev/null

if is_self_restart_context; then
  schedule_detached_restart
  exit 0
fi

# Restart deterministically via launchctl so we don't depend on whichever global
# openclaw binary might be active in PATH.
launchctl bootout "$LAUNCHD_TARGET" >/dev/null 2>&1 || true
launchctl bootstrap "$LAUNCHD_DOMAIN" "$PLIST" >/dev/null
launchctl kickstart -k "$LAUNCHD_TARGET" >/dev/null

STATUS=""
for _ in {1..20}; do
  STATUS="$("$NODE" "$CLI" daemon status)"
  if printf '%s\n' "$STATUS" | grep -Fq "RPC probe: ok"; then
    break
  fi
  sleep 1
done

printf '%s\n' "$STATUS"

if ! launchctl print "$LAUNCHD_TARGET" >/dev/null 2>&1; then
  echo "ERROR: launchd service $LAUNCHD_TARGET is not loaded." >&2
  exit 1
fi

if ! printf '%s\n' "$STATUS" | grep -Fq "$EXPECTED_ENTRY"; then
  echo "ERROR: gateway is not pinned to local fork entry: $EXPECTED_ENTRY" >&2
  exit 1
fi

if ! printf '%s\n' "$STATUS" | grep -Fq "RPC probe: ok"; then
  echo "ERROR: gateway did not become healthy (RPC probe not ok)." >&2
  exit 1
fi

echo "OK: gateway pinned to local fork entry."
