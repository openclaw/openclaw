/**
 * Run on base and candidate with the same Node version:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-patch-label-owner-measure.ts
 * Five warm timing passes and one separate allocation pass, 5,000 updates per patch kind.
 * Uses the production label owner with 2,000 synthetic sessions (400 descendants).
 * Fixture construction and index initialization are excluded. This measures the label
 * bookkeeping phase, not validation, worker writes, row publication, or Gateway latency.
 * Acceptance: identical entry JSON, correct label ownership, lower CPU/allocation.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { SessionLabelOwnerIndex } from "../../src/config/sessions/session-entry-selection.js";
import type { SessionEntry } from "../../src/config/sessions/types.js";

const iterations = 5_000;
const passes = 5;
const samplingInterval = 512;
const gc = global.gc;
assert(gc, "Run with --expose-gc");
const sourceSha256 = createHash("sha256")
  .update(
    readFileSync(new URL("../../src/config/sessions/session-entry-selection.ts", import.meta.url)),
  )
  .digest("hex");
const entries: SessionEntry[] = Array.from({ length: 2_000 }, (_, i) => ({
  sessionId: `synthetic-${i}`,
  updatedAt: 1_800_000_000_000,
  lifecycleRevision: `revision-${i}`,
  label: `Session ${i}`,
  ...(i < 400 ? { parentSessionKey: `agent:main:synthetic-${400 + i}` } : {}),
  modelProvider: "mock",
  model: "mock-model",
  skillsSnapshot: {
    prompt: "Synthetic retained skill instructions. ".repeat(300),
    skills: [{ name: "synthetic-skill", requiredEnv: ["SYNTHETIC_SETTING"] }],
  },
}));
const keys = entries.map((entry) => `agent:main:${entry.sessionId}`);
const candidates = keys.map((key) => [key]);
const patches = {
  title: { label: "Renamed" },
  pin: { pinnedAt: 1_800_000_001_000 },
  archive: { archivedAt: 1_800_000_001_000, archiveReason: "manual" },
  model: { providerOverride: "mock", modelOverride: "other-model" },
  group: { category: "Synthetic group" },
} satisfies Record<string, Partial<SessionEntry>>;
const inspector = new Session();
inspector.connect();
try {
  const results = [];
  for (const [kind, patch] of Object.entries(patches)) {
    const projected = entries.map((entry) => ({ ...entry, ...patch }));
    const store = Object.fromEntries(keys.map((key, i) => [key, entries[i]!]));
    const owner = new SessionLabelOwnerIndex(store);
    let last: SessionEntry | undefined;
    const run = () => {
      for (let i = 0; i < iterations; i++) {
        const offset = i % entries.length;
        last = owner.replaceEntry(candidates[offset]!, keys[offset]!, projected[offset]!);
      }
    };
    const verify = () => {
      const offset = (iterations - 1) % entries.length;
      assert.equal(JSON.stringify(last), JSON.stringify(projected[offset]));
      assert(owner.isLabelInUse(projected[offset]!.label!, []));
      assert.equal(JSON.stringify(store[keys[offset]!]), JSON.stringify(projected[offset]));
    };
    run();
    verify();
    const hostLoadBefore = loadavg();
    const timing = [];
    for (let pass = 0; pass < passes; pass++) {
      gc();
      const cpu = process.threadCpuUsage();
      const start = performance.now();
      run();
      const wallMs = performance.now() - start;
      const used = process.threadCpuUsage(cpu);
      timing.push({
        wallUsPerOperation: (wallMs * 1_000) / iterations,
        cpuUsPerOperation: (used.user + used.system) / iterations,
      });
      verify();
    }
    gc();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    run();
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    verify();
    results.push({
      kind,
      timing,
      sampledBytesPerOperation:
        profile.samples.reduce((sum, sample) => sum + sample.size, 0) / iterations,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
    });
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        sourceSha256,
        sessions: entries.length,
        descendants: 400,
        iterationsPerPass: iterations,
        passes,
        samplingInterval,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  inspector.disconnect();
}
