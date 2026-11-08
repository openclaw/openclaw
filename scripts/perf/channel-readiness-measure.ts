/**
 * Channel-readiness owner cost, not a whole-Gateway or database benchmark.
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
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import type { ChannelAccountSnapshot } from "../../src/channels/plugins/types.public.js";

const { values } = parseArgs({
  options: {
    "source-dir": { type: "string" },
    mode: { type: "string", default: "refresh" },
    iterations: { type: "string", default: "100000" },
    reconnecting: { type: "boolean", default: false },
  },
});
assert(globalThis.gc, "Run with --expose-gc");
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
