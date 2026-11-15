// Run: node --import ./scripts/tsx.mjs scripts/perf/mention-target-preparation-measure.ts
// Add --allocation for a separate sampled-allocation pass, or --promises for work counts.
// Compare saved source with --owner /absolute/path/mention-inbox-targets.ts.
// Defaults: 1,000 warm scans, 10,000 mentions, 1,000 targets, 32 agents, 65 profiles.
// This measures the real target-preparation owner with fixed sharing readers and titles.
// It excludes storage, authorization implementation, response projection, and transport;
// reader calls remain counted, so a faster run cannot silently skip authority reads.
import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { StoredMention } from "../../src/gateway/mention-inbox-projection.js";
import type { SessionSharingTarget } from "../../src/gateway/session-sharing-policy.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    allocation: { type: "boolean" },
    promises: { type: "boolean" },
    iterations: { type: "string", default: "1000" },
  },
});
assert(!(values.allocation && values.promises), "Run allocation and promise counting separately");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const owner = new URL("../../src/gateway/mention-inbox-targets.ts", import.meta.url);
const source = readFileSync(values.owner ? resolve(values.owner) : fileURLToPath(owner), "utf8");
const fixtureUrl = `data:text/javascript,${encodeURIComponent(`
  let targets;
  export const counts = { resolves: 0, prepares: 0, reads: 0 };
  export function configure(value) { targets = value; }
  export function formatMentionSessionTitle(entry) { return entry.displayName; }
  export async function resolveSessionSharingTargetAsync({ sessionKey }) {
    counts.resolves++;
    return targets.get(sessionKey);
  }
  export async function prepareSessionSharingRead({ sessionKey }) {
    counts.prepares++;
    const target = targets.get(sessionKey);
    return { readCurrent() { counts.reads++; return { target }; }, release() {} };
  }
`)}`;
registerHooks({
  load(url, context, nextLoad) {
    if (url === owner.href) {
      return { source, format: "module-typescript", shortCircuit: true };
    }
    if (
      /\/gateway\/(?:session-sharing(?:-target-read)?|mention-inbox-presentation)\.ts$/.test(url)
    ) {
      return {
        source: `export { resolveSessionSharingTargetAsync, prepareSessionSharingRead, formatMentionSessionTitle } from ${JSON.stringify(fixtureUrl)};`,
        format: "module",
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
const fixture: {
  configure: (targets: Map<string, SessionSharingTarget>) => void;
  counts: { resolves: number; prepares: number; reads: number };
} = await import(fixtureUrl);
const { createMentionTargetCache } = await import("../../src/gateway/mention-inbox-targets.js");
const { mentionTargetKey } = await import("../../src/gateway/mention-inbox-projection.js");
const targets = new Map<string, SessionSharingTarget>();
for (let index = 0; index < 1_000; index++) {
  const agentId = `agent-${index % 32}`;
  const sessionKey = `agent:${agentId}:synthetic-${index}`;
  targets.set(sessionKey, {
    agentId,
    canonicalKey: sessionKey,
    storeKey: sessionKey,
    storeKeys: [sessionKey],
    storePath: `/synthetic/${agentId}.sqlite`,
    entry: { sessionId: `session-${index}`, updatedAt: 1, displayName: `Synthetic ${index}` },
  });
}
fixture.configure(targets);
const targetList = [...targets.values()];
const items: StoredMention[] = Array.from({ length: 10_000 }, (_, index) => {
  const target = targetList[index % targetList.length]!;
  return {
    id: `mention-${index}`,
    targetKey: mentionTargetKey(target.canonicalKey, target.agentId),
    recipientProfileId: `profile-${index % 65}`,
    source: { key: `source-${index}`, sequence: index, expiresAt: Infinity, recipients: new Map() },
    message: {
      sessionId: target.entry.sessionId!,
      content: {
        senderProfileId: "synthetic-sender",
        sessionKey: target.canonicalKey,
        agentId: target.agentId,
        messageId: `message-${index}`,
        createdAt: 1,
      },
    },
  };
});
const cfg = {};
const cache = createMentionTargetCache({ getRuntimeConfig: () => cfg, readItems: () => items });
for (let index = 0; index < 20; index++) {
  await cache.prepareTargets();
}
fixture.counts.resolves = fixture.counts.prepares = fixture.counts.reads = 0;
let promises = 0;
const hook = createHook({
  init(_id, type) {
    if (type === "PROMISE") {
      promises++;
    }
  },
});
const inspector = new Session();
if (values.allocation) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32_768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
if (values.promises) {
  hook.enable();
}
const cpuStart = process.threadCpuUsage();
const start = performance.now();
for (let index = 0; index < iterations; index++) {
  await cache.prepareTargets();
}
const wallMs = performance.now() - start;
const cpu = process.threadCpuUsage(cpuStart);
hook.disable();
let sampledBytes: number | undefined;
if (values.allocation) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const bytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((sum, child) => sum + bytes(child), 0);
  sampledBytes = bytes(profile.head);
  inspector.disconnect();
}
assert.equal(fixture.counts.reads, iterations * items.length);
assert.equal(fixture.counts.prepares, 0);
assert.equal(fixture.counts.resolves, 0);
console.log(
  JSON.stringify({
    phase: "warm mention target preparation",
    mode: values.allocation ? "allocation" : values.promises ? "promises" : "timing",
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    node: process.version,
    iterations,
    mentions: items.length,
    targets: targets.size,
    wallMs,
    mainThreadCpuUsPerCall: (cpu.user + cpu.system) / iterations,
    sampledBytesPerCall: sampledBytes === undefined ? undefined : sampledBytes / iterations,
    promisesPerCall: values.promises ? promises / iterations : undefined,
    authorityReadsPerCall: fixture.counts.reads / iterations,
    preparationReadsPerCall: (fixture.counts.prepares + fixture.counts.resolves) / iterations,
    load: loadavg(),
  }),
);
cache.invalidateTargets();
