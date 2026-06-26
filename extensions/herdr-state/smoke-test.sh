#!/usr/bin/env bash
set -euo pipefail

pane_id="${1:-${HERDR_PANE_ID:-}}"
if [[ -z "${pane_id}" ]]; then
  echo "usage: $0 <herdr-pane-id>" >&2
  exit 64
fi

herdr pane send-text "${pane_id}" "clear; openclaw tui"
herdr pane send-keys "${pane_id}" Enter
sleep 3
herdr pane send-text "${pane_id}" "Hello"
herdr pane send-keys "${pane_id}" Enter

for _ in {1..20}; do
  herdr pane get "${pane_id}" | python3 -c "import json,sys; r=json.load(sys.stdin)['result']['pane']; print(r.get('agent'), r.get('agent_status'), r.get('custom_status'))"
  sleep 1
done
