/**
 * Batch-upgrade all specs with brandSystem config.
 *
 * Sets:
 * - brandSystem.bug: { enabled: true, corner: "tl", opacity: 0.45, scale: 0.55 }
 * - brandSystem.hero: { enabled: true, openFrames: 18, closeFrames: 24, placement: "aboveHeadline", yOffset: 120, scale: 0.85 }
 * - brandSystem.endcard: { enabled: true, style: "lockupA" }
 *
 * Also sets brandOverlay on ctaEndcard scenes to disable hero (endcard handles branding).
 *
 * Usage: npx tsx scripts/upgrade-specs-brandsystem.ts
 */
import fs from "node:fs";
import path from "node:path";

const SPECS_DIR = path.join(process.cwd(), "../../data/datasets/cutmv/motion/specs");

const files = fs
  .readdirSync(SPECS_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

let updated = 0;

for (const file of files) {
  const fp = path.join(SPECS_DIR, file);
  const raw = JSON.parse(fs.readFileSync(fp, "utf-8"));

  // Add brandSystem at spec level
  raw.brandSystem = {
    bug: {
      enabled: true,
      corner: "tl",
      opacity: 0.45,
      scale: 0.55,
    },
    hero: {
      enabled: true,
      openFrames: 18,
      closeFrames: 24,
      placement: "aboveHeadline",
      yOffset: 120,
      scale: 0.85,
    },
    endcard: {
      enabled: true,
      style: "lockupA",
    },
  };

  // On ctaEndcard scenes, disable hero logo (endcard handles branding)
  if (raw.scenes) {
    for (const scene of raw.scenes) {
      if (scene.type === "ctaEndcard" || scene.type === "ctaEnd") {
        scene.brandOverlay = {
          hero: { enabled: false },
          bug: { enabled: false },
        };
      }
    }
  }

  fs.writeFileSync(fp, JSON.stringify(raw, null, 2) + "\n", "utf-8");
  updated++;
}

console.log("Updated " + updated + " specs with brandSystem config.");
