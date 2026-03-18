#!/usr/bin/env bash
# Call the Twitter/X connector via Blink CLI
# Usage: call.sh <method_path> [GET|POST|PATCH|DELETE] [json_params]
set -euo pipefail
PROVIDER="twitter"
METHOD="${1:-}"; HTTP_METHOD="${2:-GET}"; PARAMS="${3:-{}}"
[ -z "$METHOD" ] && echo "Usage: call.sh <method_path> [GET|POST|PATCH|DELETE] [json_params]" && exit 1
blink connector exec "$PROVIDER" "$METHOD" "$PARAMS" --method "$HTTP_METHOD"
