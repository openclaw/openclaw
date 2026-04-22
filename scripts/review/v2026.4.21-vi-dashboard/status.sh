#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

review_print_summary

if review_systemd_active; then
  echo "unit_state=active"
elif review_systemd_failed; then
  echo "unit_state=failed"
else
  echo "unit_state=inactive"
fi

review_pid="$(review_systemd_main_pid || true)"
if [[ -n "$review_pid" && "$review_pid" != "0" ]]; then
  echo "pid=${review_pid}"
else
  echo "pid=stopped"
fi

if review_port_listening; then
  echo "port_status=listening"
  echo "port_owner=$(review_port_owner)"
else
  echo "port_status=stopped"
fi

if review_port_listening && review_gateway_connect_ok; then
  review_repo_cmd gateway status
  exit 0
fi

echo "gateway_status=unreachable" >&2
exit 1
