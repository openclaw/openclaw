/**
 * configureOutputAnchors — Pixel-perfect tap-target anchors for
 * ConfigureOutputCard, in content-rect-local coordinates.
 *
 * Computed from the JSX layout of ConfigureOutputCard:
 *   Title (18px font)           y ≈ 0..22
 *   Quick Start card            y ≈ 36..99  (marginTop:14, padding:14)
 *   "ASPECT RATIO" label        y ≈ 115..131 (marginTop:16)
 *   Pill row                    y ≈ 141..173 (marginTop:10, 3 pills)
 *   "OUTPUT FORMATS" label      y ≈ 191..207 (marginTop:18)
 *   Toggle column               y starts 217 (marginTop:10)
 *     Toggle 0: center y ≈ 242  (height ~50, gap 10)
 *     Toggle 1: center y ≈ 302
 *     Toggle 2: center y ≈ 362
 *     Toggle 3: center y ≈ 422  (only if 4 toggles)
 *   Progress bar (if shown)     y ≈ after last toggle + 14
 *   CTA button                  y ≈ after progress + 16
 *
 * X coordinates:
 *   Content area is 776px wide.
 *   Toggle switches are right-aligned (x ≈ 740 hits switch center)
 *   Pills are left-aligned in a flex row with gap:10
 *   CTA is full-width, center x ≈ 388
 */

export type AnchorPx = { x: number; y: number };

/**
 * Build anchor map for a given toggle count.
 * Supports 3-toggle and 4-toggle configs.
 */
export function buildConfigureOutputAnchors(
  toggleLabels: string[],
  aspectPills: string[],
): Record<string, AnchorPx> {
  const anchors: Record<string, AnchorPx> = {};

  // ── Aspect pills ──
  // Pill row starts at y ≈ 141, pill height ≈ 32, center y ≈ 157
  // Pills are in a flex row: first pill at x ≈ 40, then spaced by ~(pillWidth + 10)
  // Each pill is roughly 60-80px wide depending on text (padding 14px each side + text)
  // For 3 pills: approximate centers at x ≈ 50, 130, 220
  const pillY = 157;
  const pillStartX = 50;
  const pillSpacing = 90;
  for (let i = 0; i < aspectPills.length; i++) {
    const key = `aspect.${aspectPills[i]}`;
    anchors[key] = { x: pillStartX + i * pillSpacing, y: pillY };
  }

  // ── Toggle switches ──
  // Toggle switch knob center X: right side of content area
  // Content width 776, toggle row has padding 14 on right, switch is 44px wide
  // Switch center x ≈ 776 - 14 - 22 = 740
  const switchCenterX = 740;
  const toggleStartY = 242; // first toggle center Y
  const toggleSpacing = 60; // 50px row height + 10px gap

  for (let i = 0; i < toggleLabels.length; i++) {
    const label = toggleLabels[i].toLowerCase();
    const key = `toggle.${label}`;
    anchors[key] = { x: switchCenterX, y: toggleStartY + i * toggleSpacing };
  }

  // ── CTA button ──
  // After last toggle + progress bar space
  const lastToggleBottom = toggleStartY + (toggleLabels.length - 1) * toggleSpacing + 25;
  // Progress bar: marginTop 14 + height 6 = 20. CTA: marginTop 16 + padding 14 = 30
  // CTA center Y ≈ lastToggleBottom + 20 + 16 + 15
  const ctaCenterY = lastToggleBottom + 51;
  anchors["button.start"] = { x: 388, y: ctaCenterY };
  anchors["button.generate"] = { x: 388, y: ctaCenterY }; // alias

  // ── Header / title ──
  // Card title is at y ≈ 11 (18px font), centered-ish
  anchors["header.title"] = { x: 220, y: 11 };

  // ── Toggle labels (left side — for cursor hover / emphasis) ──
  const toggleLabelX = 80; // left side of toggle row
  for (let i = 0; i < toggleLabels.length; i++) {
    const label = toggleLabels[i].toLowerCase();
    anchors[`label.${label}`] = { x: toggleLabelX, y: toggleStartY + i * toggleSpacing };
  }

  // ── Section labels ──
  anchors["label.aspect_ratio"] = { x: 100, y: 120 };
  anchors["label.output_formats"] = { x: 120, y: 198 };

  // ── Quick start card area ──
  anchors["quickstart"] = { x: 388, y: 67 };

  // ── Progress bar ──
  const progressY = lastToggleBottom + 14 + 3; // marginTop 14, height 6, center at +3
  anchors["progress"] = { x: 388, y: progressY };

  return anchors;
}

/**
 * Default anchors for the standard 3-toggle config.
 */
export const DEFAULT_ANCHORS = buildConfigureOutputAnchors(
  ["CLIPS", "GIFS", "THUMBNAILS"],
  ["9:16", "1:1", "16:9"],
);
