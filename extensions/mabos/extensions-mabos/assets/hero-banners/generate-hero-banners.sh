#!/usr/bin/env bash
# ── VividWalls Hero Banner Generation Script ──────────────────────
#
# Uses Nano Banana Pro (Gemini 3 Pro Image) to generate hero banner
# images for each artwork, based on the Sun-Drenched Modern Entryway
# template with cooler color temperature.
#
# Each banner shows the artwork blended into an architectural interior
# scene displayed in multiple sizes (24×36", 36×48", 53×72").
#
# Usage:
#   export GEMINI_API_KEY=your_key
#   bash generate-hero-banners.sh [--dry-run] [--collection SLUG]
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
GENERATE_PY="$REPO_DIR/skills/nano-banana-pro/scripts/generate_image.py"
OUTPUT_DIR="$SCRIPT_DIR"
ARTWORK_CACHE_DIR="$SCRIPT_DIR/../artwork-printables"

# Load .env if API key not set
if [ -z "${GEMINI_API_KEY:-}" ] && [ -f "$REPO_DIR/.env" ]; then
  export "$(grep '^GEMINI_API_KEY=' "$REPO_DIR/.env")"
fi

if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "ERROR: GEMINI_API_KEY not set. Set it or add to $REPO_DIR/.env"
  exit 1
fi

DRY_RUN=false
FILTER_COLLECTION=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --collection) FILTER_COLLECTION="$2"; shift ;;
  esac
  shift 2>/dev/null || true
done

# ── Master Prompt Template ─────────────────────────────────────────
# Remixed from: Sun-Drenched Modern Entryway Architectural Photograph
# Modifications:
#   - Cooler color temperature (4500-5500K vs 3500-4000K)
#   - VividWalls artwork prominently displayed on wall
#   - Ultra-wide hero banner format (1280×400 / ~3.2:1 aspect ratio)
#   - Artwork shown in multiple sizes on display

build_prompt() {
  local ARTWORK_NAME="$1"
  local COLLECTION_NAME="$2"

  cat <<PROMPT
Architectural photograph of a sun-drenched modern interior space designed as an ultra-wide hero banner (3.2:1 panoramic landscape aspect ratio, 1280×400 pixels target). The composition is dramatically horizontal — a cinematic panoramic interior strip. The space features a split-level floor design with rich polished light oak floorboards transitioning to a raised platform with speckled cream terrazzo steps. Clean-lined architectural elements frame the space.

CRITICAL — ARTWORK PLACEMENT:
The attached artwork image ("${ARTWORK_NAME}" from the ${COLLECTION_NAME} collection by VividWalls) MUST be displayed prominently on the main feature wall as a large gallery-wrapped canvas print. The artwork is the ONLY art in the entire space and serves as the room's absolute visual centerpiece. Show the artwork in its exact colors, patterns, and proportions — perfectly preserved with no distortion, no cropping, no color shift. The canvas print appears as a premium gallery-wrapped piece with visible depth on the stretcher bars and a subtle shadow cast on the wall behind it.

Additionally, show two smaller versions of the same artwork leaning casually against the base of the wall beneath the main piece — one at approximately 24×36 inch size and one at approximately 36×48 inch size — to demonstrate the artwork's availability in multiple dimensions. These leaning prints should be clearly the same artwork at smaller scales.

INTERIOR DESIGN — COOLER TEMPERATURE:
The space is bathed in cool natural daylight streaming through large floor-to-ceiling windows and rear French doors. The color temperature is cool and crisp — approximately 5000-5500K daylight — creating a fresh, gallery-like atmosphere rather than warm golden tones. Walls are clean gallery white. The floor catches cool blue-tinted natural light reflections. Lush indoor potted plants, including a large fiddle-leaf fig, add vibrant green accents. Modern minimal furniture in light gray and white tones. A few carefully placed decorative objects in muted tones complement the artwork's palette without competing.

The overall color palette is dominated by cool neutrals, crisp whites, light ash wood, and sage green plant accents. The atmosphere is serene, airy, and gallery-like — as if photographed for a premium interior design magazine.

COMPOSITION — ULTRA-WIDE PANORAMIC:
Ultra-wide panoramic eye-level shot in 3.2:1 landscape format (like a cinematic letterbox banner). Because the image is very wide and not very tall, the composition stretches horizontally across the entire room. The artwork is centered or slightly right-of-center on the feature wall, occupying 25-35% of the frame width. The panoramic format reveals the full breadth of the room — architectural details, windows, and furniture spread across the wide frame. Leave balanced negative space on the left portion for potential text overlay. The ultra-wide crop creates an immersive, cinematic panoramic feel.

CAMERA & QUALITY:
Shot on a Phase One IQ4 150MP medium format digital back with a Canon TS-E 24mm f/3.5L II tilt-shift lens at f/8. Tilt-shift perspective correction applied — all vertical lines perfectly parallel. Cool daylight (5000-5500K) as primary light source from large windows. Subtle recessed ceiling spots (4000K) provide even ambient fill. No warm color cast — maintain cool, crisp gallery-white tones throughout. High resolution, tack-sharp corner-to-corner detail, architectural photography grade.

The final image should be indistinguishable from a photograph in Architectural Digest or Wallpaper* magazine — every surface texture, material reflection, and spatial relationship rendered with absolute photographic realism. The VividWalls artwork is the hero of the composition.
PROMPT
}

# ── Artwork Manifest ──────────────────────────────────────────────
# product_name|collection_name|cdn_url
ARTWORKS=(
  "black-mosaic-no1|Mosaic|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-black-mosaic-no1.png?v=1772911183"
  "black-mosaic-no2|Mosaic|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-black-mosaic-no2.png?v=1772911185"
  "black-mosaic-no3|Mosaic|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-black-mosaic-no3.png?v=1772911187"
  "black-mosaic-no3a|Mosaic|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-black-mosaic-no3a.png?v=1772911189"
  "black-mosaic-no3b|Mosaic|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-black-mosaic-no3b.png?v=1772911192"
  "mosaic|Mosaic|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-mosaic-hero.png?v=1772911230"
  "vivid-mosaic-no1|Mosaic|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-vivid-mosaic-no1-hero.png?v=1772911284"
  "vivid-mosaic-no2|Mosaic|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-vivid-mosaic-no2-hero.png?v=1772911286"
  "vivid-mosaic-no4|Mosaic|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-vivid-mosaic-no4-hero.png?v=1772911293"
  "vivid-mosaic-no4b|Mosaic|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-vivid-mosaic-no4b-hero.png?v=1772911293"
  "dark-kimono|Kimono|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-dark-kimono-hero_c039b7f8-31df-4b47-8737-5940bcb89c23.png?v=1772911192"
  "monochrome-kimono|Kimono|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-monochrome-kimono-hero.png?v=1772911227"
  "red-kimono|Kimono|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-red-kimono-hero.png?v=1772911265"
  "echoes|Echoes|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-echoes-hero.png?v=1772911195"
  "emergence|Emergence|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-emergence-hero.png?v=1772911197"
  "fractal-double-red|Fractal|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-fractal-double-red-hero.png?v=1772911199"
  "fractal-no1|Fractal|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-fractal-no1-hero.png?v=1772911203"
  "fractal-no2|Fractal|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-fractal-no2-hero.png?v=1772911203"
  "fractal-no3|Fractal|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-fractal-no3-hero.png?v=1772911205"
  "intersecting-perspectives-no2|Intersecting|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-intersecting-perspectives-no2-hero.png?v=1772911208"
  "intersecting-perspectives-no3|Intersecting|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-intersecting-perspectives-no3.png?v=1772911213"
  "intersecting-perspectives-no4|Intersecting|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-intersecting-perspectives-no4.png?v=1772911213"
  "intersecting-perspectives-no5a|Intersecting|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-intersecting-perspectives-no5a.png?v=1772911215"
  "intersecting-perspectives-no5b|Intersecting|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-intersecting-perspectives-no5b.png?v=1772911218"
  "intersecting-perspectives-no6a|Intersecting|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-intersecting-perspectives-no6a.png?v=1772911220"
  "intersecting-perspectives-no6b|Intersecting|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-intersecting-perspectives-no6b.png?v=1772911222"
  "intersecting-perspectives-no7a|Intersecting|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-intersecting-perspectives-no7a.png?v=1772911225"
  "intersecting-perspectives-no8a|Intersecting|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-intersecting-perspectives-no8a.png?v=1772911226"
  "noir-weave|Weave|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-noir-weave-hero.png?v=1772911233"
  "olive-weave|Weave|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-olive-weave-hero.jpg?v=1772911236"
  "plad-weave-no1|Weave|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-plad-weave-no1-hero.png?v=1772911259"
  "plad-weave-no2|Weave|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-plad-weave-no2-hero.png?v=1772911263"
  "primary-weave|Weave|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-primary-weave-hero.png?v=1772911264"
  "parallelogram-chrome-no4|Parallelogram|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-parallelogram-chrome-no4-hero.png?v=1772911237"
  "parallelogram-chrome-no4b|Parallelogram|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-parallelogram-chrome-no4b-hero.png?v=1772911239"
  "parallelogram-chrome-no5|Parallelogram|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-parallelogram-chrome-no5-hero.png?v=1772911241"
  "parallelogram-chrome-no5b|Parallelogram|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-parallelogram-chrome-no5b-hero.png?v=1772911247"
  "parallelogram-chrome-no6|Parallelogram|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-parallelogram-chrome-no6-hero.png?v=1772911245"
  "parallelogram-illusion-no1|Parallelogram|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-parallelogram-illusion-no1-hero.png?v=1772911249"
  "parallelogram-illusion-no13b|Parallelogram|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-parallelogram-illusion-no13bhero.png?v=1772911251"
  "parallelogram-illusion-no2|Parallelogram|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-parallelogram-illusion-no2-hero.png?v=1772911254"
  "parallelogram-illusion-no3|Parallelogram|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-parallelogram-illusion-no3-hero.png?v=1772911257"
  "space-form-no1|Space Form|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-space-form-no1-hero.png?v=1772911269"
  "space-form-no3|Space Form|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-space-form-no3-hero.png?v=1772911271"
  "space-form-no4|Space Form|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-space-form-no4-hero.png?v=1772911273"
  "space-form-no5|Space Form|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-space-form-no5-hero.png?v=1772911275"
  "space-form-no6|Space Form|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-space-form-no6-hero.png?v=1772911278"
  "space-form-noir-no1|Space Form|https://cdn.shopify.com/s/files/1/0785/1504/4639/files/vw-printable-space-form-noir-no1-hero.png?v=1772911281"
)

# ── Generation Loop ───────────────────────────────────────────────

TOTAL=${#ARTWORKS[@]}
SUCCESS=0
FAILED=0
SKIPPED=0

echo "═══════════════════════════════════════════════════════════"
echo "  VividWalls Hero Banner Generation"
echo "  Total artworks: $TOTAL"
echo "  Output: $OUTPUT_DIR"
echo "  Dry run: $DRY_RUN"
echo "═══════════════════════════════════════════════════════════"
echo ""

for entry in "${ARTWORKS[@]}"; do
  IFS='|' read -r PRODUCT_NAME COLLECTION_NAME CDN_URL <<< "$entry"

  # Filter by collection if specified
  if [ -n "$FILTER_COLLECTION" ] && [ "$COLLECTION_NAME" != "$FILTER_COLLECTION" ]; then
    continue
  fi

  OUTPUT_FILE="$OUTPUT_DIR/hero-banner-${PRODUCT_NAME}.png"

  # Skip if already generated
  if [ -f "$OUTPUT_FILE" ]; then
    echo "  SKIP: $PRODUCT_NAME (already exists)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  echo "──────────────────────────────────────────────────────────"
  echo "  Generating: $PRODUCT_NAME ($COLLECTION_NAME)"
  echo "  CDN: $CDN_URL"
  echo "  Output: $OUTPUT_FILE"

  # Download artwork to cache if not already there
  ARTWORK_EXT="${CDN_URL##*.}"
  ARTWORK_EXT="${ARTWORK_EXT%%\?*}"
  ARTWORK_FILE="$ARTWORK_CACHE_DIR/${PRODUCT_NAME}-hero.${ARTWORK_EXT}"

  if [ ! -f "$ARTWORK_FILE" ]; then
    echo "  Downloading artwork..."
    curl -sL -o "$ARTWORK_FILE" "$CDN_URL"
    if [ ! -f "$ARTWORK_FILE" ] || [ ! -s "$ARTWORK_FILE" ]; then
      echo "  ERROR: Failed to download artwork"
      FAILED=$((FAILED + 1))
      continue
    fi
  fi

  # Build prompt
  PROMPT=$(build_prompt "$PRODUCT_NAME" "$COLLECTION_NAME")

  if $DRY_RUN; then
    echo "  [DRY RUN] Would generate with prompt (${#PROMPT} chars)"
    echo "  [DRY RUN] Reference image: $ARTWORK_FILE"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Generate using Nano Banana Pro
  echo "  Generating image with Nano Banana Pro..."
  if uv run "$GENERATE_PY" \
    -p "$PROMPT" \
    -f "$OUTPUT_FILE" \
    -i "$ARTWORK_FILE" \
    -r 2K 2>&1; then
    echo "  SUCCESS: $OUTPUT_FILE"
    SUCCESS=$((SUCCESS + 1))
  else
    echo "  ERROR: Generation failed for $PRODUCT_NAME"
    FAILED=$((FAILED + 1))
  fi

  # Rate limit: 2 seconds between API calls
  sleep 2
done

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Generation Complete"
echo "  Success: $SUCCESS"
echo "  Failed:  $FAILED"
echo "  Skipped: $SKIPPED"
echo "  Total:   $TOTAL"
echo "═══════════════════════════════════════════════════════════"
