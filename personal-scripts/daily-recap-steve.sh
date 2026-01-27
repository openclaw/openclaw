#!/bin/bash
# Daily recap with Steve posterboard image - reads memory and generates visual recap

# GEMINI_API_KEY from moltbot.json skills.entries.nano-banana-pro.apiKey
# The agent passes this when running the script

MEMORY_FILE="/Users/steve/clawd/memory/$(date +%Y-%m-%d).md"
DATE=$(date +%Y-%m-%d)
OUTPUT="/tmp/steve-recap-$DATE.png"
STEVE_REF="/Users/steve/clawd/assets/steve-full.jpg"

# Check if today's memory file exists and has content
if [ ! -f "$MEMORY_FILE" ] || [ ! -s "$MEMORY_FILE" ]; then
    # No output = silent ack
    exit 0
fi

# Extract key accomplishments (lines with ✅ or **Fix** or **Problem**)
ITEMS=$(grep -E "^- ✅|^\*\*.*Fix|^### " "$MEMORY_FILE" | head -6 | sed 's/^- ✅ //' | sed 's/^### //' | sed 's/\*\*//g' | tr '\n' ', ' | sed 's/, $//')

if [ -z "$ITEMS" ] || [ ${#ITEMS} -lt 10 ]; then
    # No output = silent ack
    exit 0
fi

# Generate Steve posterboard image using reference
PROMPT="Transform this character into a scene: Steve the wolf holding a posterboard showing today's accomplishments, office background, proud expression, 3D Pixar-style. Items on board: $ITEMS"

uv run /Users/steve/clawd/skills/nano-banana-pro/scripts/generate_image.py \
  --input-image "$STEVE_REF" \
  --prompt "$PROMPT" \
  --filename "$OUTPUT" \
  --resolution 1K > /dev/null 2>&1

# Output result
DAY_NAME=$(date '+%A, %B %d')
if [ -f "$OUTPUT" ]; then
  echo "🐺📋 Daily Recap - $DAY_NAME"
  echo "MEDIA:$OUTPUT"
else
  # Fallback to text if image fails
  echo "🐺📋 Daily Recap - $DAY_NAME"
  echo ""
  echo "$ITEMS"
fi
