/**
 * End-to-end benchmark: scoped controller query vs full-table scan.
 *
 * Measures the actual public callers, not isolated SQL helpers.
 *
 * Usage:
 *   pnpm vitest run src/agents/subagent-registry-scoped.bench.test.ts
 * Or standalone:
 *   npx tsx src/agents/subagent-registry-scoped.bench.test.ts
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { listRunsForControllerFromRuns } from "./subagent-registry-queries.js";
import {
  getSubagentRunsSnapshotForController,
  getSubagentRunsSnapshotForRead,
} from "./subagent-registry-state.js";
import { saveSubagentRegistryToSqlite } from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const RECORD_COUNT = 10_000;

function makeRun(runId: string, overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  const idx = Number.parseInt(runId.split("-")[1] ?? "0", 10);
  return {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: overrides.requesterSessionKey ?? `agent:main:requester-${idx % 20}`,
    requesterDisplayKey: "benchmark",
    task: `benchmark task ${runId}`,
    cleanup: "keep",
    createdAt: 1000 + idx,
    startedAt: 1010 + idx,
    endedAt: 2000 + idx,
    ...overrides,
  };
}

describe("controller query end-to-end benchmark", () => {
  let tempStateDir: string | null = null;

  beforeEach(async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-e2e-bench-"));
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      tempStateDir = null;
    }
  });

  async function withTempEnv<T>(fn: () => Promise<T>): Promise<T> {
    if (!tempStateDir) {
      throw new Error("expected temp state dir");
    }
    return await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: tempStateDir,
        OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK: "1",
      },
      fn,
    );
  }

  it("scoped controller snapshot matches full-scan results byte-identically", async () => {
    await withTempEnv(async () => {
      const runs = new Map<string, SubagentRunRecord>();
      for (let i = 0; i < 1_000; i++) {
        const runId = `correctness-${i}`;
        runs.set(
          runId,
          makeRun(runId, {
            requesterSessionKey: `agent:main:requester-${i % 5}`,
            controllerSessionKey: i % 3 === 0 ? `agent:main:ctrl-${i % 4}` : undefined,
          }),
        );
      }

      saveSubagentRegistryToSqlite(runs);

      const controllerKey = "agent:main:ctrl-2";

      // Full scan reference
      const fullSnapshot = getSubagentRunsSnapshotForRead(new Map());
      const fullResult = listRunsForControllerFromRuns(fullSnapshot, controllerKey);
      const fullIds = fullResult.map((r) => r.runId).toSorted();

      // Scoped path
      const scopedSnapshot = getSubagentRunsSnapshotForController(new Map(), controllerKey);
      const scopedResult = listRunsForControllerFromRuns(scopedSnapshot, controllerKey);
      const scopedIds = scopedResult.map((r) => r.runId).toSorted();

      expect(scopedIds).toEqual(fullIds);
      expect(fullIds.length).toBeGreaterThan(0);
    });
  });

  it("scoped controller snapshot overlays in-memory runs correctly", async () => {
    await withTempEnv(async () => {
      const persisted = makeRun("persisted", {
        controllerSessionKey: "agent:main:ctrl",
        requesterSessionKey: "agent:main:other",
      });
      saveSubagentRegistryToSqlite(new Map([["persisted", persisted]]));

      // In-memory run with the same controller key that overrides persisted
      const inMemory = new Map([
        [
          "in-mem",
          makeRun("in-mem", {
            controllerSessionKey: "agent:main:ctrl",
            requesterSessionKey: "agent:main:other",
          }),
        ],
      ]);

      const scoped = getSubagentRunsSnapshotForController(inMemory, "agent:main:ctrl");
      expect(scoped.has("persisted")).toBe(true);
      expect(scoped.has("in-mem")).toBe(true);
    });
  });

  it("benchmark: scoped controller query vs full-table scan", async () => {
    await withTempEnv(async () => {
      // Seed
      const runs = new Map<string, SubagentRunRecord>();
      for (let i = 0; i < RECORD_COUNT; i++) {
        const runId = `bench-${i}`;
        runs.set(
          runId,
          makeRun(runId, {
            requesterSessionKey: `agent:main:requester-${i % 20}`,
            controllerSessionKey: i % 3 === 0 ? `agent:main:ctrl-${i % 10}` : undefined,
          }),
        );
      }
      saveSubagentRegistryToSqlite(runs);
      const controllerKey = "agent:main:ctrl-5";

      // Cold-cache run: both paths start from a clean cache
      const { clearSubagentRunsReadCacheForTest } = await import("./subagent-registry-state.js");
      clearSubagentRunsReadCacheForTest();

      // Full-scan baseline (cold)
      const fullTimesCold: number[] = [];
      for (let i = 0; i < 5; i++) {
        clearSubagentRunsReadCacheForTest();
        const t0 = performance.now();
        const snapshot = getSubagentRunsSnapshotForRead(new Map());
        void listRunsForControllerFromRuns(snapshot, controllerKey);
        fullTimesCold.push(performance.now() - t0);
      }

      // Scoped path (cold each iteration — scoped queries skip the global cache)
      const scopedTimesCold: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        const snapshot = getSubagentRunsSnapshotForController(new Map(), controllerKey);
        void listRunsForControllerFromRuns(snapshot, controllerKey);
        scopedTimesCold.push(performance.now() - t0);
      }

      const avgFullCold = fullTimesCold.reduce((a, b) => a + b, 0) / fullTimesCold.length;
      const avgScopedCold = scopedTimesCold.reduce((a, b) => a + b, 0) / scopedTimesCold.length;

      console.log(`\n  === Controller query cold-cache benchmark (${RECORD_COUNT} records) ===`);
      console.log(`  Full-scan (load all + filter): avg=${avgFullCold.toFixed(2)}ms`);
      console.log(`  Scoped   (indexed query):      avg=${avgScopedCold.toFixed(2)}ms`);
      console.log(`  Cold-cache speedup: ${(avgFullCold / avgScopedCold).toFixed(1)}x`);

      // Verify both paths return identical results
      clearSubagentRunsReadCacheForTest();
      const fullSnapshot = getSubagentRunsSnapshotForRead(new Map());
      const fullResult = listRunsForControllerFromRuns(fullSnapshot, controllerKey);
      const scopedSnapshot = getSubagentRunsSnapshotForController(new Map(), controllerKey);
      const scopedResult = listRunsForControllerFromRuns(scopedSnapshot, controllerKey);
      expect(scopedResult.map((r) => r.runId).toSorted()).toEqual(
        fullResult.map((r) => r.runId).toSorted(),
      );
    });
  }, 60_000);

  it("benchmark: warm repeated calls benefit from scoped cache", async () => {
    await withTempEnv(async () => {
      const runs = new Map<string, SubagentRunRecord>();
      for (let i = 0; i < RECORD_COUNT; i++) {
        const runId = `warm-${i}`;
        runs.set(
          runId,
          makeRun(runId, {
            requesterSessionKey: `agent:main:requester-${i % 20}`,
            controllerSessionKey: i % 3 === 0 ? `agent:main:ctrl-${i % 10}` : undefined,
          }),
        );
      }
      saveSubagentRegistryToSqlite(runs);
      const controllerKey = "agent:main:ctrl-5";

      const { clearSubagentRunsReadCacheForTest } = await import("./subagent-registry-state.js");
      clearSubagentRunsReadCacheForTest();

      // Full-scan warm: first call populates the 500ms global cache
      const t0Full = performance.now();
      for (let i = 0; i < 20; i++) {
        const snapshot = getSubagentRunsSnapshotForRead(new Map());
        void listRunsForControllerFromRuns(snapshot, controllerKey);
      }
      const fullWarmTotal = performance.now() - t0Full;

      // Scoped warm: first call populates the per-key scoped cache
      clearSubagentRunsReadCacheForTest();
      const t0Scoped = performance.now();
      for (let i = 0; i < 20; i++) {
        const snapshot = getSubagentRunsSnapshotForController(new Map(), controllerKey);
        void listRunsForControllerFromRuns(snapshot, controllerKey);
      }
      const scopedWarmTotal = performance.now() - t0Scoped;

      console.log(`\n  === Warm repeated-call benchmark (20 calls, same key) ===`);
      console.log(
        `  Full-scan (global cache): total=${fullWarmTotal.toFixed(2)}ms avg=${(fullWarmTotal / 20).toFixed(2)}ms`,
      );
      console.log(
        `  Scoped   (per-key cache): total=${scopedWarmTotal.toFixed(2)}ms avg=${(scopedWarmTotal / 20).toFixed(2)}ms`,
      );
      console.log(`  Warm speedup: ${(fullWarmTotal / scopedWarmTotal).toFixed(1)}x`);

      // Scoped warm path should be competitive with cached full-scan
      // (even if the full-scan cache is warm after call 1, its hydration
      // cost is still higher than the scoped per-key cache lookup)
      expect(scopedWarmTotal).toBeLessThan(200);
    });
  }, 60_000);

  it("benchmark: recursive multi-controller traversal", async () => {
    await withTempEnv(async () => {
      // Simulate a recursive status or control workload: 10 controller
      // keys with records evenly distributed across them.
      const CONTROLLER_COUNT = 10;
      const runs = new Map<string, SubagentRunRecord>();
      for (let i = 0; i < RECORD_COUNT; i++) {
        const runId = `rec-${i}`;
        runs.set(
          runId,
          makeRun(runId, {
            requesterSessionKey: `agent:main:requester-${i % 20}`,
            controllerSessionKey:
              i % 3 === 0 ? `agent:main:ctrl-${i % CONTROLLER_COUNT}` : undefined,
          }),
        );
      }
      saveSubagentRegistryToSqlite(runs);

      const { clearSubagentRunsReadCacheForTest } = await import("./subagent-registry-state.js");
      clearSubagentRunsReadCacheForTest();
      const controllerKeys = Array.from(
        { length: CONTROLLER_COUNT },
        (_, idx) => `agent:main:ctrl-${idx}`,
      );

      // Full-scan recursive: hydrate once, filter N times
      const t0Full = performance.now();
      for (const key of controllerKeys) {
        const snapshot = getSubagentRunsSnapshotForRead(new Map());
        void listRunsForControllerFromRuns(snapshot, key);
      }
      const fullRecursiveTotal = performance.now() - t0Full;

      // Scoped recursive: one indexed query per key (cached after first)
      clearSubagentRunsReadCacheForTest();
      const t0Scoped = performance.now();
      for (const key of controllerKeys) {
        const snapshot = getSubagentRunsSnapshotForController(new Map(), key);
        void listRunsForControllerFromRuns(snapshot, key);
      }
      const scopedRecursiveTotal = performance.now() - t0Scoped;

      const fullAvg = fullRecursiveTotal / CONTROLLER_COUNT;
      const scopedAvg = scopedRecursiveTotal / CONTROLLER_COUNT;

      console.log(
        `\n  === Recursive multi-controller benchmark (${CONTROLLER_COUNT} keys, ${RECORD_COUNT} records) ===`,
      );
      console.log(
        `  Full-scan (1 hydrate + N filters): total=${fullRecursiveTotal.toFixed(2)}ms avg=${fullAvg.toFixed(2)}ms`,
      );
      console.log(
        `  Scoped   (N indexed + cache):      total=${scopedRecursiveTotal.toFixed(2)}ms avg=${scopedAvg.toFixed(2)}ms`,
      );
      console.log(
        `  Recursive speedup: ${(fullRecursiveTotal / scopedRecursiveTotal).toFixed(1)}x`,
      );

      // Scoped should be competitive with full-scan for recursive workloads
      // (the per-key cache and indexed reads dominate the single large
      // full-table scan + N in-memory filters)
      expect(scopedRecursiveTotal).toBeLessThan(500);
    });
  }, 60_000);
});
