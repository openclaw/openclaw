/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/clickclack-credential-read.ts --baseline-checkout=/exact/base
 * Real ClickClack text sends to a synthetic loopback server; no external service or credentials.
 * Two A/A controls and five interleaved A/B pairs, with separate --allocations sampling.
 * For compiled credential-owner cost, pass --baseline-module and --candidate-module pointing
 * to production SDK secret-file.js artifacts from pnpm build.
 * Add --baseline-sync to measure the synchronous reader formerly used by ClickClack.
 * Acceptance: zero warm main-thread filesystem calls; preserve each next-operation file read.
 * Worker relocation can increase total CPU/cold latency; report those costs explicitly.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";

assert(global.gc, "Run with --expose-gc");
const option = (name: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const baseline = option("baseline-checkout");
const baselineModule = option("baseline-module");
const candidateModule = option("candidate-module");
const allocations = process.argv.includes("--allocations");
assert(
  baseline || (baselineModule && candidateModule),
  "Provide a baseline checkout or both compiled modules",
);
const parent = path.resolve(".local/clickclack-credential-read");
await fs.promises.mkdir(parent, { recursive: true });
const root = await fs.promises.mkdtemp(path.join(parent, "synthetic-"));
const tokenFile = path.join(root, "credential");
await fs.promises.writeFile(tokenFile, "synthetic-placeholder", { mode: 0o600 });
let requests = 0;
const server = createServer((req, res) => {
  assert.equal(req.method, "POST");
  assert.equal(req.url, "/api/channels/chn_synthetic/messages");
  assert.equal(req.headers.authorization, "Bearer synthetic-placeholder");
  req.resume();
  requests++;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ message: { id: "msg_synthetic" } }));
});
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert(address && typeof address !== "string");
const cfg = {
  channels: {
    clickclack: {
      baseUrl: `http://127.0.0.1:${address.port}`,
      tokenFile,
      workspace: "wsp_synthetic",
    },
  },
};
const readOwner = async (entry: string, sync = false) => {
  const owner: typeof import("../../src/infra/secret-file.js") = await import(
    pathToFileURL(entry).href
  );
  return async () =>
    assert.equal(
      await (sync
        ? owner.readSecretFileSync(tokenFile, "Synthetic credential")
        : owner.readSecretFile(tokenFile, "Synthetic credential")),
      "synthetic-placeholder",
    );
};
const sendOwner = async (checkout: string) => {
  const owner: typeof import("../../extensions/clickclack/src/outbound.js") = await import(
    pathToFileURL(path.join(checkout, "extensions/clickclack/src/outbound.ts")).href
  );
  return async () =>
    assert.deepEqual(
      await owner.sendClickClackText({ cfg, to: "channel:chn_synthetic", text: "Synthetic proof" }),
      { messageId: "msg_synthetic" },
    );
};
const flows =
  baselineModule && candidateModule
    ? [
        await readOwner(baselineModule, process.argv.includes("--baseline-sync")),
        await readOwner(candidateModule),
      ]
    : [await sendOwner(path.resolve(baseline!)), await sendOwner(process.cwd())];
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const inspector = new Session();
const restore: Array<() => void> = [];
const counts: Record<string, number> = {};
const count = (object: object, key: string, label = key) => {
  const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
  Object.defineProperty(object, key, {
    ...descriptor,
    value: new Proxy(descriptor.value, {
      apply(fn, receiver, args) {
        counts[label] = (counts[label] ?? 0) + 1;
        return Reflect.apply(fn, receiver, args);
      },
    }),
  });
  restore.push(() => Object.defineProperty(object, key, descriptor));
};
try {
  for (const [index, flow] of flows.entries()) {
    const rss = process.memoryUsage.rss();
    const start = performance.now();
    await flow();
    console.log(
      JSON.stringify({
        phase: "cold",
        baseline: index === 0,
        wallMs: performance.now() - start,
        rssDeltaBytes: process.memoryUsage.rss() - rss,
      }),
    );
    for (let i = 0; i < 1000; i++) {
      await flow();
    }
  }
  for (const key of Object.keys(fs).filter((name) => name.endsWith("Sync"))) {
    count(fs, key);
  }
  count(fs.realpathSync, "native", "realpathSync.native");
  for (const [index, flow] of flows.entries()) {
    for (const key of Object.keys(counts)) {
      delete counts[key];
    }
    for (let i = 0; i < 18; i++) {
      await flow();
    }
    console.log(
      JSON.stringify({
        phase: "counts",
        baseline: index === 0,
        operations: 18,
        counts: { ...counts },
      }),
    );
  }
  for (const undo of restore.splice(0).toReversed()) {
    undo();
  }
  if (allocations) {
    inspector.connect();
  }
  const iterations = 200;
  const samples = process.argv.includes("--cold-only")
    ? []
    : [true, true, ...Array.from({ length: 5 }, () => [true, false]).flat()];
  for (const [index, isBaseline] of samples.entries()) {
    global.gc();
    await nextTurn();
    if (allocations) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const cpuStart = process.cpuUsage();
    const threadStart = process.threadCpuUsage();
    const latencyUs: number[] = [];
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const operationStart = performance.now();
      await flows[isBaseline ? 0 : 1]!();
      if (!allocations) {
        latencyUs.push((performance.now() - operationStart) * 1000);
      }
    }
    const wallMs = performance.now() - start;
    const thread = process.threadCpuUsage(threadStart);
    const cpu = process.cpuUsage(cpuStart);
    const sample = allocations ? await inspector.post("HeapProfiler.stopSampling") : undefined;
    console.log(
      JSON.stringify({
        phase: index < 2 ? "AA" : "AB",
        baseline: isBaseline,
        iterations,
        ...(sample
          ? {
              mainThreadSampledBytesPerOperation:
                sample.profile.samples.reduce((sum, entry) => sum + entry.size, 0) / iterations,
            }
          : {
              wallUsPerOperation: (wallMs * 1000) / iterations,
              p95WallUs: latencyUs.toSorted((a, b) => a - b)[Math.ceil(iterations * 0.95) - 1],
              mainThreadCpuUsPerOperation: (thread.user + thread.system) / iterations,
              totalCpuUsPerOperation: (cpu.user + cpu.system) / iterations,
            }),
        hostLoad: loadavg(),
      }),
    );
  }
  const { getTrackedWorkerLifecycleSnapshot } = await import("../../src/infra/worker-cpu.js");
  const workers = getTrackedWorkerLifecycleSnapshot();
  console.log(
    JSON.stringify({
      requests,
      workerCount: workers.workerCount,
      workerLifecycle: workers.workerLifecycle,
    }),
  );
} finally {
  for (const undo of restore.toReversed()) {
    undo();
  }
  inspector.disconnect();
  await drainGlobalSingletonLifecycleState();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await fs.promises.rm(root, { recursive: true, force: true });
}
