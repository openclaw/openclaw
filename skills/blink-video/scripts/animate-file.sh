#!/usr/bin/env bash
# Animate a LOCAL image file (image-to-video) — no URL needed.
# Use when the user has uploaded a photo via Telegram/Discord/Slack attachment.
# Uploads the file to Blink storage first, then animates it.
#
# Usage: animate-file.sh <prompt> <local_file_path> [model] [duration] [aspect_ratio]
# duration: "4s" "5s" "6s" "8s" (model-dependent)
# aspect_ratio: "16:9" "9:16" "1:1" "auto"
set -euo pipefail

PROMPT="${1:-}"; FILE_PATH="${2:-}"; MODEL="${3:-fal-ai/veo3.1/fast/image-to-video}"
DURATION="${4:-5s}"; ASPECT="${5:-auto}"

{ [ -z "$PROMPT" ] || [ -z "$FILE_PATH" ]; } && echo "Usage: animate-file.sh <prompt> <local_file_path> [model] [duration] [aspect_ratio]" && exit 1
[ ! -f "$FILE_PATH" ] && echo "Error: File not found: $FILE_PATH" && exit 1

# Detect MIME type from extension
MIME="image/jpeg"
case "${FILE_PATH##*.}" in
  png)  MIME="image/png" ;;
  webp) MIME="image/webp" ;;
  gif)  MIME="image/gif" ;;
esac

FILENAME=$(basename "$FILE_PATH")

# Encode and upload to get a public URL
B64=$(base64 -w 0 "$FILE_PATH" 2>/dev/null || base64 "$FILE_PATH")

UPLOAD_BODY=$(python3 -c "
import json, sys
print(json.dumps({'data': sys.argv[1], 'mime_type': sys.argv[2], 'filename': sys.argv[3]}))
" "$B64" "$MIME" "$FILENAME")

UPLOAD=$(curl -sf -X POST \
  -H "Authorization: Bearer ${BLINK_API_KEY}" \
  -H "x-blink-agent-id: ${BLINK_AGENT_ID}" \
  -H "Content-Type: application/json" \
  "${BLINK_APIS_URL:-https://core.blink.new}/api/v1/upload" \
  -d "$UPLOAD_BODY")

IMAGE_URL=$(echo "$UPLOAD" | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['url'])")

# Now animate with the uploaded URL
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
