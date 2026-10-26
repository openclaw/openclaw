/**
 * Viewer-key owner benchmark: 65 interleaved clients, eight identities, 40 plugin
 * entries and 10k synthetic session targets. The real sharing preparer resolves
 * roles/membership and requests keys on every streamed delta. No Gateway or
 * provider is exercised; this is owner CPU/allocation proof, not Gateway load proof.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-sharing-key-measure.ts
 * Add --owner src/gateway/.session-sharing-read-base.ts for a saved base sibling;
 * --allocations runs a separate V8 allocation pass. Run five interleaved pairs.
 * Acceptance: identical digest, lower CPU/allocation, unchanged live authority.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { GatewayClient } from "../../src/gateway/server-methods/types.js";
import type { SessionSharingTarget } from "../../src/gateway/session-sharing-policy.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: "src/gateway/session-sharing-read.ts" },
    events: { type: "string", default: "3000" },
    allocations: { type: "boolean", default: false },
  },
});
const events = Number(values.events);
assert(Number.isSafeInteger(events) && events > 0);
const owner = path.resolve(values.owner);
const {
  prepareProjectedSessionSharing,
}: typeof import("../../src/gateway/session-sharing-read.js") = await import(
  pathToFileURL(owner).href
);
const cfg: OpenClawConfig = {
  plugins: {
    entries: Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`fixture-${i}`, { enabled: true }]),
    ),
  },
  gateway: {
    roles: {
      default: "viewer",
      definitions: {
        viewer: {
          sessions: { others: "view" },
          agents: "*",
          scopes: ["operator.read", "operator.write"],
        },
      },
    },
  },
};
const clients: GatewayClient[] = Array.from({ length: 65 }, (_, i) => {
  const profileId = `synthetic-${i % 8}`;
  return {
    connId: `synthetic-${i}`,
    connect: {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: "openclaw-control-ui", version: "bench", platform: "bench", mode: "ui" },
      scopes: ["operator.read", "operator.write"],
    },
    authenticatedUserId: profileId,
    authenticatedUserProfile: { profileId, displayName: null, hasAvatar: false, updatedAt: 1 },
    preparedSessionProfile: {
      profileId,
      aliases: new Set([profileId]),
      role: null,
      githubLogin: null,
    },
  };
});
const targets: SessionSharingTarget[] = Array.from({ length: 10_000 }, (_, i) => ({
  agentId: "main",
  storePath: "/synthetic/sessions",
  storeKey: `agent:main:${i}`,
  canonicalKey: `agent:main:${i}`,
  storeKeys: [`agent:main:${i}`],
  entry: { sessionId: `session-${i}`, updatedAt: 1, visibility: "shared" },
}));
let revision: object = {};
let member = false;
let checksum = 0;
function publish(index: number, digest?: ReturnType<typeof createHash>) {
  // A committed sharing change retires the owner fact; transcript deltas do not.
  if (index % 100 === 0) {
    revision = {};
    member = !member;
  }
  const target = targets[index % targets.length]!;
  for (const client of clients) {
    const sharing = prepareProjectedSessionSharing({
      cfg,
      client,
      isMember: () => member,
    });
    const key = sharing.getCacheKey(revision);
    const role = sharing.roleForTarget(target);
    assert.equal(role, member ? "member" : "viewer");
    checksum += key.length + role.length;
    digest?.update(key).update(role);
  }
}
for (let i = 0; i < 200; i++) {
  publish(i);
}
global.gc?.();
const inspector = new Session();
if (values.allocations) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoadBefore = loadavg();
const memoryBefore = process.memoryUsage();
const cpuStart = process.threadCpuUsage();
const start = performance.now();
for (let i = 0; i < events; i++) {
  publish(i);
}
const elapsedMs = performance.now() - start;
const cpu = process.threadCpuUsage(cpuStart);
const memoryAfter = process.memoryUsage();
let sampledBytes: number | undefined;
if (values.allocations) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  sampledBytes = sum(profile.head);
  inspector.disconnect();
}
member = false;
const digest = createHash("sha256");
for (let i = 0; i < events; i++) {
  publish(i, digest);
}
console.log(
  JSON.stringify({
    ownerSha256: createHash("sha256").update(readFileSync(owner)).digest("hex"),
    node: process.version,
    events,
    clients: clients.length,
    mode: values.allocations ? "allocation" : "timing",
    elapsedMs,
    threadCpuMs: (cpu.user + cpu.system) / 1000,
    sampledBytes,
    checksum,
    digest: digest.digest("hex"),
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    memoryBefore,
    memoryAfter,
  }),
);
