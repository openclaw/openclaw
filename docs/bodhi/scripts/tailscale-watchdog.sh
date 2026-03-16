#!/usr/bin/env bash
# tailscale-watchdog.sh
# Called by OpenClaw cron every 15 minutes.
# Exits 0 (silently) if Tailscale is healthy.
# Prints ALERT:<reason> if Tailscale is down — OpenClaw sends it as Telegram message.

set -euo pipefail

TAILSCALE_BIN="/usr/bin/tailscale"
STATE_FILE="${HOME}/.openclaw/tailscale-state.json"

# Check if tailscale binary exists
if [[ ! -x "$TAILSCALE_BIN" ]]; then
    echo "ALERT: Tailscale binary not found at $TAILSCALE_BIN"
    exit 0
fi

# Get status
STATUS_JSON=$("$TAILSCALE_BIN" status --json 2>/dev/null) || {
    echo "ALERT: tailscale status failed — daemon may be down"
    exit 0
}

BACKEND_STATE=$(echo "$STATUS_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('BackendState','unknown'))" 2>/dev/null || echo "unknown")
SELF_IP=$(echo "$STATUS_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); ips=d.get('TailscaleIPs',[]); print(ips[0] if ips else 'none')" 2>/dev/null || echo "none")

# Write state for reference
python3 -c "
import json, pathlib, os
from datetime import datetime, timezone
p = pathlib.Path('$STATE_FILE')
d = {'ts': datetime.now(timezone.utc).isoformat(), 'state': '$BACKEND_STATE', 'ip': '$SELF_IP'}
p.write_text(json.dumps(d))
" 2>/dev/null || true

# Alert if not running
if [[ "$BACKEND_STATE" != "Running" ]]; then
    echo "ALERT: Tailscale is $BACKEND_STATE (expected Running). IP: $SELF_IP. bodhi1 is unreachable via Tailscale."
    exit 0
fi

# Healthy — silent exit
exit 0
