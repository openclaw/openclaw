#!/usr/bin/env bash
# Transcribe audio to text via Blink AI (Whisper)
# Usage: transcribe.sh <file_or_url> [language] [model]
#   file_or_url: local file path (/data/audio.mp3) OR public https:// URL
# Examples:
#   transcribe.sh /data/recording.mp3
#   transcribe.sh /data/meeting.wav en
#   transcribe.sh https://example.com/podcast.mp3 fr
set -euo pipefail
INPUT="${1:-}"; LANGUAGE="${2:-}"; MODEL="${3:-fal-ai/whisper}"
[ -z "$INPUT" ] && echo "Usage: transcribe.sh <file_or_url> [language] [model]" && exit 1
LANG_OPT=""
[ -n "$LANGUAGE" ] && LANG_OPT="--language $LANGUAGE"
blink ai transcribe "$INPUT" $LANG_OPT --model "$MODEL"
