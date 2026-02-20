#!/bin/bash
# capture-site.sh - Capture website at multiple viewports
# Usage: ./capture-site.sh <URL> [output_dir]

set -e

URL="${1:?Usage: capture-site.sh <URL> [output_dir]}"
OUTPUT_DIR="${2:-/tmp/visual-verify}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

mkdir -p "$OUTPUT_DIR"

echo "📸 Capturing: $URL"
echo "📁 Output: $OUTPUT_DIR"

# Desktop (1280x800)
echo "  → Desktop (1280x800)..."
npx playwright screenshot "$URL" "$OUTPUT_DIR/desktop-$TIMESTAMP.png" \
  --viewport-size=1280,800 --wait-for-timeout=2000 2>/dev/null

# Tablet (768x1024)
echo "  → Tablet (768x1024)..."
npx playwright screenshot "$URL" "$OUTPUT_DIR/tablet-$TIMESTAMP.png" \
  --viewport-size=768,1024 --wait-for-timeout=2000 2>/dev/null

# Mobile (375x812)
echo "  → Mobile (375x812)..."
npx playwright screenshot "$URL" "$OUTPUT_DIR/mobile-$TIMESTAMP.png" \
  --viewport-size=375,812 --wait-for-timeout=2000 2>/dev/null

# Text dump
echo "  → Text structure..."
lynx -dump -width=80 "$URL" > "$OUTPUT_DIR/text-$TIMESTAMP.txt" 2>/dev/null || true

# Mobile text (narrow)
lynx -dump -width=40 "$URL" > "$OUTPUT_DIR/text-mobile-$TIMESTAMP.txt" 2>/dev/null || true

echo "✅ Capture complete"
echo ""
echo "Files:"
ls -la "$OUTPUT_DIR"/*-$TIMESTAMP.* 2>/dev/null

# Output paths for consumption
echo ""
echo "DESKTOP=$OUTPUT_DIR/desktop-$TIMESTAMP.png"
echo "TABLET=$OUTPUT_DIR/tablet-$TIMESTAMP.png"
echo "MOBILE=$OUTPUT_DIR/mobile-$TIMESTAMP.png"
echo "TEXT=$OUTPUT_DIR/text-$TIMESTAMP.txt"
