/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-row-plugin-state-capture.ts
 * Use --counts for cold/warm projection and overlapping-write work counts.
 * Use --allocation separately from the default uninstrumented timing.
 * --baseline points to a directory containing the original changed source files by basename.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    counts: { type: "boolean" },
    allocation: { type: "boolean" },
  },
});
assert(!(values.counts && values.allocation));
const sources = [
  "src/plugin-state/plugin-state-publication.ts",
  "src/plugin-state/plugin-state-worker-client.ts",
  "src/state/openclaw-state-db-async-lifecycle.ts",
  "src/state/openclaw-state-worker-context.capture.ts",
  "src/state/openclaw-state-db-schema-policy.ts",
];
const root = new URL("../../", import.meta.url).href;
const paths = new Map(
  sources.map((source) => [
    root + source,
    values.baseline ? path.join(values.baseline, path.basename(source)) : new URL(root + source),
  ]),
);
const work = { captures: 0, added: 0, removed: 0, checks: 0, stale: 0 };
const recordCheck = (current: boolean) => {
  work.checks++;
  work.stale += Number(!current);
};
Object.assign(globalThis, {
  sessionRowCaptureWork: work,
  sessionRowCaptureRecordCheck: recordCheck,
});
registerHooks({
  load(url, context, nextLoad) {
    // Both arms use the same loader so transforms and source URLs match.
    const sourcePath = paths.get(url);
    const countCapture = values.counts && url === root + sources[0];
    const countCheck = values.counts && url === root + "src/gateway/session-row-database-facts.ts";
    if (!sourcePath && !countCapture && !countCheck) {
      return nextLoad(url, context);
    }
    let source = readFileSync(sourcePath ?? new URL(url), "utf8");
    if (countCapture) {
      const at = "  const capture: PluginStateReadCapture = {";
      assert(source.includes(at));
      source = source.replace(at, `  globalThis.sessionRowCaptureWork.captures++;\n${at}`);
      const subscribe = "  const stop = pluginStatePublication.subscribeFacts((change) => {";
      if (source.includes(subscribe)) {
        source = source.replace(
          subscribe,
          `  globalThis.sessionRowCaptureWork.added++;\n${subscribe}`,
        );
        source = source.replace(
          "    stop();",
          "    globalThis.sessionRowCaptureWork.removed++;\n    stop();",
        );
      }
    }
    if (countCheck) {
      const at = "(ownershipReads.get(identity(row))?.isCurrent() ?? true)";
      assert(source.includes(at));
      source = source.replace(
        at,
        `(() => {
        const ownership = ownershipReads.get(identity(row));
        if (!ownership) return true;
        const current = ownership.isCurrent();
        globalThis.sessionRowCaptureRecordCheck(current);
        return current;
      })()`,
      );
    }
    return { format: "module-typescript", source, shortCircuit: true };
  },
});

const { capturePluginStateReadDependencies } =
  await import("../../src/plugin-state/plugin-state-publication.js");
const { readSessionRuntimeOwnershipAsync } =
  await import("../../src/agents/harness/session-runtime-ownership.js");
const { createPluginStateKeyedStoreV2 } =
  await import("../../src/plugin-state/plugin-state-store.js");
const { seedPluginStateEntriesForTests } =
  await import("../../src/plugin-state/plugin-state-store.test-helpers.js");
const { harnessRegistry } = await import("../../src/agents/model-catalog-fixtures.test-support.js");
const { setActivePluginRegistry } = await import("../../src/plugins/runtime.js");
const { withOpenClawTestState } = await import("../../src/test-utils/openclaw-test-state.js");
const { MAX_SESSION_ROW_FACTS_KEYS } =
  await import("../../src/config/sessions/session-transcript-worker.types.js");

const sessions = 5_000;
const pluginId = "fixture-native";
const cfg = { agents: { entries: { main: {} } } };
const rows = Array.from({ length: sessions }, (_, index) => ({
  key: `agent:main:harness:${pluginId}:${index}`,
  entry: {
    sessionId: `fixture-${index}`,
    updatedAt: index + 1,
    agentHarnessId: pluginId,
    modelSelectionLocked: true,
  },
}));
const options = { namespace: "bindings", maxEntries: sessions };
const batches = Array.from(
  { length: Math.ceil(rows.length / MAX_SESSION_ROW_FACTS_KEYS) },
  (_, index) =>
    rows.slice(index * MAX_SESSION_ROW_FACTS_KEYS, (index + 1) * MAX_SESSION_ROW_FACTS_KEYS),
);
const resetCounts = () => {
  for (const key of Object.keys(work) as Array<keyof typeof work>) {
    work[key] = 0;
  }
};
function ownerBytes(node: HeapProfiler.SamplingHeapProfileNode, parentIsOwner = false): number {
  const { url } = node.callFrame;
  const owner =
    url.endsWith("/plugin-state-publication.ts") ||
    (parentIsOwner && (!url || url.startsWith("node:")));
  return node.children.reduce(
    (total, child) => total + ownerBytes(child, owner),
    owner ? node.selfSize : 0,
  );
}

await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
  seedPluginStateEntriesForTests(
    rows.map(({ key }) => ({
      pluginId,
      namespace: options.namespace,
      key,
      value: "fixture-model",
    })),
  );
  const store = createPluginStateKeyedStoreV2<string>(pluginId, options, { assertCurrent() {} });
  setActivePluginRegistry(
    harnessRegistry(pluginId, {
      async resolveSessionRuntimeOwnershipAsync({ sessionKey }) {
        const model = await store.lookup(sessionKey!);
        return model
          ? { model: "native", auth: "native", modelRef: { provider: "fixture", model } }
          : undefined;
      },
    }),
  );

  if (values.counts) {
    const { createSessionRowProjection } =
      await import("../../src/gateway/session-row-projection.js");
    const { retainSessionListForegroundWork } =
      await import("../../src/gateway/session-projection-work.js");
    const { runOpenClawAgentWriteTransaction } =
      await import("../../src/state/openclaw-agent-db.js");
    const { writeSessionEntry } =
      await import("../../src/config/sessions/session-accessor.sqlite-entry-write.js");
    runOpenClawAgentWriteTransaction(
      (database) => {
        for (const { key, entry } of rows) {
          writeSessionEntry(database, key, entry);
        }
      },
      { agentId: "main" },
    );
    const release = retainSessionListForegroundWork();
    resetCounts();
    const projection = await createSessionRowProjection({ cfg, getModelCatalog: async () => [] });
    try {
      await projection.ensureMaterialized();
      console.log(JSON.stringify({ phase: "cold-projection", sessions, ...work }));
      resetCounts();
      for (const { key } of rows) {
        assert.equal(projection.snapshot({ agentId: "main", key }).row?.model, "fixture-model");
      }
      console.log(JSON.stringify({ phase: "retained-projection", sessions, ...work }));
      const { replaceSessionEntry } = await import("../../src/config/sessions/session-accessor.js");
      const key = "agent:main:dashboard:incognito-capture-fixture";
      await replaceSessionEntry(
        { agentId: "main", sessionKey: key },
        { sessionId: "fixture-private", updatedAt: 1, incognito: true },
      );
      resetCounts();
      const query = { agentId: "main", key };
      await projection.withPreparedExactRows(
        () => [query],
        (read) => assert.equal(read.describe(query)?.entry?.sessionId, "fixture-private"),
      );
      console.log(JSON.stringify({ phase: "incognito-projection", sessions: 1, ...work }));
    } finally {
      projection.dispose();
      release();
    }
  }

  async function run(overlap: boolean, rounds: number) {
    const batchUs: number[] = [];
    let stale = 0;
    for (let round = 0; round < rounds; round++) {
      for (const batch of batches) {
        const start = performance.now();
        const captures = [];
        for (const { key, entry } of batch) {
          captures.push(
            await capturePluginStateReadDependencies(() =>
              readSessionRuntimeOwnershipAsync({
                config: cfg,
                agentId: "main",
                sessionKey: key,
                sessionEntry: entry,
                readPreparedPreviousSessionId: () => undefined,
              }),
            ),
          );
        }
        if (overlap) {
          await store.register(batch[0]!.key, "fixture-model");
        }
        for (const capture of captures) {
          assert.equal(capture.value?.modelRef?.model, "fixture-model");
          assert.equal(capture.dependencies.length, 1);
          const current = capture.isCurrent();
          if (values.counts) {
            recordCheck(current);
          }
          stale += Number(!current);
          capture.release();
        }
        batchUs.push(((performance.now() - start) * 1000) / batch.length);
      }
    }
    return { batchUs, stale };
  }

  if (values.counts) {
    resetCounts();
    const { stale } = await run(true, 1);
    assert.equal(stale, batches.length);
    console.log(JSON.stringify({ phase: "overlapping-commits", sessions, ...work }));
    return;
  }
  await run(false, 1);
  global.gc?.();
  const inspector = new Session();
  if (values.allocation) {
    await startCollectedHeapSampling(inspector, 8192);
  }
  const rounds = 2;
  const start = performance.now();
  const cpuStart = process.threadCpuUsage();
  const { batchUs, stale } = await run(false, rounds);
  const used = process.threadCpuUsage(cpuStart);
  const elapsed = performance.now() - start;
  assert.equal(stale, 0);
  const heap = values.allocation
    ? (await inspector.post("HeapProfiler.stopSampling")).profile.head
    : undefined;
  inspector.disconnect();
  const reads = sessions * rounds;
  batchUs.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      reads,
      stale,
      hostLoad: loadavg(),
      sourceHashes: Object.fromEntries(
        [...paths].map(([url, file]) => [
          path.basename(url),
          createHash("sha256").update(readFileSync(file)).digest("hex"),
        ]),
      ),
      cpuUsPerRead: (used.user + used.system) / reads,
      wallUsPerRead: (elapsed * 1000) / reads,
      p95BatchWallUsPerRead: batchUs[Math.ceil(batchUs.length * 0.95) - 1],
      sampledBytesPerRead: heap && sumSampledHeapBytes(heap) / reads,
      sampledCaptureBytesPerRead: heap && ownerBytes(heap) / reads,
    }),
  );
});
