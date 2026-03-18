#!/usr/bin/env bash
# Generate speech audio from text via Blink AI (OpenAI TTS)
# Usage: speak.sh <text> [voice] [model] [output_file]
# Saves audio to a file and prints the file path
# Voices: alloy (default), echo, fable, onyx, nova, shimmer
set -euo pipefail
TEXT="${1:-}"; VOICE="${2:-alloy}"; MODEL="${3:-tts-1}"
OUTPUT="${4:-/tmp/blink-speech-$$.mp3}"
[ -z "$TEXT" ] && echo "Usage: speak.sh <text> [voice] [model] [output_file]" && exit 1
blink ai speech "$TEXT" --voice "$VOICE" --model "$MODEL" --output "$OUTPUT"
echo "Audio saved to: $OUTPUT"
echo "$OUTPUT"
