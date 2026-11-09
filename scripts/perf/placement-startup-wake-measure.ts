/**
 * Owner probe; pair with ws-counter-stress.ts on a built Gateway for >=600 seconds.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/placement-startup-wake-measure.ts
 * Optional first argument: alternate owner module (preserve its relative imports).
 * Add --legacy-map as the second argument for the pre-change Map/dirty-Set shape.
 * Measures real session publications with 1,000 parked startup workspaces, then
 * a completed pass. Run unchanged workload on base/candidate in ABBA order.
 * Allocation is sampled separately from CPU; includes objects collected by GC.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PendingWorkspaceResultOrphanCleanup } from "../../src/gateway/worker-environments/placement-dispatch-orphan-cleanup.js";
import { sessionChanges } from "../../src/sessions/session-row-changes.js";

assert(global.gc, "requires --expose-gc");
const source = process.argv[2]
  ? pathToFileURL(resolve(process.argv[2])).href
  : new URL(
      "../../src/gateway/worker-environments/placement-dispatch-orphan-cleanup.ts",
      import.meta.url,
    ).href;
// The selected historical owner consumes the matching fixture representation below.
const owner: {
  subscribeWorkspaceResultOrphanChanges: (getPass: () => unknown) => () => void;
} = await import(source);
type Lookup = PendingWorkspaceResultOrphanCleanup["placements"][number];
type LegacyPass = Omit<PendingWorkspaceResultOrphanCleanup, "placements" | "unresolved"> & {
  placements: Lookup["placement"][];
  unresolved: Map<Lookup["placement"], Lookup["target"]>;
  dirty: Set<Lookup["placement"]>;
};
const notifications = 5000;
const timedNotifications = 50_000;
const common = {
  placements: [],
  initialDiscoveryPending: false,
  rootsBySession: new Map<string, string | null>(),
  completedRoots: new Set<string>(),
};
let pass: PendingWorkspaceResultOrphanCleanup | LegacyPass | undefined =
  process.argv[3] === "--legacy-map"
    ? { ...common, unresolved: new Map(), dirty: new Set() }
    : { ...common, unresolved: new Set() };
for (let index = 0; index < 1000; index++) {
  const identity = {
    sessionId: `parked-${index}`,
    sessionKey: `agent:main:parked-${index}`,
    agentId: "main",
    executionMode: "worker-turn" as const,
  };
  const target = {
    sessionKey: identity.sessionKey,
    agentId: "main",
    storePath: "/synthetic/sessions.sqlite",
  };
  if (pass.unresolved instanceof Map) {
    pass.unresolved.set(identity, target);
  } else {
    pass.unresolved.add({ placement: identity, target, dirty: false });
  }
}
const stop = owner.subscribeWorkspaceResultOrphanChanges(() => pass);
const change = { sessionKey: "agent:main:unrelated", scope: "session-entry" as const };
const publish = (count = notifications) => {
  for (let i = 0; i < count; i++) {
    sessionChanges.emit(change);
  }
};
try {
  for (const state of ["parked", "completed", "unsubscribed"]) {
    if (state === "completed") {
      pass = undefined;
    }
    if (state === "unsubscribed") {
      stop();
    }
    publish(20_000);
    global.gc();
    const cpu = process.threadCpuUsage();
    const start = performance.now();
    publish(timedNotifications);
    const elapsedMs = performance.now() - start;
    const used = process.threadCpuUsage(cpu);
    global.gc();
    const inspector = new Session();
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    publish();
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    inspector.disconnect();
    let bytes = 0;
    const visit = (node: typeof profile.head) => {
      bytes += node.selfSize;
      for (const child of node.children) {
        visit(child);
      }
    };
    visit(profile.head);
    console.log(
      JSON.stringify({
        state,
        notifications,
        timedNotifications,
        elapsedMs,
        cpuUsPerNotification: (used.user + used.system) / timedNotifications,
        sampledBytesPerNotification: bytes / notifications,
      }),
    );
  }
} finally {
  stop();
}
