// Compare at least five interleaved fresh processes per package version.
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

const packageRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(
      path.dirname(
        createRequire(new URL("../extensions/lobster/package.json", import.meta.url)).resolve(
          "@clawdbot/lobster/core",
        ),
      ),
      "../../..",
    );
const iterations = Number(process.argv[3] ?? 1_000_000);
const warmup = Number(process.argv[4] ?? 100_000);
if (
  !Number.isSafeInteger(iterations) ||
  iterations < 1 ||
  !Number.isSafeInteger(warmup) ||
  warmup < 0
) {
  throw new Error("Iterations must be positive and warmup nonnegative safe integers");
}
function start() {
  return { wall: performance.now(), cpu: process.cpuUsage() };
}
function elapsed(mark: ReturnType<typeof start>) {
  const cpu = process.cpuUsage(mark.cpu);
  return { wallMs: performance.now() - mark.wall, cpuMs: (cpu.user + cpu.system) / 1000 };
}
const importing = start();
await import(pathToFileURL(path.join(packageRoot, "dist/src/core/index.js")).href);
const imported = elapsed(importing);
const runtime: unknown = await import(
  pathToFileURL(path.join(packageRoot, "dist/src/pipeline_resume_state.js")).href
);
if (!isRecord(runtime) || typeof runtime.validatePipelineInputResponse !== "function") {
  throw new Error("Lobster package does not expose its pipeline input validator");
}
const validate = runtime.validatePipelineInputResponse;
const schema = {
  type: "object",
  properties: {
    answer: { type: "integer", minimum: 1 },
    label: { type: "string" },
    items: { type: "array", items: { type: "integer" } },
  },
  required: ["answer"],
  additionalProperties: false,
};
const values = [
  { answer: 2, label: "sample", items: [1, 2, 3] },
  { answer: 3, label: "next", items: [4, 5] },
];
const first = start();
validate(schema, values[0]);
const firstValid = elapsed(first);
let rejected = false;
try {
  validate(schema, { answer: 0 });
} catch {
  rejected = true;
}
if (!rejected) {
  throw new Error("Lobster negative control was accepted");
}
for (let index = 0; index < warmup; index++) {
  validate(schema, values[index & 1]);
}
const samples = [];
for (let sample = 0; sample < 5; sample++) {
  const mark = start();
  for (let index = 0; index < iterations; index++) {
    validate(schema, values[index & 1]);
  }
  const timing = elapsed(mark);
  samples.push({
    ...timing,
    cpuNsPerCheck: (timing.cpuMs * 1e6) / iterations,
    wallNsPerCheck: (timing.wallMs * 1e6) / iterations,
  });
}
console.log(JSON.stringify({ imported, firstValid, iterations, warmup, samples }));
