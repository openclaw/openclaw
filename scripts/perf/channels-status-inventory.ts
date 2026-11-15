/**
 * Owner-only inventory benchmark, not whole-Gateway latency evidence.
 * Run unchanged on base/candidate, alternating revisions and retaining each JSON:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/channels-status-inventory.ts \
 *   --scenario blocked --mode timing --iterations 3000
 * Repeat with --scenario registered and with --mode allocation (traced separately).
 * Forty synthetic bundled channels, two saved-auth checkers doing tiny real file
 * reads, prepared metadata, and registered channel stubs. The fixture-only trust
 * switch admits its generated bundled root; no installed plugin or real auth runs.
 * Acceptance: identical inventory, zero unnecessary auth reads, lower CPU/allocation
 * per read; timing tails are context on shared hosts. Eligible discovery is tested
 * separately by read-only.test.ts. Fixture files are removed when the process exits.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    scenario: { type: "string", default: "blocked" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "3000" },
  },
});
assert(values.scenario === "blocked" || values.scenario === "registered");
assert(values.mode === "timing" || values.mode === "allocation");
assert(global.gc, "Run with --expose-gc");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 3000,
});
const parent = path.resolve(".local/channels-status-inventory");
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(path.join(parent, "micro-"));
const bundled = path.join(root, "plugins");
const counts = { reads: 0 };
const counterKey = "openclaw.benchmark.channel-auth-reads";
Object.defineProperty(globalThis, Symbol.for(counterKey), { value: counts, configurable: true });
Object.assign(process.env, {
  OPENCLAW_HOME: root,
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_BUNDLED_PLUGINS_DIR: bundled,
  OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
  VITEST: "1",
});
const inspector = new Session();
try {
  const ids = Array.from({ length: 40 }, (_, index) => `fixture-${String(index).padStart(2, "0")}`);
  const plugins = ids.map((id, index) => {
    const rootDir = path.join(bundled, id);
    mkdirSync(rootDir, { recursive: true });
    const channel = {
      id,
      ...(index < 2
        ? {
            persistedAuthState: {
              specifier: "./auth.cjs",
              exportName: "hasAuth",
              exportNameAsync: "hasAuth",
            },
          }
        : {}),
    };
    writeFileSync(
      path.join(rootDir, "package.json"),
      JSON.stringify({
        name: `@openclaw/${id}`,
        version: "1.0.0",
        type: "commonjs",
        openclaw: { extensions: ["./index.cjs"], channel },
      }),
    );
    writeFileSync(
      path.join(rootDir, "openclaw.plugin.json"),
      JSON.stringify({
        id,
        channels: [id],
        configSchema: { type: "object", additionalProperties: false },
      }),
    );
    writeFileSync(path.join(rootDir, "index.cjs"), "module.exports = {};\n");
    if (index < 2) {
      const auth = path.join(rootDir, "synthetic-auth");
      writeFileSync(auth, "synthetic-presence");
      writeFileSync(
        path.join(rootDir, "auth.cjs"),
        `exports.hasAuth = async () => {
        globalThis[Symbol.for(${JSON.stringify(counterKey)})].reads++;
        return require("node:fs").readFileSync(${JSON.stringify(auth)}, "utf8").length > 0;
      };`,
      );
    }
    return {
      id,
      channels: [id],
      rootDir,
      source: path.join(rootDir, "index.cjs"),
      packageChannel: channel,
      enabledByDefault: true,
    };
  });
  const [
    { createPluginMetadataSnapshotFixture },
    { createEmptyPluginRegistry },
    { setActivePluginRegistry },
    { listReadOnlyChannelPluginsForConfigAsync },
  ] = await Promise.all([
    import("../../src/plugins/plugin-metadata.test-support.js"),
    import("../../src/plugins/registry-empty.js"),
    import("../../src/plugins/runtime.js"),
    import("../../src/channels/plugins/read-only.js"),
  ]);
  const loaded = values.scenario === "registered" ? ids : ids.slice(2);
  const registry = createEmptyPluginRegistry();
  registry.channels = loaded.map((id) => ({
    pluginId: id,
    source: path.join(bundled, id, "index.cjs"),
    plugin: {
      id,
      meta: {
        id,
        label: id,
        selectionLabel: id,
        docsPath: `/channels/${id}`,
        blurb: "Synthetic fixture",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ accountId: "default" }),
      },
    },
  }));
  setActivePluginRegistry(registry);
  const cfg: OpenClawConfig = {
    plugins: { allow: loaded },
    channels: Object.fromEntries(loaded.map((id) => [id, { enabled: true }])),
  };
  const options = { metadataSnapshot: createPluginMetadataSnapshotFixture({ plugins }) };
  const read = () => listReadOnlyChannelPluginsForConfigAsync(cfg, options);
  const coldStart = performance.now();
  assert.deepEqual((await read()).map((plugin) => plugin.id).toSorted(), loaded);
  const coldMs = performance.now() - coldStart;
  for (let index = 0; index < 100; index++) {
    await read();
  }
  counts.reads = 0;
  global.gc();
  await nextTurn();
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoad = loadavg();
  const cpuStart = process.threadCpuUsage();
  const start = performance.now();
  let checksum = 0;
  for (let index = 0; index < iterations; index++) {
    checksum += (await read()).length;
  }
  const wallMs = performance.now() - start;
  const cpu = process.threadCpuUsage(cpuStart);
  const allocation =
    values.mode === "allocation" ? await inspector.post("HeapProfiler.stopSampling") : undefined;
  const authReads = counts.reads;
  assert.equal(checksum, loaded.length * iterations);
  assert.deepEqual((await read()).map((plugin) => plugin.id).toSorted(), loaded);
  const sampledBytes = allocation?.profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  console.log(
    JSON.stringify({
      scenario: values.scenario,
      mode: values.mode,
      iterations,
      plugins: ids.length,
      checksum,
      inventoryHash: createHash("sha256").update(JSON.stringify(loaded)).digest("hex"),
      authReads,
      coldMs,
      hostLoad: { before: hostLoad, after: loadavg() },
      ...(values.mode === "timing"
        ? { wallMs, cpuUsPerRead: (cpu.user + cpu.system) / iterations }
        : { sampledBytes, sampledBytesPerRead: sampledBytes! / iterations }),
      memory: process.memoryUsage(),
    }),
  );
} finally {
  inspector.disconnect();
  rmSync(root, { recursive: true, force: true });
  Reflect.deleteProperty(globalThis, Symbol.for(counterKey));
}
