#!/bin/bash
set -euo pipefail

TURSO_URL="${TURSO_URL:-}"
TURSO_TOKEN="${TURSO_TOKEN:-}"
AUDIT_LOG="/var/log/fridaclaw/harness-audit.jsonl"

# Read last sync position
LAST_POS_FILE="/var/lib/fridaclaw/turso-sync-pos"
last_pos=0
[[ -f "$LAST_POS_FILE" ]] && last_pos=$(cat "$LAST_POS_FILE")

# Read new lines
tail -c +$((last_pos + 1)) "$AUDIT_LOG" | while read -r line; do
  # Insert into Turso
  curl -s -X POST "$TURSO_URL" \
    -H "Authorization: Bearer $TURSO_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"sql\":\"INSERT INTO audit_entries (ts,tool,args_summary,tier,result) VALUES (?,?,?,?,?)\",\"params\":$(echo "$line" | jq -c '[.ts,.tool,.args_summary,.tier,.result]')}"
done

# Update position
wc -c < "$AUDIT_LOG" > "$LAST_POS_FILE"
