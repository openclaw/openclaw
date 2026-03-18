#!/usr/bin/env bash
# Upload a LOCAL file to Blink storage and return a public URL.
# Use this when you have an image on disk (e.g. from a Telegram/Discord attachment)
# and need a URL to pass to edit.sh, post-with-image.sh, or any other skill.
#
# Usage: upload-file.sh <file_path>
# Returns: JSON with { "url": "https://..." }
set -euo pipefail

FILE="${1:-}"
[ -z "$FILE" ] && echo "Usage: upload-file.sh <file_path>" && exit 1
[ ! -f "$FILE" ] && echo "Error: File not found: $FILE" && exit 1

DATA=$(base64 -i "$FILE" 2>/dev/null || base64 "$FILE")
MIME_TYPE=$(file --mime-type -b "$FILE" 2>/dev/null || echo "image/jpeg")
FILENAME=$(basename "$FILE")

curl -sS -X POST \
  -H "Authorization: Bearer ${BLINK_API_KEY}" \
  -H "x-blink-agent-id: ${BLINK_AGENT_ID}" \
  -H "Content-Type: application/json" \
  "${BLINK_APIS_URL:-https://core.blink.new}/api/v1/upload" \
  -d "{\"data\": \"${DATA}\", \"mime_type\": \"${MIME_TYPE}\", \"filename\": \"${FILENAME}\"}"
