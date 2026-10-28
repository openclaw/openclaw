import { deepStrictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { BoardGridItem } from "../../ui/src/lib/board/grid.ts";

// Run with Node 26: node scripts/perf/board-grid-measure.ts --base <merge-base>.
const { values } = parseArgs({
  options: {
    base: { type: "string" },
    pairs: { type: "string", default: "20" },
    iterations: { type: "string", default: "5" },
  },
});
if (!values.base) {
  throw new Error("--base <git revision> is required");
}
const pairs = Number(values.pairs);
const iterations = Number(values.iterations);
if (!Number.isInteger(pairs) || pairs < 10 || !Number.isInteger(iterations) || iterations < 1) {
  throw new Error("Use at least 10 pairs and a positive integer iteration count");
}
const root = new URL("../../", import.meta.url);
const sourcePath = "ui/src/lib/board/grid.ts";
const constantsPath = "ui/src/lib/board/grid-constants.ts";
const baseSource = (path: string) =>
  execFileSync("git", ["show", `${values.base}:${path}`], {
    cwd: fileURLToPath(root),
    encoding: "utf8",
  });
if (baseSource(constantsPath) !== readFileSync(new URL(constantsPath, root), "utf8")) {
  throw new Error("Grid constants changed; compare in separate worktrees instead");
}
type GridModule = typeof import("../../ui/src/lib/board/grid.ts");
async function loadGrid(source: string): Promise<GridModule> {
  const nativeSource = source.replace(
    '"./grid-constants.ts"',
    JSON.stringify(new URL(constantsPath, root).href),
  );
  return import(
    `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(nativeSource)).toString("base64")}`
  );
}
const baseline = await loadGrid(baseSource(sourcePath));
const candidate = await loadGrid(readFileSync(new URL(sourcePath, root), "utf8"));

function items(count: number, kind: "full" | "mixed"): BoardGridItem[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `widget-${index}`,
    order: index,
    w: kind === "full" ? 12 : [3, 6, 12, 4, 5, 7][index % 6]!,
    h: kind === "full" ? 4 : 1 + ((index * 7) % 8),
  }));
}
function measure(grid: GridModule, workload: BoardGridItem[]) {
  const before = process.cpuUsage();
  const started = performance.now();
  for (let index = 0; index < iterations; index++) {
    grid.layout(workload);
  }
  const wallMs = (performance.now() - started) / iterations;
  const cpu = process.cpuUsage(before);
  return { wallMs, cpuMs: (cpu.user + cpu.system) / 1_000 / iterations };
}
function distribution(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)]!,
    p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!,
    min: sorted[0]!,
    max: sorted.at(-1)!,
  };
}
function summarize(samples: ReturnType<typeof measure>[]) {
  return {
    wallMs: distribution(samples.map((sample) => sample.wallMs)),
    cpuMs: distribution(samples.map((sample) => sample.cpuMs)),
  };
}
const hostLoadBefore = loadavg();
const results = [];
for (const kind of ["full", "mixed"] as const) {
  for (const count of [250, 1_000]) {
    const workload = items(count, kind);
    deepStrictEqual(candidate.layout(workload), baseline.layout(workload));
    for (let index = 0; index < 5; index++) {
      baseline.layout(workload);
      candidate.layout(workload);
    }
    const baseSamples = [];
    const controlSamples = [];
    const headSamples = [];
    for (let index = 0; index < pairs; index++) {
      if (index % 2) {
        headSamples.push(measure(candidate, workload));
      }
      baseSamples.push(measure(baseline, workload));
      controlSamples.push(measure(baseline, workload));
      if (!(index % 2)) {
        headSamples.push(measure(candidate, workload));
      }
    }
    results.push({
      kind,
      count,
      geometryEqual: true,
      baseline: summarize(baseSamples),
      control: summarize(controlSamples),
      head: summarize(headSamples),
    });
  }
}
console.log(
  JSON.stringify(
    {
      base: values.base,
      head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      sourceSha256: createHash("sha256")
        .update(readFileSync(new URL(sourcePath, root)))
        .digest("hex"),
      pairs,
      iterations,
      node: process.version,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
      results,
    },
    null,
    2,
  ),
);
