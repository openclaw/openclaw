/**
 * Isolated decoded-entry retention microbenchmark (not Gateway residency).
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-skill-snapshot-intern.ts baseline
 * Repeat with candidate; alternate launch order. --bounded retains only 128 entries;
 * --allocations enables a separate inspector pass. Each arm decodes 10,000 entries
 * with four 40-skill inventories, retains them, and reports CPU, sampled allocation,
 * full-GC heap growth, and snapshot identity/content counts. No database or provider.
 */
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import os from "node:os";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { internSessionSkillSnapshot } from "../../src/config/sessions/session-skill-snapshot-intern.js";
import type { SessionEntry } from "../../src/config/sessions/types.js";
import { freezeTrustedJsonSnapshot } from "../../src/shared/immutable-data.js";

const mode = process.argv[2];
const allocations = process.argv.includes("--allocations");
const resident = process.argv.includes("--bounded") ? 128 : 10_000;
if (mode !== "baseline" && mode !== "candidate") {
  throw new Error("Specify baseline or candidate");
}
if (!global.gc) {
  throw new Error("Run with --expose-gc");
}
const fixtures = Array.from({ length: 4 }, (_, version) =>
  JSON.stringify({
    sessionId: "synthetic-session",
    updatedAt: 1,
    skillsSnapshot: {
      prompt: `Synthetic inventory ${version}\n${"Skill instructions. ".repeat(512)}`,
      skills: Array.from({ length: 40 }, (_skill, index) => ({
        name: `synthetic-${index}`,
        requiredEnv: [`SYNTHETIC_${index}`],
        source: { filePath: `/synthetic/skills/${index}/SKILL.md` },
      })),
      version,
    },
  }),
);
global.gc();
const inspector = allocations ? new Session() : undefined;
if (inspector) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
let gcMs = 0;
let gcCount = 0;
let gcMaxMs = 0;
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.startTime < started || entry.startTime >= finished) {
      continue;
    }
    gcMs += entry.duration;
    gcCount++;
    gcMaxMs = Math.max(gcMaxMs, entry.duration);
  }
});
observer.observe({ entryTypes: ["gc"] });
const heapBefore = process.memoryUsage().heapUsed;
const cpuBefore = process.cpuUsage();
const started = performance.now();
const entries: SessionEntry[] = [];
for (let index = 0; index < 10_000; index++) {
  const entry: SessionEntry = JSON.parse(fixtures[index % fixtures.length]!);
  if (mode === "candidate") {
    entry.skillsSnapshot = internSessionSkillSnapshot(entry.skillsSnapshot!);
  }
  entries[index % resident] = freezeTrustedJsonSnapshot(entry);
}
const finished = performance.now();
const elapsedMs = finished - started;
const cpu = process.cpuUsage(cpuBefore);
await new Promise<void>((resolve) => {
  setImmediate(resolve);
});
await new Promise<void>((resolve) => {
  setImmediate(resolve);
});
observer.disconnect();
const profile = inspector && (await inspector.post("HeapProfiler.stopSampling")).profile;
inspector?.disconnect();
global.gc();
// The sampling report itself remains live in allocation mode.
const retainedBytes = allocations ? undefined : process.memoryUsage().heapUsed - heapBefore;
const unique = new Set(entries.map((entry) => entry.skillsSnapshot));
const hashes = new Set(
  [...unique].map((snapshot) =>
    createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
  ),
);
console.log(
  JSON.stringify({
    mode,
    iterations: 10_000,
    resident,
    cpuMs: (cpu.user + cpu.system) / 1000,
    elapsedMs,
    sampledAllocationBytes: profile?.samples.reduce((bytes, sample) => bytes + sample.size, 0),
    gcMs,
    gcCount,
    gcMaxMs,
    retainedBytes,
    distinctSnapshots: unique.size,
    contentHashes: hashes.size,
    hostLoad: os.loadavg(),
  }),
);
