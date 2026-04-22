#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

review_require_cmd systemctl

if ! review_systemd_active && ! review_systemd_failed; then
  rm -f "$REVIEW_PID_FILE"
  echo "Review gateway is not running."
  exit 0
fi

systemctl --user stop "$REVIEW_SYSTEMD_UNIT" >/dev/null 2>&1 || true
for _ in $(seq 1 20); do
  if ! review_systemd_active && ! review_port_listening; then
    systemctl --user reset-failed "$REVIEW_SYSTEMD_UNIT" >/dev/null 2>&1 || true
    rm -f "$REVIEW_PID_FILE"
    echo "Review gateway stopped."
    exit 0
  fi
  sleep 1
done

systemctl --user kill "$REVIEW_SYSTEMD_UNIT" >/dev/null 2>&1 || true
systemctl --user reset-failed "$REVIEW_SYSTEMD_UNIT" >/dev/null 2>&1 || true
rm -f "$REVIEW_PID_FILE"
echo "Review gateway required forced stop."
