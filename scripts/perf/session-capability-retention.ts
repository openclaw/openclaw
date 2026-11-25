/**
 * Completed capability-preparation retention with 5,000 synthetic sessions and 40 plugins.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-capability-retention.ts
 * Optional first argument selects the frozen baseline subagent-session-store module.
 * Five batches visit 1,000 preallocated lookups; retained lookups must not retain completed runs.
 * This isolates the owner; it does not model provider latency or workspace/database scan cost.
 */
import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { queryObjects } from "node:v8";
import { writeSessionEntry } from "../../src/config/sessions/session-accessor.sqlite-entry-store.js";
import { LegacyContextEngine } from "../../src/context-engine/legacy.js";
import {
  registerContextEngineInRegistry,
  resolveContextEngine,
} from "../../src/context-engine/registry.js";
import { ContextEngineFactoryResources } from "../../src/context-engine/registry.resources.js";
import type { ContextEngine } from "../../src/context-engine/types.js";
import { PluginInstance } from "../../src/plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../src/plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../src/plugins/status.test-helpers.js";
import { runOpenClawAgentWriteTransaction } from "../../src/state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { collectForRetentionCheck, expectCollected } from "../../src/test-utils/retention.js";

const {
  createSubagentSessionStore,
  withPreparedSessionCapabilityRead,
}: typeof import("../../src/agents/subagents/spawn/subagent-session-store.js") = await import(
  process.argv[2]
    ? pathToFileURL(process.argv[2]).href
    : new URL("../../src/agents/subagents/spawn/subagent-session-store.ts", import.meta.url).href
);

class RunState {
  payload = Array.from({ length: 16_384 }, () => 7);
  controllers = Array.from({ length: 40 }, () => new AbortController());
  readonly engine: ContextEngine;
  constructor(engine: ContextEngine) {
    this.engine = engine;
  }
}

const sampledBytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);

await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
  const storePath = state.statePath("capability-retention.sqlite");
  const key = (index: number) => `agent:main:subagent:retention-${index}`;
  runOpenClawAgentWriteTransaction(
    (database) => {
      for (let index = 0; index < 5_000; index++) {
        writeSessionEntry(database, key(index), {
          sessionId: `retention-${index}`,
          updatedAt: index + 1,
          spawnDepth: 2,
        });
      }
    },
    { agentId: "main", path: storePath },
  );
  const registry = createEmptyPluginRegistry();
  const instances = Array.from({ length: 40 }, (_, index) => {
    const record = createPluginRecord({ id: `retention-plugin-${index}` });
    registry.plugins.push(record);
    return new PluginInstance(record.id, { record, registry });
  });
  registerContextEngineInRegistry(registry, "legacy", () => new LegacyContextEngine(), "core");
  const stores = Array.from({ length: 1_000 }, () => createSubagentSessionStore(storePath, "main"));
  const refs: WeakRef<object>[] = [];
  async function run(index: number) {
    const engine = await withPluginRuntimeRegistryScope(registry, () => resolveContextEngine());
    const runState = new RunState(engine);
    refs.push(new WeakRef(runState), new WeakRef(engine));
    const store = stores[index]!;
    try {
      await withPreparedSessionCapabilityRead(
        () => {
          assert.equal(runState.payload.length, 16_384);
          assert.equal(store.get(key(index))?.spawnDepth, 2);
        },
        { retain: true },
      );
    } finally {
      await engine.dispose?.();
    }
  }
  const inspector = new Session();
  inspector.connect();
  async function measure(batch: number) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const start = performance.now();
    const cpu = process.cpuUsage();
    for (let index = batch * 200; index < (batch + 1) * 200; index++) {
      await run(index);
    }
    const used = process.cpuUsage(cpu);
    const wallMs = performance.now() - start;
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    return {
      wallMs,
      cpuMs: (used.user + used.system) / 1000,
      allocatedBytes: sampledBytes(profile.head),
    };
  }
  try {
    await collectForRetentionCheck("capability-baseline");
    const factorySourcesBefore = queryObjects(ContextEngineFactoryResources);
    const heapBefore = process.memoryUsage().heapUsed;
    for (let batch = 0; batch < 5; batch++) {
      const measured = await measure(batch);
      await collectForRetentionCheck(`capability-${batch}`);
      const factorySources = queryObjects(ContextEngineFactoryResources);
      console.log(
        JSON.stringify({
          batch,
          turns: 200,
          ...measured,
          heapGrowth: process.memoryUsage().heapUsed - heapBefore,
          runStates: queryObjects(RunState),
          factorySources,
          liveRefs: refs.filter((ref) => ref.deref() !== undefined).length,
          retainedLookups: stores.length,
        }),
      );
      if (!process.argv[2]) {
        assert.equal(factorySources, factorySourcesBefore);
      }
    }
    if (!process.argv[2]) {
      await expectCollected(...refs);
    }
  } finally {
    inspector.disconnect();
    for (const instance of instances) {
      await instance.dispose();
    }
  }
});
