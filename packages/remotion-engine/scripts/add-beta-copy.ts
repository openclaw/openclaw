/**
 * add-beta-copy.ts — Updates CTA/endcard scenes across all specs to emphasize BETA.
 *
 * Changes:
 * 1. CTA button text → rotate between BETA-focused CTAs
 * 2. Support/footer text → BETA-focused taglines
 * 3. If there's a subhead, make it BETA-related
 *
 * Does NOT modify headlines (those are fine as-is).
 */
import fs from "node:fs";
import path from "node:path";

const dir = "../../data/datasets/cutmv/motion/specs";
const files = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort();

// Rotating BETA CTA button texts
const BETA_CTAS = [
  "JOIN THE BETA",
  "GET BETA ACCESS",
  "TRY BETA FREE",
  "JOIN BETA NOW",
  "GET EARLY ACCESS",
  "BETA ACCESS — FREE",
];

// Rotating BETA support/footer texts
const BETA_SUPPORT = [
  "BETA ACCESS • LIMITED FREE CREDITS",
  "JOIN BETA — HELP SHAPE IT.",
  "BUILT BY FULL DIGITAL",
  "BETA • FREE CREDITS INCLUDED",
  "EARLY ACCESS • BUILT BY FULL DIGITAL",
  "BETA — LIMITED SPOTS AVAILABLE",
];

let modified = 0;
let ctaChanges = 0;
let supportChanges = 0;

for (let fi = 0; fi < files.length; fi++) {
  const file = files[fi];
  const filePath = path.join(dir, file);
  const spec = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  let changed = false;

  for (const scene of spec.scenes) {
    if (!scene.id) continue;
    if (!scene.id.includes("cta") && !scene.id.includes("endcard")) continue;
    if (!scene.elements) continue;

    for (const el of scene.elements) {
      // Update CTA button text
      if (el.kind === "cta") {
        const newCta = BETA_CTAS[fi % BETA_CTAS.length];
        if (el.text !== newCta) {
          el.text = newCta;
          changed = true;
          ctaChanges++;
        }
      }

      // Update support/footer text
      if (el.kind === "support") {
        const newSupport = BETA_SUPPORT[fi % BETA_SUPPORT.length];
        if (el.text !== newSupport) {
          el.text = newSupport;
          changed = true;
          supportChanges++;
        }
      }
    }
  }

  if (changed) {
    fs.writeFileSync(filePath, JSON.stringify(spec, null, 2) + "\n", "utf-8");
    modified++;
    console.log(`  ✓ ${file} — CTA: "${BETA_CTAS[fi % BETA_CTAS.length]}" | Footer: "${BETA_SUPPORT[fi % BETA_SUPPORT.length]}"`);
  }
}

console.log(`\n=== Summary ===`);
console.log(`Files modified: ${modified}/${files.length}`);
console.log(`CTA buttons updated: ${ctaChanges}`);
console.log(`Support footers updated: ${supportChanges}`);
