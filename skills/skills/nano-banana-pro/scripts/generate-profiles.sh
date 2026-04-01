#!/usr/bin/env bash
# Generate missing MABOS agent profile avatars using Nano Banana Pro (Gemini 3 Pro Image)
# Style: geometric low-poly portrait, flat polygon facets, light gray background
# Uses an existing avatar as style reference for consistency

set -euo pipefail

GENERATE_PY="/tmp/generate_image.py"
OUTPUT_DIR="/tmp/agent-avatars"
REFERENCE_IMG="/tmp/ceo-avatar.png"

mkdir -p "$OUTPUT_DIR"

# Base style prompt that matches existing avatars
STYLE="geometric low-poly portrait illustration, flat color polygon facets forming the face and body, clean light gray solid background, head and shoulders bust composition, professional and modern, vector-style with sharp geometric edges, digital art"

generate_avatar() {
  local agent_id="$1"
  local prompt="$2"
  local output_file="$OUTPUT_DIR/${agent_id}.png"

  if [[ -f "$output_file" ]]; then
    echo "SKIP: $agent_id (already exists)"
    return 0
  fi

  echo "GENERATING: $agent_id..."
  echo "  Prompt: ${prompt:0:80}..."

  uv run "$GENERATE_PY" \
    --prompt "$prompt" \
    --filename "$output_file" \
    --input-image "$REFERENCE_IMG" \
    --resolution "1K" \
    --api-key "$GEMINI_API_KEY" 2>&1 | sed 's/^/  /'

  if [[ -f "$output_file" ]]; then
    echo "  OK: $(du -h "$output_file" | cut -f1) saved"
  else
    echo "  FAILED: $agent_id generation failed"
  fi
  echo ""
  sleep 2
}

echo "=== Generating 5 missing agent avatars ==="
echo "Output directory: $OUTPUT_DIR"
echo ""

generate_avatar "marketing-dir" \
  "a confident professional woman in her 30s with straight shoulder-length auburn hair, wearing a sleek burgundy blazer over a cream blouse, small gold briefcase lapel pin, warm confident smile, $STYLE"

generate_avatar "sales-dir" \
  "an energetic professional man in his early 30s with short curly blonde hair, wearing a modern teal suit jacket over a white dress shirt with no tie, small silver people-connecting lapel pin, friendly approachable expression, $STYLE"

generate_avatar "compliance-dir" \
  "a composed professional woman in her 40s with dark hair pulled back in a neat bun, wearing a structured navy blue suit jacket with white blouse, small gold shield lapel pin, serious authoritative expression, $STYLE"

generate_avatar "creative-dir" \
  "a stylish professional non-binary person in their late 20s with an asymmetric undercut dyed with purple highlights, wearing a black turtleneck with a charcoal blazer, small silver fountain pen lapel pin, thoughtful creative expression, $STYLE"

generate_avatar "cs-dir" \
  "a warm approachable professional man in his mid-30s with medium-length dark brown wavy hair, wearing a soft blue cardigan over a collared white shirt, small gold speech bubble lapel pin, friendly empathetic expression, $STYLE"

echo "=== Generation complete ==="
echo "Generated files:"
ls -la "$OUTPUT_DIR"/*.png 2>/dev/null || echo "No files generated"
