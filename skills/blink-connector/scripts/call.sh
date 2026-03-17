#!/usr/bin/env bash
# Blink Connector Call Script
# Usage: call.sh PROVIDER /endpoint [HTTP_METHOD] [JSON_PARAMS] [ACCOUNT_ID]
# Example: call.sh notion /search POST '{"query":"meeting notes"}'
set -euo pipefail
PROVIDER="${1:-}"; METHOD="${2:-}"; HTTP_METHOD="${3:-GET}"; PARAMS="${4:-{}}"; ACCOUNT_ID="${5:-}"
[ -z "$PROVIDER" ] || [ -z "$METHOD" ] && echo "Usage: call.sh PROVIDER /endpoint [GET|POST|PATCH|DELETE] [json_params]" && exit 1
BODY=$(python3 -c "
import json, sys
d = {'method': sys.argv[1], 'http_method': sys.argv[2], 'params': json.loads(sys.argv[3])}
if sys.argv[4]: d['account_id'] = sys.argv[4]
print(json.dumps(d))
" "$METHOD" "$HTTP_METHOD" "$PARAMS" "$ACCOUNT_ID")
curl -sf -X POST \
  -H "Authorization: Bearer ${BLINK_API_KEY}" \
  -H "x-blink-agent-id: ${BLINK_AGENT_ID}" \
  -H "Content-Type: application/json" \
  "${BLINK_APIS_URL:-https://core.blink.new}/v1/connectors/${PROVIDER}/execute" \
  -d "$BODY"
