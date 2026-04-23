#!/usr/bin/env bash
# Keep ollama models pinned in RAM (keep_alive=-1) so user-facing requests
# never hit cold-start. Pings before ollama's default 5-minute unload window.
set -u
OLLAMA="${OLLAMA:-http://127.0.0.1:11435}"
MODELS=("qwen3.6:latest")

for m in "${MODELS[@]}"; do
  # Pre-load with the same num_ctx openclaw uses so ollama doesn't unload+reload
  # when the first real chat request arrives (which would re-trigger cold start).
  curl -sS --max-time 120 -X POST "$OLLAMA/api/generate" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"$m\",\"keep_alive\":-1,\"prompt\":\"\",\"options\":{\"num_ctx\":131072}}" >/dev/null \
    || echo "ollama-keepwarm: failed for $m" >&2
done
