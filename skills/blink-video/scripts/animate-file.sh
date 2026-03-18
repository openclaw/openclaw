#!/usr/bin/env bash
# Usage: animate-file.sh <prompt> <local_file_path> [model] [duration] [aspect_ratio]
# duration: "4s" "5s" "6s" "8s" (model-dependent)
# aspect_ratio: "16:9" "9:16" "1:1" "auto"
set -euo pipefail
PROMPT="$1"
FILE="$2"
MODEL="${3:-fal-ai/veo3.1/fast/image-to-video}"
DURATION="${4:-5s}"

blink animate "$PROMPT" "$FILE" --model "$MODEL" --duration "$DURATION" --json
