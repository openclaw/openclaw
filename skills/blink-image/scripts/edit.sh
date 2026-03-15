#!/usr/bin/env bash
# Edit or transform an existing image using a text prompt
# Usage: edit.sh <prompt> <image_url> [model] [output_format]
set -euo pipefail
PROMPT="${1:-}"; IMAGE_URL="${2:-}"; MODEL="${3:-fal-ai/nano-banana/edit}"; OUTPUT_FORMAT="${4:-}"
{ [ -z "$PROMPT" ] || [ -z "$IMAGE_URL" ]; } && echo "Usage: edit.sh <prompt> <image_url> [model] [output_format]" && exit 1

BODY=$(python3 -c "
import json, sys
d = {
    'prompt': sys.argv[1],
    'model':  sys.argv[3],
    'images': [sys.argv[2]],
    'n':      1,
}
if sys.argv[4]: d['output_format'] = sys.argv[4]
print(json.dumps(d))
" "$PROMPT" "$IMAGE_URL" "$MODEL" "$OUTPUT_FORMAT")

curl -sf -X POST \
  -H "Authorization: Bearer ${BLINK_API_KEY}" \
  -H "x-blink-agent-id: ${BLINK_AGENT_ID}" \
  -H "Content-Type: application/json" \
  "${BLINK_APIS_URL:-https://core.blink.new}/api/v1/ai/image" \
  -d "$BODY"
