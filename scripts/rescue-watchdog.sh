#!/bin/bash
# External rescue watchdog for OpenClaw.
# Run this outside the gateway process (cron, launchd, systemd timer).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"
JQ_BIN="${JQ_BIN:-jq}"

STATE_DIR="${OPENCLAW_RESCUE_STATE_DIR:-$HOME/.openclaw/rescue-watchdog}"
INCIDENT_ROOT="${OPENCLAW_RESCUE_INCIDENT_ROOT:-$STATE_DIR/incidents}"
STATE_FILE="$STATE_DIR/state.env"

HEALTH_TIMEOUT_MS="${OPENCLAW_RESCUE_HEALTH_TIMEOUT_MS:-10000}"
COOLDOWN_SEC="${OPENCLAW_RESCUE_COOLDOWN_SEC:-900}"
TAIL_LINES="${OPENCLAW_RESCUE_TAIL_LINES:-200}"
RUNNER_CMD="${OPENCLAW_RESCUE_RUNNER:-}"

NOTIFY_CHANNEL="${OPENCLAW_RESCUE_NOTIFY_CHANNEL:-}"
NOTIFY_TARGET="${OPENCLAW_RESCUE_NOTIFY_TARGET:-}"
NOTIFY_PREFIX="${OPENCLAW_RESCUE_NOTIFY_PREFIX:-[openclaw rescue]}"

LOG_DIR="${OPENCLAW_RESCUE_LOG_DIR:-/tmp/openclaw}"
LOG_PATTERN="${OPENCLAW_RESCUE_LOG_PATTERN:-openclaw-*.log}"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-rescue.XXXXXX")"

cleanup() {
  rm -rf "$TMP_DIR"
}

trap cleanup EXIT

require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "missing required command: $name" >&2
    exit 1
  fi
}

load_state() {
  LAST_FINGERPRINT=""
  LAST_TRIGGERED_AT=0
  LAST_INCIDENT_ID=""
  if [ -f "$STATE_FILE" ]; then
    # shellcheck disable=SC1090
    source "$STATE_FILE"
  fi
}

write_state() {
  local fingerprint="$1"
  local triggered_at="$2"
  local incident_id="$3"

  mkdir -p "$STATE_DIR"
  {
    printf 'LAST_FINGERPRINT=%q\n' "$fingerprint"
    printf 'LAST_TRIGGERED_AT=%q\n' "$triggered_at"
    printf 'LAST_INCIDENT_ID=%q\n' "$incident_id"
  } >"$STATE_FILE"
}

hash_text() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    cksum | awk '{print $1}'
  fi
}

latest_log_file() {
  ls -1t "$LOG_DIR"/$LOG_PATTERN 2>/dev/null | head -n 1 || true
}

single_line() {
  tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//'
}

truncate_message() {
  local max_len="$1"
  local raw="$2"
  if [ "${#raw}" -le "$max_len" ]; then
    printf '%s\n' "$raw"
    return
  fi
  printf '%s...\n' "${raw:0:max_len}"
}

extract_channel_issues() {
  local health_file="$1"
  "$JQ_BIN" -r '
    [
      (
        (.channels // {}) | to_entries[] as $channel |
        (
          if (($channel.value.lastError // "") | type) == "string" and ($channel.value.lastError | length > 0)
          then "\($channel.key):default: \($channel.value.lastError)"
          else empty
          end
        ),
        (
          ($channel.value.probe // null) as $probe |
          if ($probe | type) == "object" and ($probe.ok? == false) and (($probe.error // "") | tostring | length > 0)
          then "\($channel.key):default: probe failed: \($probe.error)"
          else empty
          end
        ),
        (
          ($channel.value.accounts // {}) | to_entries[]? |
          select(((.value.lastError // "") | type) == "string" and (.value.lastError | length > 0)) |
          "\($channel.key):\(.key): \(.value.lastError)"
        ),
        (
          ($channel.value.accounts // {}) | to_entries[]? |
          (.value.probe // null) as $probe |
          select(($probe | type) == "object" and ($probe.ok? == false) and (($probe.error // "") | tostring | length > 0)) |
          "\($channel.key):\(.key): probe failed: \($probe.error)"
        )
      )
    ] | unique | .[]
  ' "$health_file" 2>/dev/null || true
}

send_notification() {
  local message="$1"
  if [ -z "$NOTIFY_CHANNEL" ] || [ -z "$NOTIFY_TARGET" ]; then
    return
  fi

  "$OPENCLAW_BIN" message send \
    --channel "$NOTIFY_CHANNEL" \
    --target "$NOTIFY_TARGET" \
    --message "$message" \
    >/dev/null 2>&1 || true
}

require_command "$OPENCLAW_BIN"
require_command "$JQ_BIN"

mkdir -p "$STATE_DIR" "$INCIDENT_ROOT"

health_exit=0
if "$OPENCLAW_BIN" health --json --timeout "$HEALTH_TIMEOUT_MS" >"$TMP_DIR/health.json" 2>"$TMP_DIR/health.stderr"; then
  health_exit=0
else
  health_exit=$?
fi
printf '%s\n' "$health_exit" >"$TMP_DIR/health.exit"

incident_reason=""
summary_text=""
if [ "$health_exit" -ne 0 ]; then
  incident_reason="health-command-failed"
  last_health_error="$(tail -n 1 "$TMP_DIR/health.stderr" | single_line)"
  if [ -z "$last_health_error" ]; then
    last_health_error="openclaw health exited with status $health_exit"
  fi
  summary_text="health command failed (exit $health_exit): $last_health_error"
else
  extract_channel_issues "$TMP_DIR/health.json" >"$TMP_DIR/channel-errors.txt"
  if [ -s "$TMP_DIR/channel-errors.txt" ]; then
    incident_reason="channel-errors"
    issue_count="$(grep -cve '^[[:space:]]*$' "$TMP_DIR/channel-errors.txt" || true)"
    summary_text="channel runtime errors detected ($issue_count)"
  fi
fi

if [ -z "$incident_reason" ]; then
  echo "openclaw rescue watchdog: healthy"
  exit 0
fi

fingerprint_source="$summary_text"
if [ -f "$TMP_DIR/channel-errors.txt" ]; then
  fingerprint_source+=$'\n'"$(cat "$TMP_DIR/channel-errors.txt")"
fi
if [ -s "$TMP_DIR/health.stderr" ]; then
  fingerprint_source+=$'\n'"$(tail -n 20 "$TMP_DIR/health.stderr")"
fi
fingerprint="$(printf '%s' "$fingerprint_source" | hash_text)"

load_state
now_epoch="$(date +%s)"
if [ "$LAST_FINGERPRINT" = "$fingerprint" ] && [ $((now_epoch - LAST_TRIGGERED_AT)) -lt "$COOLDOWN_SEC" ]; then
  echo "openclaw rescue watchdog: duplicate incident skipped (fingerprint=$fingerprint incident=$LAST_INCIDENT_ID)"
  exit 0
fi

incident_id="$(date -u +"%Y%m%dT%H%M%SZ")"
incident_dir="$INCIDENT_ROOT/$incident_id"
mkdir -p "$incident_dir"

printf '%s\n' "$incident_reason" >"$incident_dir/reason.txt"
printf '%s\n' "$summary_text" >"$incident_dir/summary.txt"
printf '%s\n' "$fingerprint" >"$incident_dir/fingerprint.txt"
printf '%s\n' "$REPO_DIR" >"$incident_dir/workspace.txt"
cp "$TMP_DIR/health.stderr" "$incident_dir/health.stderr"
cp "$TMP_DIR/health.exit" "$incident_dir/health.exit"
if [ -f "$TMP_DIR/health.json" ]; then
  cp "$TMP_DIR/health.json" "$incident_dir/health.json"
fi
if [ -f "$TMP_DIR/channel-errors.txt" ]; then
  cp "$TMP_DIR/channel-errors.txt" "$incident_dir/channel-errors.txt"
fi

(
  cd "$REPO_DIR"
  git rev-parse HEAD >"$incident_dir/git-head.txt" 2>"$incident_dir/git-head.stderr" || true
  git status --short --branch >"$incident_dir/git-status.txt" 2>"$incident_dir/git-status.stderr" || true
  git diff --stat >"$incident_dir/git-diff-stat.txt" 2>"$incident_dir/git-diff-stat.stderr" || true
)

"$OPENCLAW_BIN" status --all >"$incident_dir/status.txt" 2>"$incident_dir/status.stderr" || true
"$OPENCLAW_BIN" gateway status --json >"$incident_dir/gateway-status.json" 2>"$incident_dir/gateway-status.stderr" || true

latest_log="$(latest_log_file)"
if [ -n "$latest_log" ]; then
  printf '%s\n' "$latest_log" >"$incident_dir/gateway-log.source.txt"
  tail -n "$TAIL_LINES" "$latest_log" >"$incident_dir/gateway-log.tail.txt" 2>"$incident_dir/gateway-log.tail.stderr" || true
fi

runner_status="not-configured"
if [ -n "$RUNNER_CMD" ]; then
  export OPENCLAW_RESCUE_INCIDENT_ID="$incident_id"
  export OPENCLAW_RESCUE_INCIDENT_DIR="$incident_dir"
  export OPENCLAW_RESCUE_WORKSPACE_DIR="$REPO_DIR"
  export OPENCLAW_RESCUE_SUMMARY_FILE="$incident_dir/summary.txt"
  export OPENCLAW_RESCUE_HEALTH_FILE="$incident_dir/health.json"
  export OPENCLAW_RESCUE_STATUS_FILE="$incident_dir/status.txt"
  export OPENCLAW_RESCUE_GATEWAY_LOG_FILE="$incident_dir/gateway-log.tail.txt"
  export OPENCLAW_RESCUE_FINGERPRINT="$fingerprint"

  if bash -c "$RUNNER_CMD" >"$incident_dir/runner.stdout" 2>"$incident_dir/runner.stderr"; then
    runner_status="ok"
  else
    runner_status="failed:$?"
  fi

  "$OPENCLAW_BIN" health --json --timeout "$HEALTH_TIMEOUT_MS" >"$incident_dir/post-health.json" 2>"$incident_dir/post-health.stderr" || true
fi
printf '%s\n' "$runner_status" >"$incident_dir/runner.status"

write_state "$fingerprint" "$now_epoch" "$incident_id"

notify_summary="$summary_text"
if [ -f "$incident_dir/channel-errors.txt" ]; then
  first_issue="$(head -n 1 "$incident_dir/channel-errors.txt" | single_line)"
  if [ -n "$first_issue" ]; then
    notify_summary="$notify_summary | $first_issue"
  fi
fi

notify_message="$NOTIFY_PREFIX incident=$incident_id runner=$runner_status $notify_summary"
notify_message="$(truncate_message 900 "$notify_message")"
send_notification "$notify_message"

echo "openclaw rescue watchdog: incident=$incident_id runner=$runner_status summary=$summary_text"
