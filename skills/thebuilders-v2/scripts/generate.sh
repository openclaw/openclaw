#!/bin/bash
# The Builders Podcast Generator v2
# Usage: ./generate.sh "Topic Name" [output_dir]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"

TOPIC="${1:-}"
OUTPUT="${2:-./output}"

if [ -z "$TOPIC" ]; then
  echo "Usage: ./generate.sh \"Topic Name\" [output_dir]"
  echo ""
  echo "Example:"
  echo "  ./generate.sh \"OpenAI\" /tmp/openai-episode"
  exit 1
fi

cd "$SKILL_DIR"
node scripts/generate.mjs "$TOPIC" -o "$OUTPUT" "$@"
