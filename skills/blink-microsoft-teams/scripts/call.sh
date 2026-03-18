#!/usr/bin/env bash
# Generic Blink connector call via Blink CLI
# Usage: call.sh PROVIDER /endpoint [GET|POST|PATCH|DELETE] [json_params] [account_id]
# Example: call.sh notion /search POST '{"query":"meeting notes"}'
set -euo pipefail
PROVIDER="${1:-}"; METHOD="${2:-}"; HTTP_METHOD="${3:-GET}"; PARAMS="${4:-{}}"; ACCOUNT="${5:-}"
[ -z "$PROVIDER" ] || [ -z "$METHOD" ] && echo "Usage: call.sh PROVIDER /endpoint [GET|POST|PATCH|DELETE] [json_params]" && exit 1
ACCOUNT_OPT=""; [ -n "$ACCOUNT" ] && ACCOUNT_OPT="--account $ACCOUNT"
blink connector exec "$PROVIDER" "$METHOD" "$PARAMS" --method "$HTTP_METHOD" $ACCOUNT_OPT
