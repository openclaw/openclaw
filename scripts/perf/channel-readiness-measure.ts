/**
 * Channel-readiness owner cost, not a whole-Gateway or database benchmark.
 * --mode runtime-probe --source-root <sealed checkout> --measurement timing|allocation
 * uses real HTTP /readyz, 5 warmups +60 requests; run five rotated A1/B/A2 triplets
 * separately per measurement. Source setup/import and failure probes are excluded.
 * Timing has no inspector/fs spy; allocation is sampled main-isolate V8 traffic.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/channel-readiness-measure.ts
 *   --mode refresh --iterations 100000 [--source-dir /path/to/saved/gateway]
 * Save server/readiness.ts and channel-health-policy.ts under --source-dir for
 * the baseline; other dependencies remain shared. Run five serial alternating
 * baseline/candidate pairs and two same-source A/A controls. --mode cached keeps
 * the existing one-second cache warm. --reconnecting adds one recovering account.
 * Acceptance: no new inventory reads; bound/terminal correctness comes from the
 * transport regression. Report wall/CPU/allocation changes, without a speedup claim.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { Agent, createServer, request } from "node:http";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import type { ChannelAccountSnapshot } from "../../src/channels/plugins/types.public.js";

const { values } = parseArgs({
  options: {
    "source-dir": { type: "string" },
    "source-root": { type: "string" },
    measurement: { type: "string", default: "timing" },
    mode: { type: "string", default: "refresh" },
    iterations: { type: "string", default: "100000" },
    reconnecting: { type: "boolean", default: false },
  },
});
assert(globalThis.gc, "Run with --expose-gc");
if (values.mode === "runtime-probe") {
  await measureRuntimeProbe();
} else {
  assert(!values["source-root"], "--source-root belongs to runtime-probe mode");
  await measureChannels();
}

async function measureChannels() {
  assert(values.mode === "refresh" || values.mode === "cached");
  const iterations = Number(values.iterations);
  assert(Number.isSafeInteger(iterations) && iterations > 0);
  const ownerRoot = new URL("../../src/gateway/", import.meta.url);
  const ownerFiles = ["server/readiness.ts", "channel-health-policy.ts"];
  const sources = new Map(
    ownerFiles.map((file) => [
      new URL(file, ownerRoot).href,
      readFileSync(
        values["source-dir"] ? path.resolve(values["source-dir"], file) : new URL(file, ownerRoot),
        "utf8",
      ),
    ]),
  );
  if (values["source-dir"]) {
    registerHooks({
      load(url, context, nextLoad) {
        const source = sources.get(url);
        return source === undefined
          ? nextLoad(url, context)
          : { format: "module-typescript", source, shortCircuit: true };
      },
    });
  }
  const { createReadinessChecker } = await import("../../src/gateway/server/readiness.js");
  let now = Date.now();
  const startedAt = now - 600_000;
  const channelAccounts = createChannelAccounts(startedAt);
  const recovering = channelAccounts["channel-0"]!["account-0"]!;
  const disconnect = { at: now - 2_000 };
  if (values.reconnecting) {
    recovering.connected = false;
    recovering.lifecycle = "recovering";
    recovering.lastDisconnect = disconnect;
  }
  const snapshot = { channels: {}, channelAccounts };
  let scans = 0;
  const check = createReadinessChecker({
    startedAt,
    channelManager: {
      getRuntimeSnapshot: () => {
        scans++;
        return snapshot;
      },
      getAutostartSuppression: () => null,
      isAmbientAutostartSuppressed: () => false,
    },
  });
  const originalNow = Date.now;
  Date.now = () => now;
  function run(count: number) {
    let ready = 0;
    for (let index = 0; index < count; index++) {
      if (values.mode === "refresh") {
        now += 1_001;
        if (values.reconnecting) {
          // Each refresh observes an independent fresh outage, not a prolonged one.
          disconnect.at = now - 2_000;
        }
      }
      ready += Number(check().ready);
    }
    return ready;
  }
  function allocatedBytes(): number {
    const value: unknown = Reflect.get(getHeapStatistics(), "total_allocated_bytes");
    assert(typeof value === "number", "Node with V8 total_allocated_bytes is required");
    return value;
  }
  try {
    assert.equal(run(10_000), 10_000);
    assert(globalThis.gc);
    globalThis.gc();
    scans = 0;
    const hostLoad = loadavg();
    const allocations = allocatedBytes();
    const cpu = process.cpuUsage();
    const started = performance.now();
    const ready = run(iterations);
    const wallMs = performance.now() - started;
    const used = process.cpuUsage(cpu);
    const allocationBytes = allocatedBytes() - allocations;
    assert.equal(ready, iterations);
    assert.equal(scans, values.mode === "refresh" ? iterations : 0);
    console.log(
      JSON.stringify({
        node: process.version,
        mode: values.mode,
        reconnecting: values.reconnecting,
        iterations,
        channels: 44,
        accounts: 176,
        sources: Object.fromEntries(
          [...sources].map(([url, source]) => [
            url,
            createHash("sha256").update(source).digest("hex"),
          ]),
        ),
        hostLoad,
        snapshotReads: scans,
        ready,
        wallUsPerCheck: (wallMs * 1_000) / iterations,
        cpuUsPerCheck: (used.user + used.system) / iterations,
        allocatedBytesPerCheck: allocationBytes / iterations,
      }),
    );
  } finally {
    Date.now = originalNow;
  }
}

function createChannelAccounts(startedAt: number) {
  const channelAccounts: Record<string, Record<string, ChannelAccountSnapshot>> = {};
  for (let channel = 0; channel < 44; channel++) {
    const accounts: Record<string, ChannelAccountSnapshot> = {};
    for (let account = 0; account < 4; account++) {
      const accountId = `account-${account}`;
      accounts[accountId] = {
        accountId,
        enabled: true,
        configured: true,
        running: true,
        connected: true,
        lifecycle: "ready",
        lastStartAt: startedAt,
        lastConnectedAt: startedAt + 1_000,
      };
    }
    channelAccounts[`channel-${channel}`] = accounts;
  }
  return channelAccounts;
}

/** Real HTTP owner route; no legacy clock, source substitution, or fs counters. */
async function measureRuntimeProbe() {
  assert(values["source-root"], "runtime-probe requires a sealed --source-root");
  assert(!values["source-dir"] && !values.reconnecting);
  assert(values.measurement === "timing" || values.measurement === "allocation");
  assert(process.env.OPENCLAW_STATE_DIR && process.env.HOME, "Use private fixture state");
  const sourceRoot = realpathSync(values["source-root"]);
  const sourceUrl = (file: string) => pathToFileURL(path.join(sourceRoot, file)).href;
  const sourceFiles = [
    "src/gateway/server/readiness.ts",
    "src/gateway/server-http-probes.ts",
    "src/infra/child-runtime-viability.ts",
    "src/gateway/channel-health-policy.ts",
    "package.json",
    "pnpm-lock.yaml",
  ];
  const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const sources = Object.fromEntries(
    sourceFiles.map((file) => [file, hash(path.join(sourceRoot, file))]),
  );
  const executable = realpathSync(process.execPath);
  const runtime = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    executable,
    executableSha256: hash(executable),
  };
  const { createReadinessChecker } = await import(sourceUrl("src/gateway/server/readiness.ts"));
  const { handleGatewayProbeRequest } = await import(
    sourceUrl("src/gateway/server-http-probes.ts")
  );
  const startedAt = Date.now() - 600_000;
  const snapshot = { channels: {}, channelAccounts: createChannelAccounts(startedAt) };
  const check = createReadinessChecker({
    startedAt,
    channelManager: {
      getRuntimeSnapshot: () => snapshot,
      getAutostartSuppression: () => null,
      isAmbientAutostartSuppressed: () => false,
    },
  });
  const server = createServer((req, res) => {
    void handleGatewayProbeRequest(
      req,
      res,
      "/readyz",
      { mode: "none", allowTailscale: false },
      [],
      false,
      undefined,
      check,
    )
      .then((handled: boolean) => assert(handled))
      .catch((error: Error) => res.destroy(error));
  });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const inspector = new Session();
  let inspectorConnected = false;
  let result;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    assert(address && typeof address !== "string");
    const port = address.port;
    const operation = () =>
      new Promise<void>((resolve, reject) => {
        const req = request(
          { hostname: "127.0.0.1", port, path: "/readyz", method: "GET", agent },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
              body += chunk;
            });
            res.once("error", reject);
            res.once("end", () => {
              try {
                assert.equal(res.statusCode, 200);
                const value = JSON.parse(body);
                assert.equal(value.ready, true);
                assert.equal(value.coreReady, true);
                assert.deepEqual(value.failing, []);
                resolve();
              } catch (error) {
                reject(
                  error instanceof Error
                    ? error
                    : new Error("Readiness response validation failed", { cause: error }),
                );
              }
            });
          },
        );
        req.once("error", reject);
        req.end();
      });
    const run = async (count: number) => {
      for (let index = 0; index < count; index++) {
        await operation();
      }
    };
    performance.now();
    await run(5);
    assert(globalThis.gc);
    globalThis.gc();
    const operations = 60;
    const hostLoadBefore = loadavg();
    const timestamp = new Date().toISOString();
    let metrics;
    if (values.measurement === "allocation") {
      inspector.connect();
      inspectorConnected = true;
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 1024,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      await run(operations);
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      metrics = {
        sampledAllocatedBytes: profile.samples.reduce((sum, sample) => sum + sample.size, 0),
      };
    } else {
      const cpu = process.cpuUsage();
      const thread = process.threadCpuUsage();
      const started = performance.now();
      await run(operations);
      const wallMs = performance.now() - started;
      const mainCpu = process.threadCpuUsage(thread);
      const processCpu = process.cpuUsage(cpu);
      metrics = {
        wallMs,
        mainCpuUs: mainCpu.user + mainCpu.system,
        processCpuUs: processCpu.user + processCpu.system,
      };
    }
    result = {
      mode: "runtime-probe",
      measurement: values.measurement,
      operations,
      warmups: 5,
      channels: 44,
      accounts: 176,
      runtime,
      sources,
      timestamp,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
      ...metrics,
    };
  } finally {
    if (inspectorConnected) {
      inspector.disconnect();
    }
    agent.destroy();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
  // A row is emitted only after the native listener and client sockets close.
  console.log(JSON.stringify({ ...result, teardown: "closed" }));
}
