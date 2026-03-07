/**
 * Deterministic render script for CUTMV MotionSpec pipeline.
 * Every render produces a unique output file — never overwrites.
 *
 * Usage:
 *   node scripts/render.mjs                                                      # default
 *   node scripts/render.mjs --spec=../../data/datasets/cutmv/motion/specs/cutmv_premium_v022.json
 *   node scripts/render.mjs --spec=cutmv_premium_v022                            # shorthand
 *   node scripts/render.mjs CutmvPremiumAd premium_clean h264                    # legacy positional
 */

import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import path from "path";
import fs from "fs";

// ── Parse args ──
const args = process.argv.slice(2);
let specPath = "";
let compositionId = "CutmvPremiumAd";
let styleProfile = "premium_clean";
let codec = "h264";

for (const arg of args) {
  if (arg.startsWith("--spec=")) {
    specPath = arg.slice(7);
  } else if (arg.startsWith("--codec=")) {
    codec = arg.slice(8);
  } else if (arg.startsWith("--comp=")) {
    compositionId = arg.slice(7);
  }
}

// Legacy positional fallback
if (!specPath) {
  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional[0]) compositionId = positional[0];
  if (positional[1]) styleProfile = positional[1];
  if (positional[2]) codec = positional[2];
}

// Resolve spec path shorthand
if (specPath && !specPath.endsWith(".json")) {
  specPath = `../../data/datasets/cutmv/motion/specs/${specPath}.json`;
}

// Derive specId for unique naming
let specId = compositionId;
if (specPath) {
  specId = path.basename(specPath, ".json");
}

const entry = path.resolve("src/index.ts");
const outDir = path.resolve("out");
fs.mkdirSync(outDir, { recursive: true });

// ── Generate unique filename: {specId}_{YYYY-MM-DD}_{HHMMSS}_{rand}.mp4 ──
const now = new Date();
const datePart = [
  now.getFullYear(),
  String(now.getMonth() + 1).padStart(2, "0"),
  String(now.getDate()).padStart(2, "0"),
].join("-");
const timePart = [
  String(now.getHours()).padStart(2, "0"),
  String(now.getMinutes()).padStart(2, "0"),
  String(now.getSeconds()).padStart(2, "0"),
].join("");
const rand = Math.random().toString(16).slice(2, 8);
const outName = `${specId}_${datePart}_${timePart}_${rand}.mp4`;
const outputLocation = path.join(outDir, outName);

console.log(`\n  RENDER START`);
console.log(`   Composition:  ${compositionId}`);
console.log(`   Spec:         ${specPath || "(default)"}`);
console.log(`   Style:        ${styleProfile}`);
console.log(`   Codec:        ${codec}`);
console.log(`   Output:       ${outputLocation}\n`);

// ── Bundle ──
console.log("   Bundling...");
const bundled = await bundle({
  entryPoint: entry,
  outDir: path.resolve(".remotion-bundle"),
  webpackOverride: (config) => config,
});

// ── Build input props ──
const inputProps = {
  renderId: outName,
  brand: "cutmv",
  styleProfile,
};
if (specPath) {
  inputProps.specPath = specPath;
}

// ── Select composition ──
console.log("   Selecting composition...");
const comp = await selectComposition({
  serveUrl: bundled,
  id: compositionId,
  inputProps,
});

console.log(
  `   Resolution: ${comp.width}x${comp.height} | ${comp.fps}fps | ${comp.durationInFrames} frames`
);

// ── Render ──
console.log("   Rendering...");
const startTime = Date.now();

await renderMedia({
  composition: comp,
  serveUrl: bundled,
  codec,
  outputLocation,
  inputProps: comp.inputProps,
  onProgress: ({ progress }) => {
    if (Math.round(progress * 100) % 10 === 0) {
      process.stdout.write(`   ${Math.round(progress * 100)}%\r`);
    }
  },
});

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
const size = (fs.statSync(outputLocation).size / 1024 / 1024).toFixed(2);

console.log(`\n   RENDER COMPLETE`);
console.log(`   File:     ${outputLocation}`);
console.log(`   Size:     ${size} MB`);
console.log(`   Time:     ${elapsed}s`);
console.log(`   Frames:   ${comp.durationInFrames}`);
