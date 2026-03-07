/**
 * Batch-upgrade all specs with tightened hero config:
 * - yOffset: 240 (was 120) — brought down ~1 inch
 * - xOffset: -8 — fix SVG whitespace right-drift
 * - scale: 1.0 (was 0.85) — bigger, more premium
 * - size: 112 (new) — base tile logo px size
 * - closeFrames: 28 (was 24) — slightly longer close
 *
 * Usage: npx tsx scripts/upgrade-specs-hero-v2.ts
 */
import fs from "node:fs";
import path from "node:path";

const SPECS_DIR = path.join(process.cwd(), "brands/cutmv/datasets/motion/specs");

const files = fs
  .readdirSync(SPECS_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

let updated = 0;

for (const file of files) {
  const fp = path.join(SPECS_DIR, file);
  const raw = JSON.parse(fs.readFileSync(fp, "utf-8"));

  // Ensure brandSystem exists
  if (!raw.brandSystem) raw.brandSystem = {};

  // Update hero config
  raw.brandSystem.hero = {
    enabled: true,
    openFrames: 18,
    closeFrames: 28,
    placement: "aboveHeadline",
    yOffset: 240,
    xOffset: -8,
    scale: 1.0,
    size: 112,
  };

  fs.writeFileSync(fp, JSON.stringify(raw, null, 2) + "\n", "utf-8");
  updated++;
}

console.log("Updated " + updated + " specs with hero v2 config (yOffset=240, xOffset=-8, scale=1.0, size=112).");
