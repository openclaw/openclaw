/**
 * Skill directory permission admission, with synthetic 40-skill trees.
 * node --import ./scripts/tsx.mjs scripts/perf/skill-directory-modes-measure.ts \
 *   --owner /checkout/src/skills/loading/skill-directory-modes.ts --mode copy
 * Repeat alternating base/candidate (>=5 each); sample allocations separately
 * with --allocations. copy visits 4,000 already-writable directories, as sync's
 * per-directory copy path does; cleanup traverses 40 trees of 26 directories
 * twice. Fixture creation and warmup are excluded. --mode repair also seals
 * those trees before traversal. No Gateway/model or production state is used.
 * Reports process/main-thread CPU, sampled allocations (including collected
 * objects), GC, event-loop delay, synchronous descriptor opens and host load.
 * synchronousOpens counts Node openSync calls, not native-internal opens.
 * Small tail sample counts are descriptive; max loop delay includes host pauses.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import {
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
  type PerformanceEntry,
} from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { root } from "@openclaw/fs-safe/root";

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: "src/skills/loading/skill-directory-modes.ts" },
    mode: { type: "string", default: "copy" },
    allocations: { type: "boolean", default: false },
  },
});
assert(["copy", "cleanup", "repair"].includes(values.mode));
assert.notEqual(process.platform, "win32", "Directory mode repair is POSIX-only");
const { ensureWritableSkillDirectories: ensure } = (await import(
  pathToFileURL(path.resolve(values.owner)).href
)) as typeof import("../../src/skills/loading/skill-directory-modes.js");
await fsp.mkdir(".local", { recursive: true });
const fixture = await fsp.mkdtemp(path.resolve(".local/skill-directory-modes-"));
const directories: string[] = [];
const skills = Array.from({ length: 40 }, (_, index) => `skill-${index}`);
const inspector = values.allocations ? new Session() : undefined;
try {
  for (const skill of skills) {
    for (let index = 0; index < 25; index++) {
      const directory = `${skill}/references-${index}`;
      await fsp.mkdir(path.join(fixture, directory), { recursive: true, mode: 0o755 });
      directories.push(directory);
    }
  }
  const boundary = await root(fixture);
  const sourceMode = (await fsp.stat(path.join(fixture, directories[0]!))).mode;
  for (let index = 0; index < 40; index++) {
    await ensure(boundary, directories[index]!, undefined, sourceMode);
  }
  if (values.mode === "repair") {
    for (const directory of [...directories, ...skills]) {
      await fsp.chmod(path.join(fixture, directory), 0o555);
    }
  }
  inspector?.connect();
  if (inspector) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const collections: { kind: number; ms: number }[] = [];
  const gc = new PerformanceObserver((batch) => {
    for (const entry of batch.getEntries()) {
      collections.push({
        kind: (entry as PerformanceEntry & { detail: { kind: number } }).detail.kind,
        ms: entry.duration,
      });
    }
  });
  gc.observe({ entryTypes: ["gc"] });
  const loop = monitorEventLoopDelay({ resolution: 1 });
  loop.enable();
  await nextTurn();
  let opens = 0;
  const open = fs.openSync;
  fs.openSync = (...args) => {
    opens++;
    return open(...args);
  };
  const memoryBefore = process.memoryUsage();
  const loadBefore = os.loadavg();
  const cpuBefore = process.cpuUsage();
  const threadBefore = process.threadCpuUsage();
  const start = performance.now();
  try {
    if (values.mode === "copy") {
      for (let index = 0; index < 4000; index++) {
        const directory = directories[index % directories.length]!;
        // The copy owner awaits filesystem work before each directory admission.
        const stat = await fsp.lstat(path.join(fixture, directory));
        await ensure(boundary, directory, undefined, stat.mode);
      }
    } else {
      for (let iteration = 0; iteration < 2; iteration++) {
        for (const skill of skills) {
          await ensure(boundary, skill);
        }
      }
    }
  } finally {
    fs.openSync = open;
  }
  const elapsedMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuBefore);
  const thread = process.threadCpuUsage(threadBefore);
  const memoryAfter = process.memoryUsage();
  await nextTurn();
  loop.disable();
  gc.disconnect();
  const profile = inspector
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  for (const directory of [...directories, ...skills]) {
    assert.equal((await fsp.stat(path.join(fixture, directory))).mode & 0o700, 0o700);
  }
  console.log(
    JSON.stringify({
      owner: values.owner,
      mode: values.mode,
      allocations: values.allocations,
      directoryVisits: values.mode === "copy" ? 4000 : 2080,
      elapsedMs,
      mainThreadCpuMs: (thread.user + thread.system) / 1000,
      processCpuMs: (cpu.user + cpu.system) / 1000,
      synchronousOpens: opens,
      sampledBytes: profile?.samples.reduce((sum, sample) => sum + sample.size, 0),
      gc: collections,
      gcTotalMs: collections.reduce((sum, entry) => sum + entry.ms, 0),
      loop: {
        samples: loop.count,
        p99Ms: loop.percentile(99) / 1e6,
        maxMs: loop.max / 1e6,
      },
      memoryBefore,
      memoryAfter,
      hostLoadBefore: loadBefore,
      hostLoadAfter: os.loadavg(),
    }),
  );
} finally {
  inspector?.disconnect();
  await fsp.rm(fixture, { recursive: true, force: true });
}
