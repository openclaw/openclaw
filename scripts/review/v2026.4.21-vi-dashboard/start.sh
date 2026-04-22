#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

review_require_cmd jq
review_require_cmd systemctl
review_require_cmd systemd-run

if review_systemd_active; then
  echo "Review gateway is already running (pid $(review_systemd_main_pid))."
  review_repo_cmd dashboard --no-open
  exit 0
fi

"$SCRIPT_DIR/sync-config.sh" >/dev/null
review_ensure_control_ui_dist

rm -f "$REVIEW_PID_FILE"
systemctl --user stop "$REVIEW_SYSTEMD_UNIT" >/dev/null 2>&1 || true
systemctl --user reset-failed "$REVIEW_SYSTEMD_UNIT" >/dev/null 2>&1 || true

if review_port_listening; then
  echo "Review port ${REVIEW_PORT} is already in use." >&2
  review_port_owner >&2 || true
  exit 1
fi

review_export_env
systemd-run \
  --user \
  --unit "$REVIEW_SYSTEMD_UNIT_NAME" \
  --property "WorkingDirectory=$REPO_ROOT" \
  --property "Description=OpenClaw review gateway ${REVIEW_ID}" \
  --property "Restart=always" \
  --property "RestartSec=1s" \
  --setenv "OPENCLAW_PROFILE=$OPENCLAW_PROFILE" \
  --setenv "OPENCLAW_STATE_DIR=$OPENCLAW_STATE_DIR" \
  --setenv "OPENCLAW_CONFIG_PATH=$OPENCLAW_CONFIG_PATH" \
  --setenv "OPENCLAW_GATEWAY_TOKEN=$OPENCLAW_GATEWAY_TOKEN" \
  --setenv "OPENCLAW_SKIP_CHANNELS=$OPENCLAW_SKIP_CHANNELS" \
  --setenv "OPENCLAW_SKIP_CRON=$OPENCLAW_SKIP_CRON" \
  /usr/bin/env bash "$SCRIPT_DIR/launch.sh" >/dev/null

review_pid="$(review_systemd_main_pid)"
echo "${review_pid}" >"$REVIEW_PID_FILE"
if ! review_wait_for_ready "$review_pid"; then
  echo "Review gateway failed to become ready. See $REVIEW_RUN_LOG" >&2
  systemctl --user status "$REVIEW_SYSTEMD_UNIT" --no-pager --lines=40 >&2 || true
  tail -n 80 "$REVIEW_RUN_LOG" >&2 || true
  exit 1
fi

echo "Review gateway started (pid $review_pid)."
systemctl --user show \
  --property Id \
  --property ActiveState \
  --property SubState \
  --property MainPID \
  "$REVIEW_SYSTEMD_UNIT"
review_repo_cmd gateway status
review_repo_cmd dashboard --no-open
echo "Review token: $REVIEW_GATEWAY_TOKEN"
echo "Log file: $REVIEW_RUN_LOG"
