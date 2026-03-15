#!/usr/bin/env bash
# Generate a video from a text prompt (text-to-video)
# Usage: generate.sh <prompt> [model] [duration] [aspect_ratio] [negative_prompt] [generate_audio]
# duration: "4s" "5s" "6s" "8s" "10s" "12s"
# aspect_ratio: "16:9" "9:16" "1:1" "auto"
set -euo pipefail
PROMPT="${1:-}"; MODEL="${2:-fal-ai/veo3.1/fast}"; DURATION="${3:-5s}"
ASPECT="${4:-16:9}"; NEGATIVE="${5:-}"; AUDIO="${6:-true}"
[ -z "$PROMPT" ] && echo "Usage: generate.sh <prompt> [model] [duration] [aspect_ratio] [negative_prompt] [generate_audio]" && exit 1

BODY=$(python3 -c "
import json, sys
d = {
    'prompt':          sys.argv[1],
    'model':           sys.argv[2],
    'duration':        sys.argv[3],
    'aspect_ratio':    sys.argv[4],
    'generate_audio':  sys.argv[6].lower() not in ('false', '0', 'no'),
}
if sys.argv[5]: d['negative_prompt'] = sys.argv[5]
print(json.dumps(d))
" "$PROMPT" "$MODEL" "$DURATION" "$ASPECT" "$NEGATIVE" "$AUDIO")

curl -sf -X POST \
  -H "Authorization: Bearer ${BLINK_API_KEY}" \
  -H "x-blink-agent-id: ${BLINK_AGENT_ID}" \
  -H "Content-Type: application/json" \
  "${BLINK_APIS_URL:-https://core.blink.new}/api/v1/ai/video" \
  -d "$BODY"
