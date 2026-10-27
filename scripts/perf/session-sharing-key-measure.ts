/**
 * Viewer-key owner benchmark: 65 interleaved clients, eight identities, 40 plugin
 * entries and 10k synthetic session targets. The real sharing preparer resolves
 * roles/membership and requests keys on every streamed delta. No Gateway or
 * provider is exercised; this is owner CPU/allocation proof, not Gateway load proof.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-sharing-key-measure.ts
 * Add --owner src/gateway/.session-sharing-read-base.ts for a saved base sibling;
 * --allocations runs a separate V8 allocation pass. Run five interleaved pairs.
 * --workload rows --events 3 scans all 10k rows for each client three times,
 * preparing sharing once per list and requesting its key without a revision.
 * --owner <base> --compare-owner <candidate> --pairs 5 runs counterbalanced
 * AB/BA pairs in one process; repeat separately with --allocations.
 * Opt-in allocation regression (Node 26): --allocations --pairs 5 --events 3000
 * --max-bytes-per-audience 2560 checks the median sampled bytes per preparation.
 * Use one owner per budget run; this is a sampled allocation gate, not a unit test.
 * Acceptance: identical digest, lower CPU/allocation, unchanged live authority.
 * --revision-every 1 measures cache-miss churn on each row publication; the
 * default 100 mixes misses with transcript-only hits. --gc-markers brackets
 * each measured pass for --trace-gc-nvp main-thread promotion/survival
 * totals; run that separately from timing and allocation sampling.
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
    "compare-owner": { type: "string" },
    pairs: { type: "string" },
    events: { type: "string", default: "3000" },
    workload: { type: "string", default: "events" },
    allocations: { type: "boolean", default: false },
    "max-bytes-per-audience": { type: "string" },
    "revision-every": { type: "string", default: "100" },
    "gc-markers": { type: "boolean", default: false },
  },
});
const events = Number(values.events);
assert(Number.isSafeInteger(events) && events > 0);
const workload = values.workload;
assert(workload === "events" || workload === "rows");
const pairs = Number(values.pairs ?? (values["compare-owner"] ? "5" : "1"));
assert(Number.isSafeInteger(pairs) && pairs > 0);
const revisionEvery = Number(values["revision-every"]);
assert(Number.isSafeInteger(revisionEvery) && revisionEvery > 0);
const allocationBudget = values["max-bytes-per-audience"];
if (allocationBudget !== undefined) {
  assert(values.allocations && workload === "events" && !values["compare-owner"]);
  assert(Number.isFinite(Number(allocationBudget)) && Number(allocationBudget) > 0);
  assert(pairs >= 5, "Allocation regression requires at least five samples");
}
const allocations: number[] = [];
const ownerPaths = values["compare-owner"]
  ? [values.owner, values["compare-owner"]]
  : [values.owner];
const owners = await Promise.all(
  ownerPaths.map(async (ownerPath) => {
    const owner = path.resolve(ownerPath);
    const source: typeof import("../../src/gateway/session-sharing-read.js") = await import(
      pathToFileURL(owner).href
    );
    return {
      prepareProjectedSessionSharing: source.prepareProjectedSessionSharing,
      sha256: createHash("sha256").update(readFileSync(owner)).digest("hex"),
    };
  }),
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
async function measure(owner: (typeof owners)[number], pair: number, arm: string) {
  const { prepareProjectedSessionSharing } = owner;
  let revision: object = {};
  let member = false;
  let checksum = 0;
  function publish(index: number, digest?: ReturnType<typeof createHash>) {
    // A committed sharing change retires the owner fact; transcript deltas do not.
    if (index % revisionEvery === 0) {
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
  function listRows(index: number, digest?: ReturnType<typeof createHash>) {
    member = index % 2 === 0;
    for (const client of clients) {
      const sharing = prepareProjectedSessionSharing({ cfg, client, isMember: () => member });
      const key = sharing.getCacheKey();
      checksum += key.length;
      digest?.update(key);
      let visible = 0;
      let members = 0;
      for (const target of targets) {
        if (sharing.entryFilter?.(target.canonicalKey, target.entry) === false) {
          continue;
        }
        visible++;
        const role = sharing.roleForTarget(target);
        members += Number(role === "member");
        checksum += role.length;
        digest?.update(target.canonicalKey).update(role);
      }
      assert.equal(visible, targets.length);
      assert.equal(members, member ? targets.length : 0);
    }
  }
  const run = workload === "events" ? publish : listRows;
  for (let i = 0; i < (workload === "events" ? 200 : 2); i++) {
    run(i);
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
  if (values["gc-markers"]) {
    console.log(JSON.stringify({ gcPass: "begin", pair, arm }));
  }
  for (let i = 0; i < events; i++) {
    run(i);
  }
  const elapsedMs = performance.now() - start;
  const cpu = process.threadCpuUsage(cpuStart);
  const memoryAfter = process.memoryUsage();
  if (values["gc-markers"]) {
    console.log(JSON.stringify({ gcPass: "end", pair, arm }));
  }
  let sampledBytes: number | undefined;
  if (values.allocations) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    sampledBytes = sum(profile.head);
    allocations.push(sampledBytes / (events * clients.length));
    inspector.disconnect();
  }
  member = false;
  const digest = createHash("sha256");
  for (let i = 0; i < events; i++) {
    run(i, digest);
  }
  console.log(
    JSON.stringify({
      ownerSha256: owner.sha256,
      pair,
      arm,
      node: process.version,
      workload,
      events,
      clients: clients.length,
      broadcasts: workload === "events" ? events : 0,
      listScans: workload === "rows" ? events * clients.length : 0,
      audienceKeys: events * clients.length,
      roleChecks: events * clients.length * (workload === "rows" ? targets.length : 1),
      mode: values.allocations ? "allocation" : "timing",
      revisionEvery,
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
}
for (let pair = 1; pair <= pairs; pair++) {
  const order = pair % 2 === 1 ? owners : owners.toReversed();
  for (const owner of order) {
    await measure(owner, pair, owner === owners[0] ? "base" : "candidate");
  }
}
if (allocationBudget !== undefined) {
  const ordered = allocations.toSorted((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  const median = (ordered[middle]! + ordered[Math.floor((ordered.length - 1) / 2)]!) / 2;
  assert(
    median <= Number(allocationBudget),
    `Median sampled allocation ${median.toFixed(1)} bytes/audience exceeds ${allocationBudget}`,
  );
}
