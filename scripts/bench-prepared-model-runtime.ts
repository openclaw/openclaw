// Bounded warm-path benchmark, following @zeroaltitude's #90741 investigation shape.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { discoverAuthStorage, discoverModels } from "../src/agents/agent-model-discovery.js";
import { ensureOpenClawModelsJson } from "../src/agents/models-config.js";
import {
  prepareModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
} from "../src/agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import {
  captureCurrentPluginMetadataSnapshotState,
  restoreCurrentPluginMetadataSnapshotState,
  setCurrentPluginMetadataSnapshot,
} from "../src/plugins/current-plugin-metadata-snapshot.js";
import { resolvePluginMetadataSnapshot } from "../src/plugins/plugin-metadata-snapshot.js";

const BATCHES = 20;
const OPERATIONS_PER_BATCH = 25;
const WARMUP_OPERATIONS = 25;

type TimingSummary = {
  operations: number;
  p50Us: number;
  p95Us: number;
  totalMs: number;
};

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

async function measureBatches(run: () => void | Promise<void>): Promise<TimingSummary> {
  const batchUs: number[] = [];
  const totalStarted = performance.now();
  for (let batch = 0; batch < BATCHES; batch += 1) {
    const started = performance.now();
    for (let operation = 0; operation < OPERATIONS_PER_BATCH; operation += 1) {
      await run();
    }
    batchUs.push(((performance.now() - started) * 1_000) / OPERATIONS_PER_BATCH);
  }
  const totalMs = performance.now() - totalStarted;
  batchUs.sort((left, right) => left - right);
  return {
    operations: BATCHES * OPERATIONS_PER_BATCH,
    p50Us: percentile(batchUs, 0.5),
    p95Us: percentile(batchUs, 0.95),
    totalMs,
  };
}

async function main(): Promise<void> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-prepared-model-bench-"));
  const agentDir = path.join(rootDir, "agent");
  const workspaceDir = path.join(rootDir, "workspace");
  const config = {
    agents: { defaults: { workspace: workspaceDir } },
    plugins: { enabled: false },
  } satisfies OpenClawConfig;
  const previousPluginSnapshot = captureCurrentPluginMetadataSnapshotState();
  try {
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    const pluginMetadataSnapshot = resolvePluginMetadataSnapshot({ config, workspaceDir });
    setCurrentPluginMetadataSnapshot(pluginMetadataSnapshot, { config, workspaceDir });
    await ensureOpenClawModelsJson(config, agentDir, { workspaceDir });
    const legacy = () => {
      const authStorage = discoverAuthStorage(agentDir, {
        config,
        inheritedAuthDir: agentDir,
        workspaceDir,
      });
      discoverModels(authStorage, agentDir, {
        config,
        pluginMetadataSnapshot,
        workspaceDir,
      });
    };
    for (let index = 0; index < WARMUP_OPERATIONS; index += 1) {
      legacy();
    }
    const requestTimeDiscovery = await measureBatches(legacy);

    const lifecycleBuildStarted = performance.now();
    await publishPreparedModelRuntimeSnapshot({
      config,
      agentDir,
      inheritedAuthDir: agentDir,
      workspaceDir,
    });
    const lifecycleBuildMs = performance.now() - lifecycleBuildStarted;
    const prepared = async () => {
      const snapshot = await prepareModelRuntimeSnapshot({
        config,
        agentDir,
        inheritedAuthDir: agentDir,
        workspaceDir,
      });
      snapshot.createStores();
    };
    for (let index = 0; index < WARMUP_OPERATIONS; index += 1) {
      await prepared();
    }
    const lifecycleSnapshot = await measureBatches(prepared);
    const speedup = requestTimeDiscovery.p50Us / lifecycleSnapshot.p50Us;

    console.log(
      JSON.stringify(
        {
          batches: BATCHES,
          operationsPerBatch: OPERATIONS_PER_BATCH,
          lifecycleBuildMs,
          requestTimeDiscovery,
          lifecycleSnapshot,
          p50Speedup: speedup,
        },
        null,
        2,
      ),
    );
  } finally {
    restoreCurrentPluginMetadataSnapshotState(previousPluginSnapshot);
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

await main();
