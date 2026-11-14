// Run on baseline and candidate in five interleaved fresh processes.
// node --import ./scripts/tsx.mjs scripts/bench-ci-lint-plan.mts
import { createHash } from "node:crypto";
import fs from "node:fs";
import { detectChangedLanes } from "./changed-lanes.mts";
import { createChangedCheckPlan } from "./check-changed.mts";

const paths = ["src/utils.ts", "test/scripts/ci-changed-lint.test.ts"];
const result = detectChangedLanes(paths);
const options = {
  lintOnly: true,
  lintThreads: 1,
  lintSelection: {
    files: [paths[0]!],
    rootTestFiles: [paths[1]!],
    coreStripes: [1],
    extensionStripes: [],
    groups: [],
    central: false,
  },
} satisfies NonNullable<Parameters<typeof createChangedCheckPlan>[1]>;

createChangedCheckPlan(result, options);
const read = fs.readFileSync;
let reads = 0;
fs.readFileSync = ((...args: Parameters<typeof read>) => {
  reads++;
  return Reflect.apply(read, fs, args);
}) as typeof read;
const cpu = process.cpuUsage();
const started = performance.now();
let plan;
try {
  plan = createChangedCheckPlan(result, options);
} finally {
  fs.readFileSync = read;
}
const elapsedMs = performance.now() - started;
const used = process.cpuUsage(cpu);
console.log(
  JSON.stringify({
    elapsedMs,
    cpuMs: (used.user + used.system) / 1000,
    reads,
    rssBytes: process.memoryUsage().rss,
    planSha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
  }),
);
