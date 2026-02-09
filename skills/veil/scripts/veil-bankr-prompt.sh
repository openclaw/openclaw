#!/usr/bin/env bash
# Minimal wrapper: submit a prompt to Bankr Agent API and return final response JSON.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

need_bankr_config

PROMPT="$*"
if [[ -z "$PROMPT" ]]; then
  echo "Usage: $0 <prompt>" >&2
  exit 1
fi

API_KEY=$(jq -r '.apiKey // empty' "$BANKR_CONFIG")
API_URL=$(jq -r '.apiUrl // "https://api.bankr.bot"' "$BANKR_CONFIG")

if [[ -z "$API_KEY" ]]; then
  echo "apiKey missing in $BANKR_CONFIG" >&2
  exit 1
fi

# Submit
SUBMIT=$(curl -sf -X POST "$API_URL/agent/prompt" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg prompt "$PROMPT" '{prompt: $prompt}')")

JOB_ID=$(echo "$SUBMIT" | jq -r '.jobId // empty')
if [[ -z "$JOB_ID" ]]; then
  echo "$SUBMIT" | jq . >&2
  echo "Failed to get jobId from Bankr" >&2
  exit 1
fi

# Poll
ATTEMPT=0
MAX_ATTEMPTS=150
while [[ $ATTEMPT -lt $MAX_ATTEMPTS ]]; do
  sleep 2
  STATUS=$(curl -sf -X GET "$API_URL/agent/job/$JOB_ID" -H "X-API-Key: $API_KEY")
  STATE=$(echo "$STATUS" | jq -r '.status')
  case "$STATE" in
    completed|failed|cancelled)
      echo "$STATUS" | jq .
      exit 0
      ;;
    pending|processing)
      :
      ;;
    *)
      echo "$STATUS" | jq . >&2
      ;;
  esac
  ATTEMPT=$((ATTEMPT+1))
done

echo "Timed out waiting for Bankr job: $JOB_ID" >&2
exit 1
