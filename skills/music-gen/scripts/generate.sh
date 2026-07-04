#!/usr/bin/env bash
# music-gen — generate a music/audio clip via OpenRouter (Google Lyria) → mp3.
#
# Usage:   generate.sh "<prompt>" [outfile.mp3]
# Env:     OPENROUTER_API_KEY (required); MUSIC_MODEL (default google/lyria-3-pro-preview)
#
# Verified 2026-07-05 against OpenRouter: audio output REQUIRES stream:true +
# an `audio` config; chunks arrive as base64 at choices[0].delta.audio.data
# (there is no final message.audio). Lyria is billed ~$0.08/song — it is NOT a
# free model despite $0 token prices, and draws down OpenRouter credit.
set -uo pipefail

PROMPT="${1:-}"
OUT="${2:-}"
MODEL="${MUSIC_MODEL:-google/lyria-3-pro-preview}"

: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY is not set}"
[ -n "$PROMPT" ] || { echo 'usage: generate.sh "<prompt>" [outfile.mp3]' >&2; exit 2; }
[ -n "$OUT" ] || OUT="music-$(date +%s).mp3"

req=$(jq -n --arg m "$MODEL" --arg p "$PROMPT" \
  '{model:$m, stream:true, modalities:["text","audio"], audio:{format:"mp3"},
    messages:[{role:"user", content:$p}]}')

raw="$(mktemp)"; trap 'rm -f "$raw"' EXIT
code=$(curl -sN -w '%{http_code}' -o "$raw" \
  https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" -d "$req")

# Pull any error message from either a non-stream error body or a streamed error event.
err_msg() {
  local m
  m=$(jq -r '.error.message // empty' "$raw" 2>/dev/null)
  [ -n "$m" ] || m=$(sed -n 's/^data: //p' "$raw" | grep -v '^\[DONE\]$' \
      | jq -r '.error.message // empty' 2>/dev/null | head -1)
  printf '%s' "$m"
}

if [ "$code" != "200" ]; then
  msg=$(err_msg)
  [ "$code" = "402" ] && msg="${msg:-Out of OpenRouter credit — top up to continue.}"
  echo "music-gen: API error ($code): ${msg:-see response}" >&2
  exit 1
fi

# Concatenate streamed base64 audio chunks, then decode to the output file.
sed -n 's/^data: //p' "$raw" | grep -v '^\[DONE\]$' \
  | jq -r '.choices[0].delta.audio.data // empty' 2>/dev/null \
  | tr -d '\n' | base64 -d > "$OUT" 2>/dev/null

sz=$(wc -c < "$OUT" 2>/dev/null || echo 0)
if [ "${sz:-0}" -lt 10000 ]; then
  msg=$(err_msg)
  echo "music-gen: no usable audio (${sz}B). ${msg:-model produced no audio for this prompt}" >&2
  rm -f "$OUT"
  exit 1
fi

echo "$OUT"
