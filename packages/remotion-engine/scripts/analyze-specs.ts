import * as fs from "fs";
import * as path from "path";

const SPECS_DIR = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "data",
  "datasets",
  "cutmv",
  "motion",
  "specs"
);

const FPS = 30;
const MIN_TOTAL_FRAMES = 450; // 15s at 30fps
const MIN_SCENE_FRAMES = 45;

interface SceneInfo {
  id: string;
  duration: number;
}

interface SpecAnalysis {
  filename: string;
  totalDuration: number;
  totalSeconds: number;
  sceneCount: number;
  scenes: SceneInfo[];
  minSceneDuration: number;
  maxSceneDuration: number;
  isTotalUnder450: boolean;
  shortScenes: SceneInfo[];
}

function analyzeSpec(filepath: string): SpecAnalysis {
  const raw = JSON.parse(fs.readFileSync(filepath, "utf-8"));
  const filename = path.basename(filepath);

  // Total duration: check top-level first, then format.durationInFrames
  const totalDuration: number =
    raw.durationInFrames ?? raw.format?.durationInFrames ?? 0;

  const scenes: SceneInfo[] = (raw.scenes ?? []).map(
    (s: { id: string; duration: number }) => ({
      id: s.id,
      duration: s.duration,
    })
  );

  const durations = scenes.map((s) => s.duration);
  const minSceneDuration = durations.length > 0 ? Math.min(...durations) : 0;
  const maxSceneDuration = durations.length > 0 ? Math.max(...durations) : 0;

  const shortScenes = scenes.filter((s) => s.duration < MIN_SCENE_FRAMES);

  return {
    filename,
    totalDuration,
    totalSeconds: totalDuration / FPS,
    sceneCount: scenes.length,
    scenes,
    minSceneDuration,
    maxSceneDuration,
    isTotalUnder450: totalDuration < MIN_TOTAL_FRAMES,
    shortScenes,
  };
}

// --- Main ---

const files = fs
  .readdirSync(SPECS_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

console.log(`\nAnalyzing ${files.length} spec files in ${SPECS_DIR}\n`);
console.log("=".repeat(100));

const results: SpecAnalysis[] = [];

for (const file of files) {
  const analysis = analyzeSpec(path.join(SPECS_DIR, file));
  results.push(analysis);

  const flags: string[] = [];
  if (analysis.isTotalUnder450) flags.push("UNDER 450 FRAMES");
  if (analysis.shortScenes.length > 0) flags.push("HAS SHORT SCENES");
  const flagStr = flags.length > 0 ? `  *** ${flags.join(", ")} ***` : "";

  console.log(
    `${analysis.filename.padEnd(32)} | ` +
      `${String(analysis.totalDuration).padStart(5)} frames | ` +
      `${analysis.totalSeconds.toFixed(1).padStart(5)}s | ` +
      `${String(analysis.sceneCount).padStart(2)} scenes | ` +
      `min=${String(analysis.minSceneDuration).padStart(3)} max=${String(analysis.maxSceneDuration).padStart(3)}` +
      flagStr
  );

  // Print per-scene detail if there are short scenes
  if (analysis.shortScenes.length > 0) {
    for (const s of analysis.shortScenes) {
      console.log(
        `    -> SHORT SCENE: "${s.id}" duration=${s.duration} frames (${(s.duration / FPS).toFixed(1)}s)`
      );
    }
  }
}

// --- Summary ---
console.log("\n" + "=".repeat(100));
console.log("SUMMARY");
console.log("=".repeat(100));

const totalSpecs = results.length;
const specsUnder450 = results.filter((r) => r.isTotalUnder450);
const specsWithShortScenes = results.filter((r) => r.shortScenes.length > 0);
const allDurations = results.map((r) => r.totalDuration);
const avgDuration = allDurations.reduce((a, b) => a + b, 0) / totalSpecs;
const minTotalDuration = Math.min(...allDurations);
const maxTotalDuration = Math.max(...allDurations);

const allSceneDurations = results.flatMap((r) => r.scenes.map((s) => s.duration));
const avgSceneDuration =
  allSceneDurations.reduce((a, b) => a + b, 0) / allSceneDurations.length;

console.log(`Total specs analyzed:          ${totalSpecs}`);
console.log(`Total scenes across all specs: ${allSceneDurations.length}`);
console.log(
  `Average spec duration:         ${avgDuration.toFixed(1)} frames (${(avgDuration / FPS).toFixed(1)}s)`
);
console.log(
  `Min spec duration:             ${minTotalDuration} frames (${(minTotalDuration / FPS).toFixed(1)}s)`
);
console.log(
  `Max spec duration:             ${maxTotalDuration} frames (${(maxTotalDuration / FPS).toFixed(1)}s)`
);
console.log(
  `Average scene duration:        ${avgSceneDuration.toFixed(1)} frames (${(avgSceneDuration / FPS).toFixed(1)}s)`
);
console.log(
  `\nSpecs under ${MIN_TOTAL_FRAMES} frames (${MIN_TOTAL_FRAMES / FPS}s): ${specsUnder450.length}`
);
if (specsUnder450.length > 0) {
  for (const r of specsUnder450) {
    console.log(
      `  - ${r.filename}: ${r.totalDuration} frames (${r.totalSeconds.toFixed(1)}s)`
    );
  }
}

console.log(
  `\nSpecs with scenes under ${MIN_SCENE_FRAMES} frames: ${specsWithShortScenes.length}`
);
if (specsWithShortScenes.length > 0) {
  for (const r of specsWithShortScenes) {
    const shortIds = r.shortScenes
      .map((s) => `${s.id}(${s.duration}f)`)
      .join(", ");
    console.log(`  - ${r.filename}: ${shortIds}`);
  }
}

// Duration distribution
console.log("\nDuration distribution:");
const buckets = [
  { label: "< 300 frames (< 10s)", min: 0, max: 299 },
  { label: "300-449 frames (10-14.9s)", min: 300, max: 449 },
  { label: "450-599 frames (15-19.9s)", min: 450, max: 599 },
  { label: "600-899 frames (20-29.9s)", min: 600, max: 899 },
  { label: "900+ frames (30s+)", min: 900, max: Infinity },
];
for (const bucket of buckets) {
  const count = results.filter(
    (r) => r.totalDuration >= bucket.min && r.totalDuration <= bucket.max
  ).length;
  const bar = "#".repeat(count);
  console.log(`  ${bucket.label.padEnd(35)} ${String(count).padStart(3)}  ${bar}`);
}

console.log("");
