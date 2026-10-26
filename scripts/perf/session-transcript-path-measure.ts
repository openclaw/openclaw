/**
 * Owner microbenchmark for sibling/relocated absolute transcript paths (40 agents).
 * Run on each revision, alternating order, with:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-transcript-path-measure.ts
 *   --iterations 5000 --rounds 5
 * Fixtures and warmup are excluded. CPU/wall timing is untraced; sampled allocation
 * is a separate pass. This measures legacy artifact resolution, not sessions.list.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { resolveSessionFilePathCore } from "../../src/config/sessions/paths.js";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "5000" },
    rounds: { type: "string", default: "5" },
  },
});
const iterations = Number(values.iterations);
const rounds = Number(values.rounds);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isSafeInteger(rounds) && rounds > 0);
assert(globalThis.gc, "Run with --expose-gc");
fs.mkdirSync(".local", { recursive: true });
const root = fs.realpathSync(fs.mkdtempSync(path.resolve(".local/transcript-path-measure-")));
const inspector = new Session();
inspector.connect();
let checksum = 0;
try {
  const sessionsDir = path.join(root, "agents", "main", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const fixtures = Array.from({ length: 40 }, (_, index) => {
    const agentId = `worker-${index}`;
    const directory = path.join(root, "agents", agentId, "sessions");
    fs.mkdirSync(directory, { recursive: true });
    const sessionId = `session-${index}`;
    const expected = path.join(directory, `${sessionId}.jsonl`);
    fs.writeFileSync(expected, "{}\n");
    return {
      sessionId,
      expected,
      sibling: { sessionFile: expected },
      relocated: {
        sessionFile: path.join(
          root,
          "missing",
          "agents",
          agentId,
          "sessions",
          `${sessionId}.jsonl`,
        ),
      },
      options: { sessionsDir, agentId },
    };
  });
  for (const workload of ["sibling", "relocated"] as const) {
    const run = (count: number) => {
      for (let index = 0; index < count; index++) {
        const fixture = fixtures[index % fixtures.length]!;
        checksum += resolveSessionFilePathCore(
          fixture.sessionId,
          fixture[workload],
          fixture.options,
        ).length;
      }
    };
    for (const fixture of fixtures) {
      assert.equal(
        resolveSessionFilePathCore(fixture.sessionId, fixture[workload], fixture.options),
        fixture.expected,
      );
    }
    run(1000);
    for (let round = 0; round < rounds; round++) {
      globalThis.gc();
      const load = os.loadavg();
      const cpu = process.cpuUsage();
      const start = performance.now();
      run(iterations);
      const wallMs = performance.now() - start;
      const used = process.cpuUsage(cpu);
      globalThis.gc();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      run(iterations);
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      let allocatedBytes = 0;
      const pending = [profile.head];
      while (pending.length) {
        const node = pending.pop()!;
        allocatedBytes += node.selfSize;
        pending.push(...node.children);
      }
      console.log(
        JSON.stringify({
          workload,
          round,
          iterations,
          load,
          wallMs,
          cpuMs: (used.user + used.system) / 1000,
          allocatedBytes,
        }),
      );
    }
  }
  console.log(JSON.stringify({ checksum }));
} finally {
  inspector.disconnect();
  fs.rmSync(root, { recursive: true, force: true });
}
