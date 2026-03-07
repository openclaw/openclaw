import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

const dir = "./brands/cutmv/datasets/motion/specs";
const files = readdirSync(dir)
  .filter((f) => f.startsWith("cutmv_premium_v") && f.endsWith(".json"))
  .sort();

let updated = 0;
let logoElementsRemoved = 0;
let badgesUpdated = 0;
let cursorAdded = 0;

for (const file of files) {
  const fp = join(dir, file);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = JSON.parse(readFileSync(fp, "utf8")) as any;
  let changed = false;

  // 1. Add cursor config at spec root
  if (raw.cursor === undefined) {
    raw.cursor = {
      enabled: true,
      style: "arrow_white",
      alwaysVisible: true,
      idleBehavior: "subtleDrift",
      scale: 1.0,
      shadow: 0.22,
    };
    cursorAdded++;
    changed = true;
  }

  // 2. Update contextBadge per scene
  for (const scene of raw.scenes) {
    const envType = scene.environment?.type;
    const sceneType = scene.type;

    // Premiere timeline + text scenes = BEFORE / OLD WAY
    if (envType === "premiere_timeline") {
      if (
        sceneType === "impactText" ||
        sceneType === "hookText" ||
        sceneType === "stepScene"
      ) {
        if (
          scene.contextBadge !== "BEFORE" &&
          scene.contextBadge !== "OLD WAY"
        ) {
          scene.contextBadge = "BEFORE";
          badgesUpdated++;
          changed = true;
        }
      }
      // UI scenes on premiere_timeline keep "IN EDITOR" — that's the product demo
    }

    // 3. Remove logo elements from ctaEndcard scenes
    if (sceneType === "ctaEndcard" && scene.elements) {
      const before = scene.elements.length;
      scene.elements = scene.elements.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (el: any) => el.kind !== "logo",
      );
      const removed = before - scene.elements.length;
      if (removed > 0) {
        logoElementsRemoved += removed;
        changed = true;
      }
    }
  }

  if (changed) {
    writeFileSync(fp, JSON.stringify(raw, null, 2) + "\n");
    updated++;
  }
}

console.log("=== BATCH UPDATE SUMMARY ===");
console.log("Files updated:", updated);
console.log("Cursor configs added:", cursorAdded);
console.log("Logo elements removed from endcards:", logoElementsRemoved);
console.log("Context badges updated:", badgesUpdated);
