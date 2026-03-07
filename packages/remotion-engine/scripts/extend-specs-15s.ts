/**
 * extend-specs-15s.ts
 *
 * Extends all 36 JSON spec files in data/datasets/cutmv/motion/specs/
 * to reach approximately 450 frames (15s at 30fps).
 *
 * Algorithm:
 *   Step 1: Ensure every scene has duration >= 45
 *   Step 2: Add up to 45 extra frames to the last scene (CTA/endcard)
 *   Step 3: Distribute remaining needed frames proportionally across all scenes
 *   Step 4: Recalculate all `from` values sequentially
 *   Step 5: Set format.durationInFrames = last scene from + duration
 *   Step 6: propsTimeline `at` values are scene-relative — leave them alone
 *
 * Only modifies: scene.duration, scene.from, format.durationInFrames
 */

import * as fs from "fs";
import * as path from "path";

const SPEC_DIR = path.resolve(
  __dirname,
  "../../../data/datasets/cutmv/motion/specs"
);
const TARGET_FRAMES = 450;
const MIN_SCENE_DURATION = 45;
const MAX_LAST_SCENE_BOOST = 45;

interface SceneEntry {
  from: number;
  duration: number;
  [key: string]: unknown;
}

interface SpecJson {
  format: {
    durationInFrames: number;
    [key: string]: unknown;
  };
  scenes: SceneEntry[];
  [key: string]: unknown;
}

function processSpec(filePath: string): {
  name: string;
  oldDuration: number;
  newDuration: number;
  modified: boolean;
  error?: string;
} {
  const name = path.basename(filePath);
  const raw = fs.readFileSync(filePath, "utf-8");
  const spec: SpecJson = JSON.parse(raw);

  const oldDuration = spec.format.durationInFrames;

  if (!spec.scenes || spec.scenes.length === 0) {
    return { name, oldDuration, newDuration: oldDuration, modified: false, error: "No scenes" };
  }

  // Already at or above target
  if (oldDuration >= TARGET_FRAMES) {
    return { name, oldDuration, newDuration: oldDuration, modified: false };
  }

  // --- Step 1: Ensure every scene has duration >= 45 ---
  for (const scene of spec.scenes) {
    if (scene.duration < MIN_SCENE_DURATION) {
      scene.duration = MIN_SCENE_DURATION;
    }
  }

  // Calculate current total after step 1
  let currentTotal = spec.scenes.reduce((sum, s) => sum + s.duration, 0);

  // --- Step 2: Add up to 45 extra frames to the last scene ---
  if (currentTotal < TARGET_FRAMES) {
    const deficit = TARGET_FRAMES - currentTotal;
    const boost = Math.min(deficit, MAX_LAST_SCENE_BOOST);
    spec.scenes[spec.scenes.length - 1].duration += boost;
    currentTotal += boost;
  }

  // --- Step 3: Distribute remaining frames proportionally ---
  if (currentTotal < TARGET_FRAMES) {
    const deficit = TARGET_FRAMES - currentTotal;

    // Weighted by current duration
    const totalWeight = spec.scenes.reduce((sum, s) => sum + s.duration, 0);

    // Calculate proportional additions (floating point first)
    const rawAdditions = spec.scenes.map(
      (s) => (s.duration / totalWeight) * deficit
    );

    // Round to integers, ensuring the total adds up exactly
    const flooredAdditions = rawAdditions.map((a) => Math.floor(a));
    let remainder = deficit - flooredAdditions.reduce((sum, a) => sum + a, 0);

    // Distribute the rounding remainder to scenes with the largest fractional parts
    const fractionalParts = rawAdditions.map((a, i) => ({
      index: i,
      frac: a - Math.floor(a),
    }));
    fractionalParts.sort((a, b) => b.frac - a.frac);

    for (let i = 0; i < remainder; i++) {
      flooredAdditions[fractionalParts[i].index] += 1;
    }

    // Apply additions
    for (let i = 0; i < spec.scenes.length; i++) {
      spec.scenes[i].duration += flooredAdditions[i];
    }
  }

  // --- Step 4: Recalculate all `from` values sequentially ---
  spec.scenes[0].from = 0;
  for (let i = 1; i < spec.scenes.length; i++) {
    spec.scenes[i].from = spec.scenes[i - 1].from + spec.scenes[i - 1].duration;
  }

  // --- Step 5: Set format.durationInFrames ---
  const lastScene = spec.scenes[spec.scenes.length - 1];
  const newDuration = lastScene.from + lastScene.duration;
  spec.format.durationInFrames = newDuration;

  // --- Step 6: propsTimeline `at` values are scene-relative — no changes needed ---

  // Write back with 2-space indentation
  fs.writeFileSync(filePath, JSON.stringify(spec, null, 2) + "\n", "utf-8");

  return { name, oldDuration, newDuration, modified: true };
}

// --- Main ---
function main() {
  const files = fs
    .readdirSync(SPEC_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => path.join(SPEC_DIR, f));

  console.log(`Found ${files.length} spec files in ${SPEC_DIR}\n`);

  const results = files.map((f) => processSpec(f));

  // --- Summary ---
  const modified = results.filter((r) => r.modified);
  const unmodified = results.filter((r) => !r.modified);
  const failed = results.filter((r) => r.newDuration < TARGET_FRAMES && !r.error);

  console.log("=".repeat(72));
  console.log("EXTENSION SUMMARY");
  console.log("=".repeat(72));
  console.log();

  // Per-spec details
  console.log(
    `${"Spec".padEnd(32)} ${"Old".padStart(6)} ${"New".padStart(6)} ${"Delta".padStart(6)}  Status`
  );
  console.log("-".repeat(72));

  for (const r of results) {
    const delta = r.newDuration - r.oldDuration;
    const status = r.error
      ? `ERROR: ${r.error}`
      : r.modified
        ? "EXTENDED"
        : "ALREADY >= 450";
    console.log(
      `${r.name.padEnd(32)} ${String(r.oldDuration).padStart(6)} ${String(r.newDuration).padStart(6)} ${(delta > 0 ? "+" + delta : String(delta)).padStart(6)}  ${status}`
    );
  }

  console.log();
  console.log("-".repeat(72));
  console.log(`Total specs:      ${results.length}`);
  console.log(`Modified:         ${modified.length}`);
  console.log(`Already >= 450:   ${unmodified.filter((r) => !r.error).length}`);

  const totalOldSeconds = results.reduce((s, r) => s + r.oldDuration, 0) / 30;
  const totalNewSeconds = results.reduce((s, r) => s + r.newDuration, 0) / 30;
  console.log(
    `Total duration:   ${totalOldSeconds.toFixed(1)}s -> ${totalNewSeconds.toFixed(1)}s (${(totalNewSeconds - totalOldSeconds).toFixed(1)}s added)`
  );

  if (failed.length > 0) {
    console.log();
    console.log("WARNING: The following specs could not reach 450 frames:");
    for (const r of failed) {
      console.log(`  ${r.name}: ${r.newDuration} frames`);
    }
  } else {
    console.log(`\nAll specs that needed extension reached ${TARGET_FRAMES} frames.`);
  }
}

main();
