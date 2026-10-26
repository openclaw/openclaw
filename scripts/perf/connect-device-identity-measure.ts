// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/connect-device-identity-measure.ts
// --source <saved device-pairing-identity.ts> selects a baseline at its original module URL.
// Compare counterbalanced runs; --allocation measures sampled bytes separately from timing.
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import type { PairedDevice } from "../../src/infra/device-pairing.types.js";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    allocation: { type: "boolean", default: false },
  },
});
assert(global.gc, "Run with --expose-gc");
const owner = new URL("../../src/infra/device-pairing-identity.ts", import.meta.url);
const source = readFileSync(values.source ?? owner, "utf8");
const hooks = registerHooks({
  load(url, context, nextLoad) {
    return url === owner.href
      ? { format: "module-typescript", source, shortCircuit: true }
      : nextLoad(url, context);
  },
});
const { resolveAuthenticatedDeviceTokenIdentity: resolveIdentity } =
  await import("../../src/infra/device-pairing-identity.ts");
hooks.deregister();
const peers = Array.from({ length: 65 }, (_, index) => {
  const device: PairedDevice = {
    deviceId: `synthetic-device-${index}`,
    publicKey: `synthetic-public-key-${index}`,
    roles: ["operator", "node"],
    approvedScopes: ["operator.admin", "operator.pairing", "operator.approvals"],
    tokens: {
      operator: {
        token: `synthetic-operator-token-${index}`,
        role: "operator",
        scopes: ["operator.admin", "operator.pairing", "operator.approvals"],
        createdAtMs: 1,
      },
      node: { token: `synthetic-node-token-${index}`, role: "node", scopes: [], createdAtMs: 1 },
    },
    createdAtMs: 1,
    approvedAtMs: 1,
  };
  return {
    device,
    authenticated: {
      role: "operator",
      publicKey: device.publicKey,
      token: device.tokens!.operator!.token,
      scopes: ["operator.read", "operator.write", "operator.approvals"],
    },
  };
});
const operations = 10_000;
let checksum = 0;
function run(count: number) {
  for (let i = 0; i < count; i++) {
    const peer = peers[i % peers.length]!;
    const identity = resolveIdentity(peer.device, peer.authenticated);
    assert(identity && identity.deviceId === peer.device.deviceId);
    checksum += identity.key.charCodeAt(0);
  }
}
run(2_000);
global.gc();
const inspector = new Session();
let sampledBytes: number | undefined;
if (values.allocation) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const cpu = process.threadCpuUsage();
const started = performance.now();
run(operations);
const elapsedMs = performance.now() - started;
const usedCpu = process.threadCpuUsage(cpu);
if (values.allocation) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  sampledBytes = sum(profile.head);
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    sourceHash: hash("sha256", source),
    mode: values.allocation ? "allocation" : "timing",
    operations,
    peers: peers.length,
    elapsedMs,
    cpuMs: (usedCpu.user + usedCpu.system) / 1000,
    sampledBytes,
    sampledBytesPerOperation: sampledBytes === undefined ? undefined : sampledBytes / operations,
    checksum,
    hostLoad: loadavg(),
  }),
);
