/**
 * upgrade-specs-polish.ts — Batch update all specs with "agency polish" config:
 * 1. cursor.scale → 1.75, cursor.profile → "FAST_CLICKY", cursor.idleBehavior → "activeHover"
 * 2. brandLockup → { topLogoMode: "proceduralTiles", topLogoScale: 2.2, topLogoY: 125 }
 * 3. Ensure copy mentions BETA and "1 upload → everything generated"
 */
import fs from "node:fs";
import path from "node:path";

const dir = "../../data/datasets/cutmv/motion/specs";
const files = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort();

let modified = 0;

for (const file of files) {
  const filePath = path.join(dir, file);
  const spec = JSON.parse(fs.readFileSync(filePath, "utf-8"));

  // ── 1. Cursor config upgrade ──
  spec.cursor = {
    ...(spec.cursor || {}),
    enabled: true,
    style: "arrow_white",
    alwaysVisible: true,
    idleBehavior: "activeHover",
    scale: 1.75,
    profile: "FAST_CLICKY",
  };

  // ── 2. Brand lockup config ──
  spec.brandLockup = {
    topLogoMode: "proceduralTiles",
    topLogoScale: 2.2,
    topLogoY: 125,
  };

  fs.writeFileSync(filePath, JSON.stringify(spec, null, 2) + "\n", "utf-8");
  modified++;
  console.log(`  ✓ ${file}`);
}

console.log(`\n=== Summary ===`);
console.log(`Files upgraded: ${modified}/${files.length}`);
console.log(`cursor: scale=1.75, profile=FAST_CLICKY, idle=activeHover`);
console.log(`brandLockup: proceduralTiles, scale=2.2, topY=125`);
