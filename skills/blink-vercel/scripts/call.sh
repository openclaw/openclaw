#!/usr/bin/env bash
# Call the Vercel connector via Blink CLI
# Usage: call.sh <method_path> [GET|POST|PATCH|DELETE] [json_params] [account_id]
set -euo pipefail
PROVIDER="vercel"
METHOD="${1:-}"; HTTP_METHOD="${2:-GET}"; PARAMS="${3:-{}}"; ACCOUNT="${4:-}"
[ -z "$METHOD" ] && echo "Usage: call.sh <method_path> [GET|POST|PATCH|DELETE] [json_params]" && exit 1
ACCOUNT_OPT=""; [ -n "$ACCOUNT" ] && ACCOUNT_OPT="--account $ACCOUNT"
blink connector exec "$PROVIDER" "$METHOD" "$PARAMS" --method "$HTTP_METHOD" $ACCOUNT_OPT
