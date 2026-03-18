#!/usr/bin/env bash
# Usage: generate.sh <prompt> [model] [duration] [aspect_ratio] [negative_prompt] [generate_audio]
# duration: "4s" "5s" "6s" "8s" "10s" "12s"
# aspect_ratio: "16:9" "9:16" "1:1" "auto"
set -euo pipefail
PROMPT="$1"
MODEL="${2:-fal-ai/veo3.1/fast}"
DURATION="${3:-5s}"
ASPECT="${4:-16:9}"

blink ai video "$PROMPT" --model "$MODEL" --duration "$DURATION" --aspect "$ASPECT" --json
