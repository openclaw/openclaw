#!/usr/bin/env bash
set -euo pipefail

# ── Config ──
cd /home/kingler/openclaw-mabos
source ~/.local/bin/env
export $(grep '^GEMINI_API_KEY=' .env)

SCRIPT="skills/nano-banana-pro/scripts/generate_image.py"
BANNER_DIR="extensions/mabos/assets/hero-banners"
ARTWORK_DIR="extensions/mabos/assets/artwork-printables"

# Representative VividWalls artworks for each segment
# Interior Design → Intersecting Perspectives no2 (bold geometric, designer appeal)
# Hotel Lobby → Echoes (warm, inviting abstract)
# Restaurant & Bar → Fractal Double Red (dramatic, moody)
# Commercial Office → Parallelogram Chrome no4 (clean, professional monochrome)

generate_banner() {
  local SEGMENT_NAME="$1"
  local OUTPUT_FILE="$2"
  local PROMPT="$3"
  local REF_IMAGE="$4"
  local ARTWORK_IMAGE="$5"

  if [ -f "$OUTPUT_FILE" ]; then
    echo "  SKIP: $OUTPUT_FILE (exists)"
    return 0
  fi

  echo "══════════════════════════════════════════════"
  echo "  Generating: $SEGMENT_NAME"
  echo "  Output: $OUTPUT_FILE"
  echo "══════════════════════════════════════════════"

  uv run "$SCRIPT" \
    -p "$PROMPT" \
    -f "$OUTPUT_FILE" \
    -i "$REF_IMAGE" \
    -i "$ARTWORK_IMAGE" \
    -r 2K

  if [ -f "$OUTPUT_FILE" ]; then
    echo "  SUCCESS: $OUTPUT_FILE"
  else
    echo "  FAILED: $OUTPUT_FILE"
  fi
}

# ── 1. Interior Design ──
generate_banner \
  "Interior Design" \
  "$BANNER_DIR/segment-banner-interior-design.png" \
  "Ultra-wide panoramic hero banner (3.2:1 aspect ratio, 1280×400 pixels target) of an architecturally stunning modern interior design showroom or high-end residential space. The composition references the first attached image — a soaring double-height white gallery space with floor-to-ceiling grid windows on the left, polished concrete or stone floors, and a dramatic marble accent wall. The space should feel minimal, museum-quality, and aspirational.

CRITICAL — ARTWORK PLACEMENT:
A large VividWalls canvas print (from the second attached reference image) is mounted prominently on the main feature wall as the visual focal point. The artwork should be a generous 53×72 inch gallery-wrapped canvas. The colors of the artwork should pop vibrantly against the clean white walls. Below and slightly to the side, a smaller companion print (24×36 inch) of the same artwork leans casually against the wall.

INTERIOR DESIGN DETAILS:
— Designer furniture: sculptural modular seating in muted tones (cream, soft gray, maybe one accent color that echoes the artwork)
— Track lighting or recessed spotlights washing the artwork in gallery-perfect light
— The overall mood is aspirational interior design editorial — the kind of space a designer would specify for a high-net-worth client
— Cool, crisp daylight (5000-5500K) flooding through the windows, creating clean shadows
— Materials: polished concrete, white plaster, marble, brushed steel, light oak

PHOTOGRAPHIC QUALITY:
Shot on a medium format digital camera. Architectural photography with perfect verticals. Wide-angle but not distorted. The image should look like it belongs in Architectural Digest or Dezeen magazine. Shallow depth where appropriate to draw the eye to the artwork." \
  "$BANNER_DIR/ref-interior-design.jpg" \
  "$ARTWORK_DIR/intersecting-perspectives-no2-hero.png"

sleep 3

# ── 2. Hospitality Hotel Lobby ──
generate_banner \
  "Hospitality Hotel Lobby" \
  "$BANNER_DIR/segment-banner-hotel-lobby.png" \
  "Ultra-wide panoramic hero banner (3.2:1 aspect ratio, 1280×400 pixels target) of a luxurious boutique hotel lobby. The composition should evoke a world-class hospitality environment — think Aman, Edition, or Ace Hotel aesthetic. Double-height ceiling with warm ambient lighting. The space should feel welcoming yet sophisticated.

CRITICAL — ARTWORK PLACEMENT:
A large VividWalls canvas print (from the second attached reference image) is the centerpiece of the lobby, mounted on the main wall behind the reception or lounge area. The artwork is a generous 53×72 inch gallery-wrapped canvas that anchors the entire space. A second smaller print (36×48 inch) is visible on an adjacent wall or in a corridor leading deeper into the hotel.

HOTEL LOBBY DETAILS:
— Luxurious seating: deep velvet sofas, leather club chairs, brass side tables
— A sleek reception desk visible in the background or to one side
— Warm, layered lighting: pendant fixtures, recessed downlights washing the artwork, maybe a floor lamp
— Materials: warm wood paneling, natural stone, brass accents, plush textiles
— Plants: a large statement fiddle leaf fig or monstera adding life
— Color palette: warm neutrals (caramel, cream, charcoal) with the artwork providing the color accent
— The mood is 'arrive and exhale' — sophisticated hospitality that makes guests feel important
— Warm color temperature (3500-4000K) creating an inviting golden atmosphere

PHOTOGRAPHIC QUALITY:
Shot like a luxury hotel editorial for Condé Nast Traveler. Professional architectural photography with warm, inviting tones. The artwork should feel like it was curated specifically for this space." \
  "$BANNER_DIR/ref-interior-design.jpg" \
  "$ARTWORK_DIR/echoes-hero.png"

sleep 3

# ── 3. Restaurant & Bar ──
generate_banner \
  "Restaurant & Bar" \
  "$BANNER_DIR/segment-banner-restaurant-bar.png" \
  "Ultra-wide panoramic hero banner (3.2:1 aspect ratio, 1280×400 pixels target) of an upscale restaurant and bar interior. The composition references the first attached image — a sophisticated bar area with brutalist concrete architecture, warm wood paneling, designer pendant lighting clusters, a long bar counter with premium finishes, banquette seating, and a moody, atmospheric quality.

CRITICAL — ARTWORK PLACEMENT:
A large VividWalls canvas print (from the second attached reference image) is mounted on the main wall behind the seating area, replacing any existing wall art. The artwork should be a 53×72 inch gallery-wrapped canvas that adds dramatic color and energy to the warm, moody space. The geometric patterns of the artwork should complement and contrast beautifully with the architectural textures of the bar.

RESTAURANT & BAR DETAILS:
— Long marble or stone bar top with brass rail and premium bar stools
— Designer pendant lighting: sculptural fixtures creating pools of warm light
— Banquette and lounge seating with leather and linen upholstery
— Architectural elements: exposed concrete, warm wood paneling, brass details
— Bar back with glassware and bottles subtly visible
— Live plants adding organic softness to the industrial materials
— The mood is 'the place to be seen' — dramatic, intimate, design-forward
— Warm, moody lighting (2700-3200K) creating atmosphere and intimacy
— Materials: concrete, warm timber, brass, leather, natural stone

PHOTOGRAPHIC QUALITY:
Shot like a feature in Wallpaper* or Monocle magazine. Dramatic yet inviting. Rich shadows and warm highlights. The artwork should feel like the soul of the space — the piece everyone asks about." \
  "$BANNER_DIR/ref-restaurant-bar.png" \
  "$ARTWORK_DIR/fractal-double-red-hero.png"

sleep 3

# ── 4. Commercial Office ──
generate_banner \
  "Commercial Office" \
  "$BANNER_DIR/segment-banner-commercial-office.png" \
  "Ultra-wide panoramic hero banner (3.2:1 aspect ratio, 1280×400 pixels target) of a prestigious corporate office lobby. The composition references the first attached image — a grand, symmetrical corporate lobby with high ceilings, 3D textured accent walls, a central reception desk, polished dark stone floors, and a modern bench/ottoman in the center. People in professional attire move through the space with purposeful energy.

CRITICAL — ARTWORK PLACEMENT:
A large VividWalls canvas print (from the second attached reference image) is prominently displayed on the main lobby wall, positioned as the defining visual statement of the corporate space. The artwork should be a 53×72 inch gallery-wrapped canvas. Its clean geometric forms should complement the architectural precision of the lobby. A second smaller print (36×48 inch) may be visible on a perpendicular wall or in an adjacent corridor.

COMMERCIAL OFFICE DETAILS:
— Grand reception desk: white corian or marble with subtle branding
— Symmetrical architectural composition suggesting order and authority
— Polished stone floors (dark granite or marble) reflecting ceiling lights
— 3D textured or paneled accent walls flanking the artwork
— Recessed LED lighting creating a professional, bright atmosphere
— Modern bench or designer seating in the center of the lobby
— One or two professionals in business attire walking through (motion blur acceptable)
— Turnstiles or security gates subtly visible
— The mood is 'Fortune 500 headquarters' — confident, substantial, tasteful
— Cool-neutral color temperature (4500-5000K) — professional daylight
— Materials: polished stone, brushed steel, glass, white surfaces

PHOTOGRAPHIC QUALITY:
Shot like a corporate real estate marketing photo. Perfect symmetry. Sharp, professional, aspirational. The artwork should demonstrate that this company invests in culture and quality — it's not a decoration, it's a statement of values." \
  "$BANNER_DIR/ref-commercial-office.jpg" \
  "$ARTWORK_DIR/parallelogram-chrome-no4-hero.png"

echo ""
echo "═══════════════════════════════════════════════"
echo "  All segment banners generated!"
echo "═══════════════════════════════════════════════"
