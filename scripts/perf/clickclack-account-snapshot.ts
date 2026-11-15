/**
 * Real Gateway channel-manager snapshots with one synthetic ClickClack account.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/clickclack-account-snapshot.ts
 * Add --allocations for separate sampled-allocation runs. A/A then five A/B pairs.
 * Baseline removes the inspector, selecting the unchanged pre-fix operational
 * resolver. No network or real credentials; no full Gateway/Team-scale claim.
 * Accept: identical configured/enabled facts, zero credential reads in snapshots,
 * and reduced CPU/allocation. Counts/minute normalize to 18 snapshots/minute.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { clickClackPlugin } from "../../extensions/clickclack/api.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { createChannelManager } from "../../src/gateway/server-channels.js";
import { GatewayScheduler } from "../../src/infra/gateway-scheduler.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";

assert(global.gc, "Run with --expose-gc");
const allocations = process.argv.includes("--allocations");
const iterations = 3_000;
const parent = path.resolve(".local/clickclack-account-snapshot");
fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, "synthetic-"));
const tokenFile = path.join(root, "credential");
fs.writeFileSync(tokenFile, "synthetic-placeholder", { mode: 0o600 });
const config: OpenClawConfig = {
  channels: {
    clickclack: {
      baseUrl: "https://clickclack.example.test",
      workspace: "synthetic-workspace",
      tokenFile,
    },
  },
};
const managers = [true, false].map((baseline) => {
  const registry = createEmptyPluginRegistry();
  registry.channels = [
    {
      pluginId: "clickclack",
      source: "synthetic-fixture",
      plugin: baseline
        ? { ...clickClackPlugin, config: { ...clickClackPlugin.config, inspectAccount: undefined } }
        : clickClackPlugin,
    },
  ];
  return createChannelManager({
    scheduler: new GatewayScheduler(),
    getRuntimeConfig: () => config,
    getPluginRegistry: () => registry,
    channelLogs: {},
    channelRuntimeEnvs: {},
  });
});
const inspector = new Session();
const counters: Record<string, number> = {};
const restore: Array<() => void> = [];
const count = (target: object, key: string, label = key) => {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)!;
  const original = descriptor.value;
  assert.equal(typeof original, "function");
  Object.defineProperty(target, key, {
    ...descriptor,
    value: new Proxy(original, {
      apply(fn, receiver, args) {
        counters[label] = (counters[label] ?? 0) + 1;
        return Reflect.apply(fn, receiver, args);
      },
    }),
  });
  restore.push(() => Object.defineProperty(target, key, descriptor));
};
try {
  for (const manager of managers) {
    for (let index = 0; index < 100; index++) {
      const account = manager.getRuntimeSnapshot().channelAccounts.clickclack?.default;
      assert.equal(account?.configured, true);
      assert.equal(account.enabled, true);
    }
  }
  for (const key of Object.keys(fs).filter((name) => name.endsWith("Sync"))) {
    count(fs, key);
  }
  count(fs.realpathSync, "native", "realpathSync.native");
  for (const [index, manager] of managers.entries()) {
    for (const key of Object.keys(counters)) {
      delete counters[key];
    }
    for (let read = 0; read < 18; read++) {
      manager.getRuntimeSnapshot();
    }
    console.log(
      JSON.stringify({
        phase: "counts",
        baseline: index === 0,
        reads: 18,
        counts: { ...counters },
      }),
    );
  }
  for (const undo of restore.splice(0).toReversed()) {
    undo();
  }
  if (allocations) {
    inspector.connect();
  }
  for (const [index, baseline] of [
    true,
    true,
    ...Array.from({ length: 5 }, () => [true, false]).flat(),
  ].entries()) {
    const manager = managers[baseline ? 0 : 1]!;
    global.gc();
    await nextTurn();
    if (allocations) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const cpuStart = process.threadCpuUsage();
    const start = performance.now();
    for (let iteration = 0; iteration < iterations; iteration++) {
      manager.getRuntimeSnapshot();
    }
    const wallMs = performance.now() - start;
    const cpu = process.threadCpuUsage(cpuStart);
    const sample = allocations ? await inspector.post("HeapProfiler.stopSampling") : undefined;
    console.log(
      JSON.stringify({
        phase: index < 2 ? "AA" : "AB",
        baseline,
        iterations,
        ...(sample
          ? {
              sampledBytesPerRead:
                sample.profile.samples.reduce((sum, entry) => sum + entry.size, 0) / iterations,
            }
          : {
              wallUsPerRead: (wallMs * 1000) / iterations,
              cpuUsPerRead: (cpu.user + cpu.system) / iterations,
            }),
        hostLoad: loadavg(),
      }),
    );
  }
} finally {
  for (const undo of restore.toReversed()) {
    undo();
  }
  inspector.disconnect();
  fs.rmSync(root, { recursive: true, force: true });
}
