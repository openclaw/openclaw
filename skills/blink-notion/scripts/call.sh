#!/usr/bin/env bash
# Call the Notion connector via Blink AI Gateway
# Usage: call.sh <method_path> [GET|POST|PATCH|DELETE] [json_params] [account_id]
set -euo pipefail
PROVIDER="notion"; METHOD="${1:-}"; HTTP_METHOD="${2:-GET}"; PARAMS="${3:-{}}"; ACCOUNT="${4:-}"
[ -z "$METHOD" ] && echo "Usage: call.sh <method_path> [GET|POST|PATCH|DELETE] [json_params]" && exit 1
BODY=$(python3 -c "
import json, sys
d = {'method': sys.argv[1], 'http_method': sys.argv[2], 'params': json.loads(sys.argv[3])}
if sys.argv[4]: d['account_id'] = sys.argv[4]
print(json.dumps(d))
" "$METHOD" "$HTTP_METHOD" "$PARAMS" "$ACCOUNT")
curl -sf -X POST \
  -H "Authorization: Bearer ${BLINK_API_KEY}" \
  -H "x-blink-agent-id: ${BLINK_AGENT_ID}" \
  -H "Content-Type: application/json" \
  "${BLINK_APIS_URL:-https://core.blink.new}/v1/connectors/${PROVIDER}/execute" \
  -d "$BODY"
