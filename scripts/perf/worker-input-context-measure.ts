/**
 * Compare the two transcript readers used by Gateway worker input preparation.
 * Seed only synthetic state with session-initial-context-fixture.ts, then run:
 * OPENCLAW_STATE_DIR=<fixture> node --expose-gc --import ./scripts/tsx.mjs
 *   scripts/perf/worker-input-context-measure.ts [--allocation]
 * A1/A2 use the former full-history reader; B uses the selected-context reader.
 * Five interleaved triplets exclude seeding, import and reader warmup. Accept only
 * equal model context, fewer hydrated entries and no >20% CPU/wall regression.
 * Allocation samples cover the main thread, not worker/native SQLite allocation.
 * These are warm reader-owner costs, not Gateway transport or model latency.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const { values } = parseArgs({ options: { allocation: { type: "boolean", default: false } } });
const stateDir = process.env.OPENCLAW_STATE_DIR;
assert(stateDir && path.isAbsolute(stateDir), "Set OPENCLAW_STATE_DIR to synthetic fixture state");
assert(globalThis.gc, "Run with --expose-gc");
const storePath = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
assert(existsSync(storePath), "Seed session-initial-context-fixture.ts first");
const { SessionManager } = await import("../../src/agents/sessions/session-manager.js");
const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const target = {
  agentId: "main",
  sessionId: "synthetic-session",
  sessionKey: "agent:main:synthetic-session",
  storePath,
};
const read = (label: string) =>
  label === "B" ? SessionManager.openModelContextAsync(target) : SessionManager.openAsync(target);
const digest = (manager: Awaited<ReturnType<typeof read>>) =>
  hash("sha256", JSON.stringify(manager.buildSessionContext().messages), "hex");
try {
  const expected = digest(await read("A1"));
  const selected = await read("B");
  assert.equal(digest(selected), expected);
  const databaseBytes = statSync(storePath).size;
  for (let sample = 0; sample < 5; sample++) {
    for (const label of sample % 2 ? ["B", "A2", "A1"] : ["A1", "A2", "B"]) {
      globalThis.gc();
      const inspector = values.allocation ? new Session() : undefined;
      if (inspector) {
        await startCollectedHeapSampling(inspector, 4096);
      }
      const load = loadavg();
      const cpu = process.cpuUsage();
      const start = performance.now();
      let manager = await read(label);
      for (let index = 1; index < 10; index++) {
        manager = await read(label);
      }
      const elapsedMs = performance.now() - start;
      const usedCpu = process.cpuUsage(cpu);
      const allocatedBytes = inspector
        ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
        : undefined;
      inspector?.disconnect();
      assert.equal(digest(manager), expected);
      console.log(
        JSON.stringify({
          label,
          sample,
          operations: 10,
          allocation: values.allocation,
          elapsedMs,
          cpuMs: (usedCpu.user + usedCpu.system) / 1000,
          allocatedBytes,
          loadedEntries: manager.getEntries().length,
          databaseBytes,
          load,
        }),
      );
    }
  }
} finally {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}
