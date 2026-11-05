/**
 * Prepare once with --prepare, then measure:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/shared-skills-measure.ts <fixture-dir> [--sample-allocations] [--team-config]
 * --team-config uses 40 synthetic plugin configurations and 2,000 fresh snapshots.
 * Add --long-window for 10,000 snapshots when short GC windows are inconclusive.
 * Alternate base/candidate timing and separate allocation runs at least five times.
 * The production selection/projection owner is measured; discovery setup is untimed.
 */
import fs from "node:fs/promises";
import inspector from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { resolveSkillDiscoveryLimits } from "../../src/skills/loading/skill-root-discovery.js";
import { buildSkillSnapshot } from "../../src/skills/loading/workspace-skill-prompt.js";
import {
  closeSkillsWatchers,
  prepareLocalSkillSources,
  refreshSkillsDiscovery,
} from "../../src/skills/runtime/refresh.js";
import type { SkillSnapshot } from "../../src/skills/types.js";

const root = process.argv[2];
if (!root || !global.gc) {
  throw new Error("Pass an isolated fixture directory and run Node with --expose-gc");
}
const workspace = path.resolve(root);
const skillCount = 100;
const sessions = 100;
const teamConfig = process.argv.includes("--team-config");
const runs = process.argv.includes("--long-window") ? 100 : teamConfig ? 20 : 3;
const names = Array.from(
  { length: skillCount },
  (_, index) => `skill-${String(index).padStart(3, "0")}`,
);
await fs.mkdir(workspace, { recursive: true });
for (const [key, value] of Object.entries({
  HOME: workspace,
  OPENCLAW_HOME: workspace,
  OPENCLAW_STATE_DIR: path.join(workspace, "state"),
  OPENCLAW_BUNDLED_SKILLS_DIR: path.join(workspace, "bundled"),
  OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(workspace, "plugins"),
})) {
  process.env[key] = value;
}
if (process.argv.includes("--prepare")) {
  for (const name of names) {
    const dir = path.join(workspace, "skills", name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: Synthetic ${name} workflow with catalog matching guidance and tool instructions.\n---\n# ${name}\n${"Use this synthetic workflow for the named task.\n".repeat(100)}`,
    );
  }
  process.exit(0);
}
const request = {
  sourcePlan: {
    workspaceDir: workspace,
    roots: [
      {
        dir: path.join(workspace, "skills"),
        source: "openclaw-workspace",
        tier: "workspace" as const,
      },
    ],
    pluginSkillRoots: [],
    managedSkillsDir: path.join(workspace, "managed"),
  },
  limits: resolveSkillDiscoveryLimits(),
  additionalBins: [],
};
const config = {
  plugins: {
    enabled: false,
    ...(teamConfig
      ? {
          entries: Object.fromEntries(
            Array.from({ length: 40 }, (_, index) => [
              `synthetic-plugin-${index}`,
              {
                enabled: true,
                config: {
                  routes: Array.from({ length: 20 }, (_entry, route) => ({
                    name: `synthetic-route-${route}`,
                    description:
                      "Synthetic routing configuration for the isolated skill benchmark.",
                    target: `synthetic-target-${index}-${route}`,
                  })),
                },
              },
            ]),
          ),
        }
      : {}),
  },
  agents: { entries: { writer: { skills: names }, reader: { skills: names.slice(0, 50) } } },
  skills: { limits: { maxSkillsInPrompt: 100, maxSkillsPromptChars: 100_000 } },
};
const retained: SkillSnapshot[] = [];
const samples: number[] = [];
const gcEvents: Array<{ kind: number; duration: number }> = [];
const observer = new PerformanceObserver((list) => {
  for (const event of list.getEntries()) {
    const detail = (event as import("node:perf_hooks").PerformanceNodeEntry).detail;
    gcEvents.push({ kind: detail.kind, duration: event.duration });
  }
});
const profiler = process.argv.includes("--sample-allocations")
  ? new inspector.Session()
  : undefined;
try {
  const sources = await prepareLocalSkillSources(request, { watch: false });
  if (sources.entries.length !== skillCount) {
    throw new Error(`Expected ${skillCount} synthetic skills, received ${sources.entries.length}`);
  }
  const build = (index: number) =>
    buildSkillSnapshot(workspace, {
      entries: sources.entries,
      config,
      agentId: index % 2 ? "reader" : "writer",
      watch: false,
    });
  for (let index = 0; index < 20; index++) {
    await build(index);
  }
  global.gc();
  await yieldTurn();
  const heapBefore = process.memoryUsage().heapUsed;
  profiler?.connect();
  if (profiler) {
    await profiler.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  observer.observe({ entryTypes: ["gc"] });
  const traced = process.execArgv.includes("--trace-gc-nvp");
  if (traced) {
    console.log("SKILLS_MEASURE_BEGIN");
  }
  const cpuBefore = process.cpuUsage();
  const start = performance.now();
  for (let index = 0; index < sessions * runs; index++) {
    const turn = performance.now();
    retained.push(await build(index));
    samples.push(performance.now() - turn);
  }
  const elapsedMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuBefore);
  if (traced) {
    console.log("SKILLS_MEASURE_END");
  }
  await yieldTurn();
  observer.disconnect();
  let allocatedBytes: number | undefined;
  if (profiler) {
    const { profile } = await profiler.post("HeapProfiler.stopSampling");
    const sum = (node: inspector.HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    allocatedBytes = sum(profile.head);
  }
  global.gc();
  await yieldTurn();
  const retainedBytes = process.memoryUsage().heapUsed - heapBefore;
  const objects = new Set(
    retained.flatMap((snapshot) => [
      ...(snapshot.resolvedSkills ?? []),
      ...(snapshot.discoverySkills ?? []),
    ]),
  );
  const scanCpu = process.cpuUsage();
  const scanStart = performance.now();
  for (let index = 0; index < 5; index++) {
    await refreshSkillsDiscovery({ workspaceDir: workspace });
  }
  const scanElapsedMs = performance.now() - scanStart;
  const scanCost = process.cpuUsage(scanCpu);
  samples.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      node: process.version,
      hostLoad: os.loadavg(),
      configBytes: Buffer.byteLength(JSON.stringify(config)),
      skillCount,
      sessions,
      runs,
      snapshots: retained.length,
      uniqueSkillObjects: objects.size,
      retainedBytes,
      elapsedMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      cpuMsPerSnapshot: (cpu.user + cpu.system) / 1000 / retained.length,
      medianMs: samples[Math.floor(samples.length / 2)],
      p90Ms: samples[Math.ceil(samples.length * 0.9) - 1],
      p95Ms: samples[Math.ceil(samples.length * 0.95) - 1],
      latencySamples: samples.length,
      gcCount: gcEvents.length,
      gcMs: gcEvents.reduce((sum, event) => sum + event.duration, 0),
      gcMaxMs: Math.max(0, ...gcEvents.map((event) => event.duration)),
      gcByKind: [...new Set(gcEvents.map((event) => event.kind))].map((kind) => ({
        kind,
        count: gcEvents.filter((event) => event.kind === kind).length,
        ms: gcEvents
          .filter((event) => event.kind === kind)
          .reduce((sum, event) => sum + event.duration, 0),
      })),
      allocatedBytes,
      allocatedBytesPerSnapshot:
        allocatedBytes === undefined ? undefined : allocatedBytes / retained.length,
      scanSamples: 5,
      scanElapsedMs,
      scanCpuMs: (scanCost.user + scanCost.system) / 1000,
    }),
  );
} finally {
  profiler?.disconnect();
  observer.disconnect();
  await closeSkillsWatchers();
}
