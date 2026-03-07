/**
 * Brand system reset — simplify to 2-layer system (no corner bug).
 *
 * - bug: disabled (removed entirely from rendering)
 * - hero: enabled, fd_logo_new, placement center, openFrames 20, closeFrames 26, size 140
 * - endcard: enabled, showLastFrames 60, bottomOffset 72
 * - cursor: scale 2.25, profile FAST_CLICKY, idleBehavior activeHover
 *
 * Usage: npx tsx scripts/upgrade-specs-brand-reset.ts
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

  // ── Brand system: simplified 2-layer ──
  raw.brandSystem = {
    bug: { enabled: false },
    hero: {
      enabled: true,
      heroMark: "fd_logo_new",
      placement: "center",
      openFrames: 20,
      closeFrames: 26,
      size: 140,
      scale: 1.0,
      xOffset: 0,
      yOffset: 0,
    },
    endcard: {
      enabled: true,
      style: "lockupA",
      showLastFrames: 60,
      bottomOffset: 72,
    },
  };

  // ── Cursor: bump scale to 2.25 ──
  if (raw.cursor) {
    raw.cursor.scale = 2.25;
  }

  // ── Remove any per-scene bug overrides (no bug anymore) ──
  if (raw.scenes && Array.isArray(raw.scenes)) {
    for (const scene of raw.scenes) {
      if (scene.brandOverlay?.bug) {
        delete scene.brandOverlay.bug;
      }
      // Clean up empty brandOverlay objects
      if (scene.brandOverlay && Object.keys(scene.brandOverlay).length === 0) {
        delete scene.brandOverlay;
      }
    }
  }

  fs.writeFileSync(fp, JSON.stringify(raw, null, 2) + "\n", "utf-8");
  updated++;
}

console.log("Brand reset: updated " + updated + " specs (bug off, hero center fd_logo_new, endcard lockupA, cursor 2.25).");
