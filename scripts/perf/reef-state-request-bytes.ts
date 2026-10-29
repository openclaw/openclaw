/**
 * Reef reconciliation through its real owner, SDK, and SQLite worker.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/reef-state-request-bytes.ts
 *   --iterations 2000 [--allocations] [--owner .local/trust-store-base.ts]
 * Save trust-store.ts before editing and alternate base/candidate processes.
 * Eight peer snapshots plus rejection/overdue scans model one 30-second cycle.
 * Rates below are simulated, not production observations. The 44-plugin fixture
 * has one active Reef owner and 43 inert namespaces, including dedicated-store
 * plugins whose actual databases are deliberately not attributed to plugin_state.
 * Test-only seeding, census, warmup, verification, and cleanup are outside timing.
 * Worker census reports actual request bytes by declared namespace combination
 * and standalone serialized snapshot bytes per namespace (not additive wire sizes).
 * Allocation sampling is a separate main-isolate pass. Accept identical results
 * and persisted rows, fewer request bytes, and reduced main-thread CPU/allocation.
 * This is an owner benchmark, not a whole-Gateway latency measurement.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { deserialize, serialize } from "node:v8";
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
assert(Number.isSafeInteger(iterations) && iterations > 0 && iterations % 10 === 0);
const gc = global.gc;
assert(gc, "Run with --expose-gc");
const ownerUrl = new URL("../../extensions/reef/src/trust-store.ts", import.meta.url).href;
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
const { ReefTrustStore, resolveReefTrustStoreKey } =
  await import("../../extensions/reef/src/trust-store.js");
const { REEF_TRUST_STORE_OPTIONS, REEF_DELIVERY_STORE_OPTIONS } =
  await import("../../extensions/reef/src/trust-store-format.js");
const { ReefChannelConfigSchema } = await import("../../extensions/reef/src/config-schema.js");
const { createPluginStateKeyedStoreV2 } =
  await import("../../src/plugin-sdk/plugin-state-store-runtime.js");
const { withOpenClawTestState } = await import("../../src/test-utils/openclaw-test-state.js");
const { seedPluginStateEntriesForTests } =
  await import("../../src/plugin-state/plugin-state-store.test-helpers.js");
assert(!values.owner || replaced, "Baseline owner was not loaded");

type Census = { requests: number; bytes: number };
const inspector = new Session();
fs.mkdirSync(".local", { recursive: true });
const scratch = fs.mkdtempSync(path.resolve(".local/reef-state-bytes-"));
const previousTmpdir = process.env.TMPDIR;
process.env.TMPDIR = scratch;
try {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const now = Date.now();
    const config = ReefChannelConfigSchema.parse({
      handle: "synthetic-owner",
      relayUrl: "https://relay.example.invalid",
    });
    const modulePath = fileURLToPath(
      new URL("../../extensions/reef/trust-state-operation-api.ts", import.meta.url),
    );
    const moduleSource = {
      resolve: () => ({
        modulePath,
        boundaryRoot: path.dirname(modulePath),
        origin: "bundled" as const,
        pluginId: "reef",
      }),
    };
    const peers = createPluginStateKeyedStoreV2<
      import("../../extensions/reef/src/trust-store-format.js").ReefPeerStateSnapshot
    >("reef", { ...REEF_TRUST_STORE_OPTIONS, env }, { assertCurrent() {} }, moduleSource);
    const deliveries = createPluginStateKeyedStoreV2<
      import("../../extensions/reef/src/trust-store-format.js").ReefOutboundDelivery
    >("reef", { ...REEF_DELIVERY_STORE_OPTIONS, env }, { assertCurrent() {} }, moduleSource);
    const trust = new ReefTrustStore({ peers, deliveries }, config);
    const peerNames = Array.from({ length: 8 }, (_, index) => `peer-${index}`);
    const recipient = {
      ed25519PublicKey: Buffer.alloc(32, 1).toString("base64url"),
      x25519PublicKey: Buffer.alloc(32, 2).toString("base64url"),
      keyEpoch: 1,
    };
    const peerState = {
      revision: 1,
      trust: {
        ...recipient,
        autonomy: "bounded" as const,
        safetyNumberChanged: false,
        approvedAt: now,
      },
    };
    const inertPlugins = [
      "workboard",
      "team-reports",
      "knowledge",
      "slack",
      "discord",
      "telegram",
      "matrix",
      ...Array.from({ length: 36 }, (_, index) => `synthetic-inert-${index}`),
    ];
    const deliveryRows = Array.from({ length: 1600 }, (_, index) => ({
      pluginId: "reef",
      namespace: REEF_DELIVERY_STORE_OPTIONS.namespace,
      key: `${resolveReefTrustStoreKey(config, peerNames[index % peerNames.length]!)}:${String(index).padStart(26, "0")}`,
      value: { bodyHash: "0".repeat(64), recipient, sentAt: now },
      createdAt: now,
      expiresAt: now + REEF_DELIVERY_STORE_OPTIONS.defaultTtlMs,
    }));
    seedPluginStateEntriesForTests([
      ...peerNames.map((peer) => ({
        pluginId: "reef",
        namespace: REEF_TRUST_STORE_OPTIONS.namespace,
        key: resolveReefTrustStoreKey(config, peer),
        value: peerState,
        createdAt: now,
      })),
      ...deliveryRows,
      ...inertPlugins.map((pluginId) => ({
        pluginId,
        namespace: "synthetic-inert",
        key: "fixture",
        value: { synthetic: true },
        createdAt: now,
      })),
    ]);
    const original = await Promise.all([peers.entries(), deliveries.entries()]);
    const run = async (rounds: number) => {
      for (let round = 0; round < rounds; round++) {
        for (const peer of peerNames) {
          const snapshot = await trust.snapshot(peer);
          assert.equal(snapshot.revision, 1);
          assert.equal(snapshot.trust?.ed25519PublicKey, recipient.ed25519PublicKey);
        }
        assert.equal((await trust.pendingOutboundRejections()).length, 0);
        assert.equal((await trust.overdueOutboundDeliveries(86_400_000, now)).length, 0);
      }
    };
    await run(2);
    const requestCensus = new Map<string, Census>();
    const snapshotCensus = new Map<string, Census>();
    const add = (census: Map<string, Census>, key: string, bytes: number) => {
      const row = census.get(key) ?? { requests: 0, bytes: 0 };
      row.requests++;
      row.bytes += bytes;
      census.set(key, row);
    };
    const descriptor = Object.getOwnPropertyDescriptor(Worker.prototype, "postMessage");
    assert(descriptor, "Worker.prototype.postMessage descriptor");
    const count = function (this: Worker, ...args: Parameters<Worker["postMessage"]>) {
      const request = asOptionalRecord(args[0]);
      if (request?.type === "execute" && request.input instanceof Uint8Array) {
        const command = asOptionalRecord(deserialize(request.input));
        if (command?.type === "pluginState.executeOperation") {
          const input = asOptionalRecord(command.input);
          assert(Array.isArray(input?.stores));
          const scopes = input.stores.map((scope: unknown) => {
            const store = asOptionalRecord(scope);
            assert(typeof store?.pluginId === "string" && typeof store.namespace === "string");
            return `${store.pluginId}/${store.namespace}`;
          });
          add(requestCensus, scopes.join(" + "), request.input.byteLength);
          const snapshots = asOptionalRecord(input.namespaceSnapshots);
          for (const [namespace, rows] of Object.entries(snapshots ?? {})) {
            add(snapshotCensus, namespace, serialize(rows).byteLength);
          }
        }
      }
      return Reflect.apply(descriptor.value, this, args);
    };
    Object.defineProperty(Worker.prototype, "postMessage", { ...descriptor, value: count });
    try {
      await run(2);
    } finally {
      Object.defineProperty(Worker.prototype, "postMessage", descriptor);
    }
    await run(5);
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
    await run(iterations / 10);
    const wallMs = performance.now() - start;
    const used = process.threadCpuUsage(cpu);
    const memoryAfter = process.memoryUsage();
    const sampledBytes = values.allocations
      ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
          (sum, sample) => sum + sample.size,
          0,
        )
      : undefined;
    assert.deepEqual(await Promise.all([peers.entries(), deliveries.entries()]), original);
    const perMinute = (census: Map<string, Census>) =>
      [...census].map(([namespaces, { requests, bytes }]) => ({
        namespaces,
        requestsPerSimulatedMinute: requests,
        bytesPerSimulatedMinute: bytes,
        megabytesPerSimulatedMinute: bytes / 1_000_000,
      }));
    console.log(
      JSON.stringify({
        mode: values.allocations ? "allocation" : "timing",
        owner: values.owner ?? "candidate",
        iterations,
        rounds: iterations / 10,
        plugins: inertPlugins.length + 1,
        peerRows: peerNames.length,
        deliveryRows: deliveryRows.length,
        changedPersistedRows: 0,
        requestCensus: perMinute(requestCensus),
        standaloneSnapshotCensus: perMinute(snapshotCensus),
        inertNamespaces: inertPlugins.map((plugin) => ({
          plugin,
          namespace: "synthetic-inert",
          requestsPerSimulatedMinute: 0,
          bytesPerSimulatedMinute: 0,
        })),
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
