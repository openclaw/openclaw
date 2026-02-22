#!/usr/bin/env bash
# Generate audio for VedicVoice videos
# Usage:
#   generate_audio.sh elevenlabs "Your text here" output.mp3 [voice_id]
#   generate_audio.sh ai4bharat "Sanskrit text" output.wav [style]
#   generate_audio.sh tts "Text using Moltbot TTS" output.mp3

set -euo pipefail

PROVIDER="${1:?Usage: generate_audio.sh <elevenlabs|ai4bharat|tts> <text> <output> [voice/style]}"
TEXT="${2:?Missing text}"
OUTPUT="${3:?Missing output path}"
OPTION="${4:-}"

# ElevenLabs config
ELEVENLABS_API_KEY="sk_0ef7f4b291f3ca0573041ad8fb327d1bc334d496d6679d0a"
VOICE_GEORGE="JBFqnCBsd6RMkjVDRZzb"     # British storyteller (narration/docs)

# AI4Bharat local TTS
AI4BHARAT_URL="http://localhost:8765"

case "$PROVIDER" in
  elevenlabs)
    VOICE_ID="${OPTION:-$VOICE_GEORGE}"
    echo "Generating ElevenLabs audio (voice=$VOICE_ID)..."
    
    curl -s -X POST "https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}" \
      -H "xi-api-key: ${ELEVENLABS_API_KEY}" \
      -H "Content-Type: application/json" \
      -d "{
        \"text\": $(echo "$TEXT" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().strip()))'),
        \"model_id\": \"eleven_multilingual_v2\",
        \"voice_settings\": {
          \"stability\": 0.6,
          \"similarity_boost\": 0.8,
          \"style\": 0.3
        }
      }" \
      --output "$OUTPUT"
    
    SIZE=$(stat -c%s "$OUTPUT" 2>/dev/null || stat -f%z "$OUTPUT" 2>/dev/null || echo 0)
    if [ "$SIZE" -lt 1000 ]; then
      echo "WARNING: Output file very small ($SIZE bytes), may have failed" >&2
      cat "$OUTPUT" >&2
      exit 1
    fi
    echo "Saved: $OUTPUT (${SIZE} bytes)"
    ;;
    
  ai4bharat)
    STYLE="${OPTION:-chanting}"
    echo "Generating AI4Bharat audio (style=$STYLE)..."
    
    # Check if server is running
    if ! curl -s --max-time 3 "$AI4BHARAT_URL/health" > /dev/null 2>&1; then
      echo "ERROR: AI4Bharat TTS server not running at $AI4BHARAT_URL" >&2
      echo "FALLBACK: Use the VedicVoice API for cached Sanskrit TTS instead:" >&2
      echo "  curl https://api.vedicvoice.app/api/voice/tts -d '{\"text\":\"...\",\"style\":\"$STYLE\"}'" >&2
      exit 1
    fi
    
    curl -s -X POST "$AI4BHARAT_URL/tts" \
      -H "Content-Type: application/json" \
      -d "{
        \"text\": $(echo "$TEXT" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().strip()))'),
        \"style\": \"$STYLE\"
      }" \
      --output "$OUTPUT"
    
    echo "Saved: $OUTPUT"
    ;;
    
  tts)
    # Use Moltbot's built-in TTS tool (called from agent, not CLI)
    echo "NOTE: For Moltbot TTS, use the tts() tool directly from the agent."
    echo "This script mode is for reference only."
    echo "Example: tts(text='$TEXT')"
    ;;
    
  *)
    echo "Unknown provider: $PROVIDER" >&2
    echo "Supported: elevenlabs, ai4bharat, tts" >&2
    exit 1
    ;;
esac
