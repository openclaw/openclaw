#!/usr/bin/env bash
# Start an AI phone call without waiting for it to finish
# Usage: call-nowait.sh <phone_number> <system_prompt> [voice]
set -euo pipefail

PHONE="${1:?Usage: call-nowait.sh <phone_number> <system_prompt> [voice]}"
PROMPT="${2:?system_prompt is required}"
VOICE="${3:-openai:alloy}"

blink ai call "$PHONE" "$PROMPT" \
  --voice "$VOICE" \
  --no-wait \
  --json
