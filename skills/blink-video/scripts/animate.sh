#!/usr/bin/env bash
# Usage: animate.sh <prompt> <image_url> [model] [duration] [aspect_ratio]
set -euo pipefail
PROMPT="$1"
IMAGE_URL="$2"
MODEL="${3:-fal-ai/veo3.1/fast/image-to-video}"
DURATION="${4:-5s}"

blink animate "$PROMPT" "$IMAGE_URL" --model "$MODEL" --duration "$DURATION" --json
