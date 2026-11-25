// Synthetic owner workload: 44 registry instances, one real Slack SDK monitor
// waiting to retry apps.connections.open. No credentials, network, sessions, or DB.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/slack-shutdown-retirement-measure.ts
// Add --allocations for a separate sampled-allocation pass; compare timing without it.
// Run serial interleaved baseline/candidate samples and A/A controls. The 5 s
// cutoff reports retained resources; it never releases their outstanding custody.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { createRequire } from "node:module";
import { loadavg } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  createSlackBoltApp,
  gracefulStopSlackApp,
  resolveSlackBoltInterop,
  startSlackSocketAndWaitForDisconnect,
} from "../../extensions/slack/src/monitor/provider-support.js";
import { runChannelAccountMonitor } from "../../src/gateway/server-channel-startup.js";
import { createPluginRecord } from "../../src/plugins/loader-records.js";
import {
  createPluginCache,
  retainPluginCacheInstance,
  retirePluginCache,
} from "../../src/plugins/plugin-cache.js";
import { PluginInstance } from "../../src/plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";
import { settlesWithin } from "../../src/shared/settle-within.js";

const { values } = parseArgs({ options: { allocations: { type: "boolean", default: false } } });
assert(global.gc, "Run with --expose-gc");
const registry = createEmptyPluginRegistry();
const cache = createPluginCache();
const instances = Array.from({ length: 44 }, (_, index) => {
  const record = createPluginRecord({
    id: index === 0 ? "slack" : `synthetic-${index}`,
    source: "synthetic-fixture",
    origin: "config",
    enabled: true,
    configSchema: false,
  });
  registry.plugins.push(record);
  const instance = new PluginInstance(record.id, { registry, record });
  retainPluginCacheInstance(instance, cache);
  return instance;
});
const slack = instances[0]!;
const requireFromSlack = createRequire(
  new URL("../../extensions/slack/package.json", import.meta.url),
);
let requests = 0;
const { app, socketClient } = createSlackBoltApp({
  interop: resolveSlackBoltInterop(requireFromSlack("@slack/bolt")),
  slackMode: "socket",
  token: "synthetic-fixture",
  appToken: "synthetic-fixture",
  slackWebhookPath: "/synthetic-events",
  clientOptions: {
    retryConfig: { retries: 0 },
    fetch: async () => {
      requests++;
      return Response.json({ ok: false, error: "internal_error" });
    },
  },
});
assert(socketClient);
const abort = new AbortController();
let monitorSettled = false;
const monitor = runChannelAccountMonitor(registry, "slack", () =>
  startSlackSocketAndWaitForDisconnect({ app, socketClient, abortSignal: abort.signal }),
).then(
  () => {
    monitorSettled = true;
  },
  () => {
    monitorSettled = true;
  },
);
const readyDeadline = performance.now() + 5_000;
while (!Reflect.get(socketClient, "reconnectionTimer")) {
  assert(!monitorSettled, "Monitor ended before admitting the native retry");
  assert(performance.now() < readyDeadline, "Native retry was not scheduled");
  await nextTurn();
}
assert.equal(requests, 1);
assert.equal(slack.retentionSnapshot().total, 1);
global.gc();
await nextTurn();
const inspector = new Session();
try {
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoad = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  abort.abort();
  await gracefulStopSlackApp(app, socketClient);
  const stopMs = performance.now() - started;
  const retiring = retirePluginCache(cache);
  void retiring.catch(() => {});
  const retiredWithinGrace = await settlesWithin(retiring, 5_000);
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  const memoryAfter = process.memoryUsage();
  const profile = values.allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  const retention = slack.retentionSnapshot();
  console.log(
    JSON.stringify({
      mode: values.allocations ? "allocation" : "timing",
      workload:
        "44 synthetic instances; one real SDK retrying Slack monitor; no DB or workspace I/O",
      plugins: instances.length,
      requests,
      node: process.version,
      hostLoad,
      stopMs,
      retirementMs: elapsedMs - stopMs,
      elapsedMs,
      retiredWithinGrace,
      monitorSettled,
      retainedReferences: retention.total,
      retainedConsumers: retention.references.filter(
        ({ kind }) => kind === "custody" || kind === "consumer",
      ).length,
      cacheInstances: cache.instances.size,
      cpuMs: (cpu.user + cpu.system) / 1000,
      allocatedBytes: profile?.samples.reduce((sum, sample) => sum + sample.size, 0),
      heapDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
      rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
    }),
  );
  if (retiredWithinGrace) {
    await monitor;
    assert.equal(retention.total, 0);
    assert.equal(cache.instances.size, 0);
  }
} finally {
  inspector.disconnect();
}
