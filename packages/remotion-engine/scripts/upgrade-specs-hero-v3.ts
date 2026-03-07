/**
 * Batch-upgrade all specs with hero v3 config:
 * - heroMark: "fd_logo_2025_white" — SVG-first rendering
 * - yOffset: 300 (was 240) — brought down another ~1 inch
 * - xOffset: 0 (was -8) — drift correction now in OPTICAL_NUDGE per asset
 * - scale: 1.0 — unchanged
 * - size: 112 — unchanged
 * - closeFrames: 28 — unchanged (dock-into-bug animation)
 *
 * Usage: npx tsx scripts/upgrade-specs-hero-v3.ts
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

  // Update hero config to v3
  raw.brandSystem.hero = {
    enabled: true,
    heroMark: "fd_logo_2025_white",
    openFrames: 18,
    closeFrames: 28,
    placement: "aboveHeadline",
    yOffset: 300,
    xOffset: 0,
    scale: 1.0,
    size: 112,
  };

  fs.writeFileSync(fp, JSON.stringify(raw, null, 2) + "\n", "utf-8");
  updated++;
}

console.log("Updated " + updated + " specs with hero v3 config (heroMark=fd_logo_2025_white, yOffset=300, xOffset=0).");
