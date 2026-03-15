#!/usr/bin/env bash
# Animate an existing image (image-to-video)
# Usage: animate.sh <prompt> <image_url> [model] [duration] [aspect_ratio]
set -euo pipefail
PROMPT="${1:-}"; IMAGE_URL="${2:-}"; MODEL="${3:-fal-ai/veo3.1/fast/image-to-video}"
DURATION="${4:-5s}"; ASPECT="${5:-auto}"
{ [ -z "$PROMPT" ] || [ -z "$IMAGE_URL" ]; } && echo "Usage: animate.sh <prompt> <image_url> [model] [duration] [aspect_ratio]" && exit 1

BODY=$(python3 -c "
import json, sys
d = {
    'prompt':       sys.argv[1],
    'image_url':    sys.argv[2],
    'model':        sys.argv[3],
    'duration':     sys.argv[4],
    'aspect_ratio': sys.argv[5],
}
print(json.dumps(d))
" "$PROMPT" "$IMAGE_URL" "$MODEL" "$DURATION" "$ASPECT")

curl -sf -X POST \
  -H "Authorization: Bearer ${BLINK_API_KEY}" \
  -H "x-blink-agent-id: ${BLINK_AGENT_ID}" \
  -H "Content-Type: application/json" \
  "${BLINK_APIS_URL:-https://core.blink.new}/api/v1/ai/video" \
  -d "$BODY"
