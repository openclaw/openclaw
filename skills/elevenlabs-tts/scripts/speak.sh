#!/usr/bin/env bash
set -euo pipefail

# ElevenLabs TTS script
# Usage: speak.sh "text to speak" --out /path/to/output.mp3

if [[ $# -lt 1 ]]; then
  echo "Usage: speak.sh \"text\" --out /path/to/output.mp3 [--voice ID] [--model MODEL]" >&2
  exit 1
fi

TEXT="$1"
shift

# Default voice: Rachel
VOICE_ID="21m00Tcm4TlvDq8ikWAM"
MODEL="eleven_monolingual_v1"
OUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --voice) VOICE_ID="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "$OUT" ]]; then
  echo "Error: --out required" >&2
  exit 1
fi

if [[ -z "${ELEVENLABS_API_KEY:-}" ]]; then
  echo "Error: ELEVENLABS_API_KEY environment variable required" >&2
  exit 1
fi

curl -s "https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}" \
  -H "xi-api-key: ${ELEVENLABS_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"text\":$(echo "$TEXT" | jq -Rs .),\"model_id\":\"${MODEL}\"}" \
  --output "$OUT"

echo "$OUT"
