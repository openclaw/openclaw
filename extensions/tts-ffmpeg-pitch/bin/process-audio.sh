#!/usr/bin/env bash
set -euo pipefail

INPUT="${OPENCLAW_TTS_INPUT:-}"
OUTPUT="${OPENCLAW_TTS_OUTPUT:-}"
PITCH="${FFMPEG_PITCH:-1.0}"
SPEED="${FFMPEG_SPEED:-1.0}"

if [[ -z "$INPUT" ]]; then
  echo "Error: OPENCLAW_TTS_INPUT env var not set" >&2
  exit 1
fi

if [[ -z "$OUTPUT" ]]; then
  echo "Error: OPENCLAW_TTS_OUTPUT env var not set" >&2
  exit 1
fi

if [[ ! -f "$INPUT" ]]; then
  echo "Error: Input file not found: $INPUT" >&2
  exit 1
fi

# Check if ffmpeg is available
if ! command -v ffmpeg &> /dev/null; then
  echo "Error: ffmpeg not found in PATH" >&2
  exit 1
fi

# Calculate ffmpeg parameters for pitch/speed modulation
# Pitch: asetrate adjusts the sample rate (lower rate = deeper pitch)
# Tempo: compensates playback speed to keep overall duration correct
# 
# Example: 18% deeper voice
#   - asetrate=48000*0.82 (reduces pitch by 18%)
#   - atempo=1.22 (speeds up to compensate, keeps duration normal)

# Calculate rate multiplier (inverse of pitch)
RATE_MULT=$(echo "scale=4; 1 / $PITCH" | bc -l)

# Calculate tempo multiplier (speed divided by rate change)
TEMPO_MULT=$(echo "scale=4; $SPEED / $RATE_MULT" | bc -l)

# Detect input format
EXT="${INPUT##*.}"
FORMAT="mp3"

if [[ "$EXT" == "opus" ]] || [[ "$EXT" == "ogg" ]]; then
  FORMAT="opus"
elif [[ "$EXT" == "wav" ]]; then
  FORMAT="wav"
fi

# Apply pitch and speed modulation
# Use a base sample rate of 48000 (works well for most TTS outputs)
ffmpeg -i "$INPUT" \
  -af "asetrate=48000*${RATE_MULT},atempo=${TEMPO_MULT}" \
  -f "$FORMAT" \
  "$OUTPUT" \
  -y \
  -loglevel error

if [[ ! -f "$OUTPUT" ]]; then
  echo "Error: ffmpeg did not create output file" >&2
  exit 1
fi
