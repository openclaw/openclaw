#!/bin/bash
# Cancel a running Bankr job
# Usage: bankr-cancel.sh <job_id>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"

# Find config file
if [ -f "$SKILL_DIR/config.json" ]; then
    CONFIG_FILE="$SKILL_DIR/config.json"
elif [ -f "$HOME/.clawdbot/skills/bankr/config.json" ]; then
    CONFIG_FILE="$HOME/.clawdbot/skills/bankr/config.json"
else
    echo "{\"error\": \"config.json not found\"}" >&2
    exit 1
fi

# Extract config
API_KEY=$(jq -r '.apiKey // empty' "$CONFIG_FILE")
API_URL=$(jq -r '.apiUrl // "https://api.bankr.bot"' "$CONFIG_FILE")

if [ -z "$API_KEY" ]; then
    echo "{\"error\": \"apiKey not set in config.json\"}" >&2
    exit 1
fi

# Get job ID
JOB_ID="$1"

if [ -z "$JOB_ID" ]; then
    echo "{\"error\": \"Usage: $0 <job_id>\"}" >&2
    exit 1
fi

# Cancel job
curl -sf -X POST "${API_URL}/agent/job/${JOB_ID}/cancel" \
  -H "X-API-Key: ${API_KEY}" \
  -H "Content-Type: application/json" \
  || {
    echo "{\"error\": \"Failed to cancel job\"}" >&2
    exit 1
  }
