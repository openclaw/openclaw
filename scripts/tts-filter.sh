#!/bin/bash
# tts-filter.sh — Dual filter for voice+text from a single source message
# Usage: tts-filter.sh "Full message text" [output.ogg]
#
# Produces TWO outputs from one input:
#   1. VOICE (.ogg): code/tables stripped, <tts> content spoken
#   2. TEXT (stdout): <tts> tags stripped, everything else preserved
#
# Design:
#   - Write ONE message with optional <tts>spoken summary</tts> after technical blocks
#   - Code fences (```...```) and table lines (|...|) auto-stripped from voice
#   - <tts>...</tts> content is SPOKEN in voice, HIDDEN in text
#   - All filtering is purely algorithmic, no AI

set -euo pipefail

VOICE_ID="WAhoMTNdLdMoq1j3wf3I"
RAW="$1"
OGG_OUTPUT="${2:-/tmp/nicki_voice.ogg}"
MP3_TMP="/tmp/nicki_voice_$$.mp3"

# --- TEXT OUTPUT (for chat) ---
# Strip <tts>...</tts> tags entirely — user sees clean message
TEXT_CLEAN=$(echo "$RAW" | perl -0777 -pe '
  s/<tts>.*?<\/tts>//gs;
  s/\n{3,}/\n\n/g;
  s/^\s+//; s/\s+$//;
')

# --- VOICE OUTPUT (for TTS) ---
# 1. Extract <tts> content and replace code blocks near them
# 2. Strip remaining code fences and tables
# 3. Remove <tts> tags but keep their content
VOICE_CLEAN=$(echo "$RAW" | perl -0777 -pe '
  # Strip markdown code fences (matches TypeScript preprocessTtsText behavior)
  s/^\s*```[^\n]*\n.*?^\s*```\s*$//gsm;
  # Strip markdown table lines (|...|) — matches TypeScript: start AND end with pipe
  s/^\|.*\|$//gm;
  # Unwrap <tts> tags — keep inner content for speaking
  s/<tts>(.*?)<\/tts>/$1/gs;
  # Clean up excessive blank lines
  s/\n{3,}/\n\n/g;
  s/^\s+//; s/\s+$//;
')

# Output clean text to stdout
echo "---TEXT---"
echo "$TEXT_CLEAN"
echo "---END---"

# Skip voice if nothing to speak
if [ -z "$VOICE_CLEAN" ] || [ ${#VOICE_CLEAN} -lt 3 ]; then
    echo "SKIP: Nothing to speak after filtering" >&2
    exit 0
fi

# Generate speech from voice-filtered text
sag -v "$VOICE_ID" -o "$MP3_TMP" --play=false "$VOICE_CLEAN" 2>/dev/null

# Convert to opus .ogg for Telegram
ffmpeg -y -i "$MP3_TMP" -c:a libopus -b:a 64k "$OGG_OUTPUT" 2>/dev/null

# Cleanup temp mp3
rm -f "$MP3_TMP"

echo "---VOICE---"
echo "$OGG_OUTPUT"
