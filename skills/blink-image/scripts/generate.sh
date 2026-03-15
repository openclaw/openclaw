#!/usr/bin/env bash
# Generate an image from a text prompt
# Usage: generate.sh <prompt> [model] [n] [output_format] [output_compression]
set -euo pipefail
PROMPT="${1:-}"; MODEL="${2:-fal-ai/nano-banana}"; N="${3:-1}"
OUTPUT_FORMAT="${4:-}"; OUTPUT_COMPRESSION="${5:-}"
[ -z "$PROMPT" ] && echo "Usage: generate.sh <prompt> [model] [n] [output_format] [output_compression]" && exit 1

BODY=$(python3 -c "
import json, sys
d = {
    'prompt': sys.argv[1],
    'model':  sys.argv[2],
    'n':      int(sys.argv[3]),
}
if sys.argv[4]: d['output_format']      = sys.argv[4]
if sys.argv[5]: d['output_compression'] = int(sys.argv[5])
print(json.dumps(d))
" "$PROMPT" "$MODEL" "$N" "$OUTPUT_FORMAT" "$OUTPUT_COMPRESSION")

curl -sf -X POST \
  -H "Authorization: Bearer ${BLINK_API_KEY}" \
  -H "x-blink-agent-id: ${BLINK_AGENT_ID}" \
  -H "Content-Type: application/json" \
  "${BLINK_APIS_URL:-https://core.blink.new}/api/v1/ai/image" \
  -d "$BODY"
