#!/usr/bin/env bash
# Usage: generate.sh <prompt> [model] [n] [output_format] [output_compression]
set -euo pipefail
PROMPT="$1"
MODEL="${2:-fal-ai/nano-banana}"
N="${3:-1}"

blink ai image "$PROMPT" --model "$MODEL" --n "$N" --json
