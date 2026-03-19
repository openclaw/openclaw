#!/usr/bin/env bash
# Make an AI phone call and wait for completion
# Usage: call.sh <phone_number> <system_prompt> [voice] [max_duration_seconds]
set -euo pipefail

PHONE="${1:?Usage: call.sh <phone_number> <system_prompt> [voice] [max_duration]}"
PROMPT="${2:?system_prompt is required}"
VOICE="${3:-openai:alloy}"
MAX_DURATION="${4:-300}"

blink ai call "$PHONE" "$PROMPT" \
  --voice "$VOICE" \
  --max-duration "$MAX_DURATION" \
  --json
