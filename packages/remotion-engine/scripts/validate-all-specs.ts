import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { adaptRichSpec } from "../src/engine/parser/adaptRichSpec";
import { validateMotionSpec } from "../src/engine/parser/validateMotionSpec";

const dir = "./brands/cutmv/datasets/motion/specs";
const files = readdirSync(dir)
  .filter((f) => f.startsWith("cutmv_premium_v") && f.endsWith(".json"))
  .sort();

let pass = 0;
let fail = 0;
let premiereCount = 0;
let blobCount = 0;
let missingEnv = 0;
let totalScenes = 0;
let cursorEnabled = 0;
let logoInEndcard = 0;
let beforeBadges = 0;
let inEditorBadges = 0;

for (const file of files) {
  const fp = join(dir, file);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = JSON.parse(readFileSync(fp, "utf8")) as any;
  try {
    const spec = adaptRichSpec(raw);
    validateMotionSpec(spec);

    // Count environments from raw JSON
    for (const s of raw.scenes) {
      totalScenes++;
      const envType = s.environment?.type;
      if (envType === "premiere_timeline") premiereCount++;
      else if (envType === "abstract_blob_noise") blobCount++;
      else missingEnv++;

      // Count badges
      if (s.contextBadge === "BEFORE" || s.contextBadge === "OLD WAY") beforeBadges++;
      if (s.contextBadge === "IN EDITOR") inEditorBadges++;

      // Check for logo elements in endcard
      if (s.type === "ctaEndcard" && s.elements) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const logos = s.elements.filter((el: any) => el.kind === "logo");
        logoInEndcard += logos.length;
      }
    }

    // Cursor config
    if (raw.cursor?.enabled) cursorEnabled++;

    pass++;
    console.log(
      "PASS",
      file,
      `scenes=${raw.scenes.length}`,
      `dur=${raw.format.durationInFrames}`,
      `cursor=${raw.cursor?.enabled ? "on" : "off"}`,
    );
  } catch (e: unknown) {
    fail++;
    console.log("FAIL", file, (e as Error).message);
  }
}

console.log();
console.log("=== FINAL VALIDATION SUMMARY ===");
console.log("Total specs:", files.length);
console.log("Pass:", pass, "Fail:", fail);
console.log("Total scenes:", totalScenes);
console.log();
console.log("Environment layers:");
console.log("  premiere_timeline:", premiereCount);
console.log("  abstract_blob_noise:", blobCount);
console.log("  missing/other:", missingEnv);
console.log();
console.log("Badges:");
console.log("  BEFORE/OLD WAY:", beforeBadges);
console.log("  IN EDITOR:", inEditorBadges);
console.log();
console.log("Cursor enabled:", cursorEnabled, "/", files.length);
console.log("Logo elements in endcards:", logoInEndcard, "(should be 0)");
