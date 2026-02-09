#!/bin/bash
# Submit a prompt to Bankr Agent API
# Returns job ID for polling

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"

# Find config file
if [ -f "$SKILL_DIR/config.json" ]; then
    CONFIG_FILE="$SKILL_DIR/config.json"
elif [ -f "$HOME/.clawdbot/skills/bankr/config.json" ]; then
    CONFIG_FILE="$HOME/.clawdbot/skills/bankr/config.json"
else
    echo "{\"error\": \"config.json not found. Create it with your API key from https://bankr.bot/api\"}" >&2
    exit 1
fi

# Extract config
API_KEY=$(jq -r '.apiKey // empty' "$CONFIG_FILE")
API_URL=$(jq -r '.apiUrl // "https://api.bankr.bot"' "$CONFIG_FILE")

if [ -z "$API_KEY" ]; then
    echo "{\"error\": \"apiKey not set in config.json\"}" >&2
    exit 1
fi

# Get prompt from argument
PROMPT="$*"

if [ -z "$PROMPT" ]; then
    echo "{\"error\": \"Usage: $0 <prompt>\"}" >&2
    exit 1
fi

# Submit prompt
curl -sf -X POST "${API_URL}/agent/prompt" \
  -H "X-API-Key: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg prompt "$PROMPT" '{prompt: $prompt}')" \
  || {
    STATUS=$?
    if [ $STATUS -eq 22 ]; then
      echo "{\"error\": \"API request failed. Check your API key at https://bankr.bot/api\"}" >&2
    else
      echo "{\"error\": \"Network error. Please check your connection.\"}" >&2
    fi
    exit 1
  }
