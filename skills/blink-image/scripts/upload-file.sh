#!/usr/bin/env bash
# Upload a LOCAL file to Blink storage and return a public URL.
# Use this when you have an image on disk (e.g. from a Telegram/Discord attachment)
# and need a URL to pass to edit.sh, post-with-image.sh, or any other skill.
#
# Usage: upload-file.sh <file_path>
# Returns: JSON with { "url": "https://..." }
set -euo pipefail

FILE_PATH="${1:-}"
[ -z "$FILE_PATH" ] && echo "Usage: upload-file.sh <file_path>" && exit 1
[ ! -f "$FILE_PATH" ] && echo "Error: File not found: $FILE_PATH" && exit 1

# Detect MIME type from extension
MIME="image/jpeg"
case "${FILE_PATH##*.}" in
  png)  MIME="image/png" ;;
  webp) MIME="image/webp" ;;
  gif)  MIME="image/gif" ;;
  mp4)  MIME="video/mp4" ;;
  pdf)  MIME="application/pdf" ;;
esac

FILENAME=$(basename "$FILE_PATH")

# Encode file as base64 (macOS: base64, Linux: base64 -w 0)
B64=$(base64 -w 0 "$FILE_PATH" 2>/dev/null || base64 "$FILE_PATH")

BODY=$(python3 -c "
import json, sys
print(json.dumps({'data': sys.argv[1], 'mime_type': sys.argv[2], 'filename': sys.argv[3]}))
" "$B64" "$MIME" "$FILENAME")

curl -sf -X POST \
  -H "Authorization: Bearer ${BLINK_API_KEY}" \
  -H "x-blink-agent-id: ${BLINK_AGENT_ID}" \
  -H "Content-Type: application/json" \
  "${BLINK_APIS_URL:-https://core.blink.new}/api/v1/upload" \
  -d "$BODY"
