#!/usr/bin/env bash
# Usage: edit.sh <prompt> <image_url> [model] [output_format]
set -euo pipefail
PROMPT="$1"
IMAGE_URL="$2"
MODEL="${3:-fal-ai/nano-banana/edit}"

blink ai image-edit "$PROMPT" "$IMAGE_URL" --model "$MODEL" --json
