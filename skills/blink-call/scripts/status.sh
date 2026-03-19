#!/usr/bin/env bash
# Get status of an AI phone call
# Usage: status.sh <call_id>
set -euo pipefail

CALL_ID="${1:?Usage: status.sh <call_id>}"
blink ai call-status "$CALL_ID" --json
