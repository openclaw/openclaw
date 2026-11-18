/**
 * Synchronous chat.metadata auth-generation check, not a whole-Gateway benchmark.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/chat-metadata-auth-check-measure.ts \
 *   --agents 8 --iterations 5000 --pairs 5 [--allocations]
 * Pairs alternate AB/BA; allocation sampling runs separately from timing.
 * Baseline is the pre-change authStoresCurrent loop. Both arms use real auth revision
 * readers and synthetic process-owned state, without opening a database or Gateway.
 * Agent count drives this operation; session/plugin/client counts do not enter it.
 * Work-count regression (also runnable on the base revision):
 * node --experimental-test-module-mocks --import ./scripts/tsx.mjs \
 *   scripts/perf/chat-metadata-auth-check-measure.ts --check-reads
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { noteCommittedSharedAuthStoreOwnership } from "../../src/agents/auth-profiles/path-resolve.js";
import { getRuntimeAuthProfileStoreMetadataRevision } from "../../src/agents/auth-profiles/runtime-snapshots.js";
import type { PreparedGenerationFacts } from "../../src/gateway/server-methods/chat-metadata-facts.js";
import { createPluginMetadataSnapshotFixture } from "../../src/plugins/plugin-metadata.test-support.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    agents: { type: "string", default: "8" },
    iterations: { type: "string", default: "5000" },
    pairs: { type: "string", default: "5" },
    allocations: { type: "boolean", default: false },
    "check-reads": { type: "boolean", default: false },
  },
});
const count = (raw: string, label: string) =>
  parseStrictIntegerOption({ raw, label, min: 1, fallback: 1 });
const agents = count(values.agents, "--agents");
const iterations = count(values.iterations, "--iterations");
const pairs = count(values.pairs, "--pairs");
let sharedReads = 0;
if (values["check-reads"]) {
  const { mock } = await import("node:test");
  const auth = await import("../../src/agents/auth-profiles/runtime-snapshots.js");
  mock.module(
    new URL("../../src/agents/auth-profiles/runtime-snapshots.ts", import.meta.url).href,
    {
      exports: {
        ...auth,
        getRuntimeAuthProfileStoreMetadataRevision(dir?: string) {
          sharedReads += Number(dir === undefined);
          return getRuntimeAuthProfileStoreMetadataRevision(dir);
        },
      },
    },
  );
}
const { authStoresCurrent } =
  await import("../../src/gateway/server-methods/chat-metadata-facts.js");
const stateDir = path.resolve(".local/chat-metadata-auth-check/state");
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_HOME: stateDir,
  OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
});
noteCommittedSharedAuthStoreOwnership({ location: "state-db" });
const config = {};
const modelCatalog = { entries: [], routeVariants: [] };
const authModes = {};
const metadataSnapshot = createPluginMetadataSnapshotFixture();
const facts: PreparedGenerationFacts = {
  config,
  configKey: "synthetic",
  pluginRegistryVersion: 0,
  agents: Array.from({ length: agents }, (_, index) => {
    const agentId = `agent-${index}`;
    const agentDir = path.join(stateDir, "agents", agentId, "agent");
    const workspaceDir = path.join(stateDir, "workspaces", agentId);
    return {
      agentId,
      owner: {
        agentId,
        agentDir,
        workspaceDir,
        catalogOwner: { agentId, workspaceDir },
        config,
        observationConfig: config,
        authModes,
        modelCatalog,
        metadataSnapshot,
        activeProjectKeys: [],
        allowGatewaySubagentBinding: false,
        configuredRuntimeModels: [],
        inlineProviderModels: [],
        findConfiguredRuntimeModel: () => undefined,
        isCurrent: () => true,
        createStores() {
          throw new Error("Auth revision checks must not create model stores");
        },
      },
      authStore: { version: 1, profiles: {} },
      authModes,
      modelCatalog,
      authStoreRevision: `${getRuntimeAuthProfileStoreMetadataRevision(agentDir)}:${getRuntimeAuthProfileStoreMetadataRevision()}`,
      authCatalogRevision: "synthetic",
      catalogRefreshFailed: false,
      skillsVersion: 0,
    };
  }),
};
const baseline = () =>
  facts.agents.every(
    ({ owner, authStoreRevision }) =>
      authStoreRevision ===
      `${getRuntimeAuthProfileStoreMetadataRevision(owner.agentDir)}:${getRuntimeAuthProfileStoreMetadataRevision(owner.inheritedAuthDir)}`,
  );
assert.equal(baseline(), true);
assert.equal(authStoresCurrent(facts), true);
if (values["check-reads"]) {
  assert.equal(sharedReads, 1, `expected one shared revision read for ${agents} agents`);
  assert.equal(authStoresCurrent(facts), true);
  assert.equal(sharedReads, 2, "the next scan must read shared ownership again");
  console.log(JSON.stringify({ agents, checks: 2, sharedReads }));
}
async function measure(mode: "baseline" | "candidate", pair: number) {
  const run = mode === "baseline" ? baseline : () => authStoresCurrent(facts);
  for (let i = 0; i < 100; i++) {
    run();
  }
  global.gc?.();
  const inspector = new Session();
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const loadStart = os.loadavg();
  const cpuStart = process.threadCpuUsage();
  const started = performance.now();
  let current = 0;
  for (let i = 0; i < iterations; i++) {
    current += Number(run());
  }
  const elapsedMs = performance.now() - started;
  const cpu = process.threadCpuUsage(cpuStart);
  assert.equal(current, iterations);
  let sampledAllocationBytes: number | undefined;
  if (values.allocations) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledAllocationBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    inspector.disconnect();
  }
  console.log(
    JSON.stringify({
      mode,
      pair,
      allocations: values.allocations,
      agents,
      iterations,
      elapsedMs,
      wallUsPerOperation: (elapsedMs * 1000) / iterations,
      cpuUsPerOperation: (cpu.user + cpu.system) / iterations,
      sampledAllocationBytesPerOperation:
        sampledAllocationBytes === undefined ? undefined : sampledAllocationBytes / iterations,
      loadStart,
      loadEnd: os.loadavg(),
    }),
  );
}
for (let pair = 0; !values["check-reads"] && pair < pairs; pair++) {
  const modes = ["baseline", "candidate"] as const;
  for (const mode of pair % 2 === 0 ? modes : modes.toReversed()) {
    await measure(mode, pair + 1);
  }
}
