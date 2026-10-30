// Isolate the repository discovery removed from ordinary new worktree creation.
// Run against a synthetic Team-shaped fixture's project checkout (read-only):
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-create-repository-measure.ts \
//   --repo .local/create-base-fixture/fixture-projects/team-shape-project-0 --iterations 100 --pairs 5
// The base composes preparation's path discovery with the creation owner's full
// discovery; the candidate consumes the latter's sourceRoot. Real Git runs in
// both arms. CPU is this Node process, excluding Git children. --allocations
// selects a separate sampled-allocation pass; its timing is diagnostic only.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import {
  resolveRepository,
  resolveRepositoryPaths,
} from "../../src/agents/worktrees/repository-paths.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    iterations: { type: "string", default: "100" },
    pairs: { type: "string", default: "5" },
    allocations: { type: "boolean", default: false },
  },
});
assert(values.repo, "--repo must name a synthetic project checkout");
const repo = values.repo;
const integer = (name: "iterations" | "pairs") =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback: 1 });
const iterations = integer("iterations");
const pairs = integer("pairs");
const expected = await resolveRepository(repo);
const profiler = new Session();
profiler.connect();
try {
  for (let pair = 0; pair < pairs; pair++) {
    for (const arm of pair % 2 ? ["candidate", "base"] : ["base", "candidate"]) {
      // Warm module/Git execution separately from the measured arm.
      await resolveRepositoryPaths(repo);
      await resolveRepository(repo);
      global.gc?.();
      if (values.allocations) {
        await profiler.post("HeapProfiler.startSampling", {
          samplingInterval: 32768,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const cpu = process.cpuUsage();
      const started = performance.now();
      const hostLoadBefore = os.loadavg();
      for (let index = 0; index < iterations; index++) {
        const preflight = arm === "base" ? await resolveRepositoryPaths(repo) : undefined;
        const created = await resolveRepository(repo);
        assert.equal(created.sourceRoot, expected.sourceRoot);
        assert.equal(created.repoRoot, expected.repoRoot);
        if (preflight) {
          assert.equal(preflight.sourceRoot, created.sourceRoot);
        }
      }
      const elapsedMs = performance.now() - started;
      const used = process.cpuUsage(cpu);
      let sampledBytes: number | undefined;
      if (values.allocations) {
        const { profile } = await profiler.post("HeapProfiler.stopSampling");
        sampledBytes = profile.samples.reduce((total, sample) => total + sample.size, 0);
      }
      console.log(
        JSON.stringify({
          pair: pair + 1,
          arm,
          iterations,
          mode: values.allocations ? "allocation" : "timing",
          elapsedMs,
          cpuMs: (used.user + used.system) / 1000,
          sampledBytes,
          hostLoadBefore,
          hostLoadAfter: os.loadavg(),
        }),
      );
    }
  }
} finally {
  profiler.disconnect();
}
