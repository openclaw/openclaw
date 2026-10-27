/**
 * Warm duplicate keyed-store claims through the SDK and real SQLite worker.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-state-claims-measure.ts
 *   --iterations 2000 [--allocations] [--owner .local/plugin-state-worker-client-base.ts]
 * Save the baseline owner before editing; alternate base/candidate processes.
 * The 44 namespaces hold 128 rows each: seven caller-shaped claim stores and 37
 * inert stores. Test-only transaction seeding is outside the measured SDK path.
 * Census models ten duplicate claims per active namespace per simulated minute;
 * these are configured rates, not production observations. Worker-message counting
 * ends before timing. Allocation sampling is a separate main-isolate pass.
 * Setup, verification, forced GC, and cleanup are excluded. Accept identical false
 * results and unchanged stored metadata with fewer writer requests and lower CPU
 * or allocation. This measures the store boundary, not whole-Gateway latency.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    iterations: { type: "string", default: "2000" },
    allocations: { type: "boolean" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const gc = global.gc;
assert(gc, "Run with --expose-gc");
const ownerUrl = new URL("../../src/plugin-state/plugin-state-worker-client.ts", import.meta.url)
  .href;
let replaced = false;
if (values.owner) {
  const replacement = pathToFileURL(path.resolve(values.owner)).href;
  registerHooks({
    load(url, context, nextLoad) {
      if (url !== ownerUrl) {
        return nextLoad(url, context);
      }
      replaced = true;
      const result = nextLoad(replacement, context);
      return { format: result.format, source: result.source, shortCircuit: true };
    },
  });
}
const { createPluginStateKeyedStoreV2 } =
  await import("../../src/plugin-sdk/plugin-state-store-runtime.js");
const { withOpenClawTestState } = await import("../../src/test-utils/openclaw-test-state.js");
const { seedPluginStateEntriesForTests } =
  await import("../../src/plugin-state/plugin-state-store.test-helpers.js");
assert(!values.owner || replaced, "Baseline owner was not loaded");

const hour = 60 * 60 * 1000;
const shapes = [
  { plugin: "x", namespace: "x.work-origin", value: { accountId: "synthetic", postId: "1" } },
  {
    plugin: "codex",
    namespace: "app-server-managed-threads",
    value: { version: 1, kind: "managed-thread", sourceHomeId: "synthetic", threadId: "1" },
  },
  { plugin: "slack", namespace: "presence-greeting-cooldowns", value: 1, ttlMs: 8 * hour },
  { plugin: "discord", namespace: "presence-greeting-cooldowns", value: 1, ttlMs: 8 * hour },
  {
    plugin: "imap",
    namespace: "dispatch-claim",
    value: { accountId: "synthetic", uid: 1, recordedAt: 1 },
    ttlMs: 7 * 24 * hour,
  },
  { plugin: "reef", namespace: "delivered", value: { id: "synthetic" }, ttlMs: 31 * 24 * hour },
  {
    plugin: "google-meet",
    namespace: "meeting-participation",
    value: { kind: "meeting-participation-attempt", sessionId: "synthetic", requestId: "1" },
  },
];
const inspector = new Session();
fs.mkdirSync(".local", { recursive: true });
const scratch = fs.mkdtempSync(path.resolve(".local/plugin-state-claims-"));
const previousTmpdir = process.env.TMPDIR;
process.env.TMPDIR = scratch;
try {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const fixtures = [
      ...shapes,
      ...Array.from({ length: 37 }, (_, index) => ({
        plugin: `synthetic-inert-${index}`,
        namespace: "claims",
        value: { id: "synthetic" },
        ttlMs: undefined,
      })),
    ].map(({ plugin, namespace, value, ttlMs }) => ({
      plugin,
      namespace,
      value,
      ttlMs,
      store: createPluginStateKeyedStoreV2<unknown>(
        plugin,
        { namespace, maxEntries: 1_000, env },
        { assertCurrent() {} },
      ),
    }));
    const rowsPerNamespace = 128;
    const now = Date.now();
    seedPluginStateEntriesForTests(
      fixtures.flatMap(({ plugin, namespace, value, ttlMs }) =>
        Array.from({ length: rowsPerNamespace }, (_, index) => ({
          pluginId: plugin,
          namespace,
          key: index === 0 ? "owned" : `sibling-${index}`,
          value,
          createdAt: now,
          ...(ttlMs ? { expiresAt: now + ttlMs } : {}),
        })),
      ),
    );
    for (const fixture of fixtures) {
      await fixture.store.entries();
    }
    const active = fixtures.slice(0, shapes.length);
    const original = await Promise.all(active.map(({ store }) => store.entries()));
    const run = async (count: number) => {
      for (let index = 0; index < count; index++) {
        const fixture = active[index % active.length]!;
        const claimed = await fixture.store.registerIfAbsent("owned", fixture.value, {
          ttlMs: fixture.ttlMs,
        });
        if (claimed) {
          throw new Error("Duplicate claim unexpectedly replaced its live row");
        }
      }
    };
    const census = active.map(({ plugin, namespace }) => ({
      plugin,
      namespace,
      simulatedClaimsPerMinute: 10,
      writerRequestsPerSimulatedMinute: 0,
    }));
    // oxlint-disable-next-line typescript/unbound-method -- Restore the exact method; apply below preserves its receiver.
    const postMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      this: Worker,
      ...args: Parameters<Worker["postMessage"]>
    ) {
      const request = asOptionalRecord(args[0]);
      if (request?.type === "execute" && request.input instanceof Uint8Array) {
        const command = asOptionalRecord(deserialize(request.input));
        if (command?.type === "pluginState.registerIfAbsent") {
          const input = asOptionalRecord(command.input);
          const row = census.find(
            (entry) => entry.plugin === input?.pluginId && entry.namespace === input?.namespace,
          );
          assert(row, "Unexpected claim namespace in census");
          row.writerRequestsPerSimulatedMinute++;
        }
      }
      return postMessage.apply(this, args);
    };
    try {
      await run(active.length * 10);
    } finally {
      Worker.prototype.postMessage = postMessage;
    }
    await run(active.length * 20);
    gc();
    if (values.allocations) {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const hostLoadBefore = loadavg();
    const memoryBefore = process.memoryUsage();
    const cpu = process.threadCpuUsage();
    const start = performance.now();
    await run(iterations);
    const wallMs = performance.now() - start;
    const used = process.threadCpuUsage(cpu);
    const memoryAfter = process.memoryUsage();
    const sampledBytes = values.allocations
      ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
          (sum, sample) => sum + sample.size,
          0,
        )
      : undefined;
    assert.deepEqual(await Promise.all(active.map(({ store }) => store.entries())), original);
    console.log(
      JSON.stringify({
        mode: values.allocations ? "allocation" : "timing",
        owner: values.owner ?? "candidate",
        iterations,
        plugins: fixtures.length,
        activeNamespaces: active.length,
        rowsPerNamespace,
        census,
        mainThreadCpuMs: (used.user + used.system) / 1000,
        wallMs,
        sampledBytes,
        hostLoadBefore,
        hostLoadAfter: loadavg(),
        memoryBefore,
        memoryAfter,
      }),
    );
  });
} finally {
  inspector.disconnect();
  if (previousTmpdir === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = previousTmpdir;
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
