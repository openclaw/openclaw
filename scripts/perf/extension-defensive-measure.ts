// Owner microbench for redundant extension normalization/decoding.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/extension-defensive-measure.ts timing 4000
// Repeat with allocation. Optional third argument selects an extracted source root.
// Compare base/candidate in fresh processes, swapping CPU placement between pairs.
// Five batches per owner after 100 warmups; fixtures: 40 shared stores / 1,000 agents,
// padded Discord conversation targets, and a 2,500-character tool-progress detail.
// Accept identical results with less CPU/allocation; string-only deletions may be neutral.
// Measures owner work, not whole-Gateway latency. Network clients are synthetic sinks;
// Knowledge uses published registry snapshots and does not start storage workers.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { RegistrySnapshot } from "../../extensions/knowledge/src/store-registry.js";
import { parsePolicy, storesRevision } from "../../extensions/knowledge/src/stores-config.js";

const [mode = "timing", rawIterations = "4000", sourceRoot = process.cwd()] = process.argv.slice(2);
const { Stores }: typeof import("../../extensions/knowledge/src/stores.js") = await import(
  pathToFileURL(path.join(sourceRoot, "extensions/knowledge/src/stores.ts")).href
);
const {
  resolveDiscordInboundConversation,
}: typeof import("../../extensions/discord/src/channel.conversation.js") = await import(
  pathToFileURL(path.join(sourceRoot, "extensions/discord/src/channel.conversation.ts")).href
);
const {
  createClickClackAgentProgressPublisher,
}: typeof import("../../extensions/clickclack/src/progress.js") = await import(
  pathToFileURL(path.join(sourceRoot, "extensions/clickclack/src/progress.ts")).href
);
const iterations = Number(rawIterations);
assert(mode === "timing" || mode === "allocation");
assert(Number.isSafeInteger(iterations) && iterations >= 5 && iterations % 5 === 0);
assert(global.gc, "Run with --expose-gc");

// The measured synchronous registry reads never consult the host runtime.
const stores = new Stores(
  { runtime: {} as OpenClawPluginApi["runtime"] },
  parsePolicy(undefined),
  () => {},
);
const snapshots: RegistrySnapshot[] = [0, 1].map((offset) => {
  const section = Object.fromEntries(
    Array.from({ length: 40 }, (_, group) => [
      `group-${group}`,
      {
        label: `Synthetic shared store ${group}`,
        agents: Array.from(
          { length: 25 },
          (_agent, index) => `agent-${(group * 25 + index + offset) % 1000}`,
        ),
      },
    ]),
  );
  return {
    stores: {},
    bindings: Object.fromEntries(
      Array.from({ length: 40 }, (_, group) => [`named:group-${group}`, `vault-${group}`]),
    ),
    labels: {},
    reconciled: { section: JSON.stringify(section), revision: storesRevision(section) },
    pending: null,
    grants: {},
  };
});
const target = "  discord:channel:1510164477642014999  ";
const discordInputs = [
  { to: target, isGroup: true },
  { to: target, isGroup: true, threadId: "1510164477642014740" },
];
const detail = "Team-shaped tool progress ".repeat(100).trim();
let lastLine: unknown;
const progress = createClickClackAgentProgressPublisher({
  client: {
    publishEphemeral: async (frame) => {
      if (frame.payload?.line) {
        lastLine = frame.payload.line;
      }
    },
  },
  target: { workspaceId: "synthetic-workspace", channelId: "synthetic-channel" },
  turnId: "synthetic-turn",
});
const event = {
  itemId: "synthetic-tool",
  kind: "tool",
  name: "read",
  progressText: `  ${detail}  `,
  status: "running",
};
progress.start();
const workloads = {
  knowledge(count: number) {
    for (let i = 0; i < count; i++) {
      const offset = Math.floor(i / 200) % 2;
      stores.registry.current = snapshots[offset];
      assert.equal(stores.vaultFor("agent-0"), offset ? "vault-39" : "vault-0");
    }
  },
  discord(count: number) {
    for (let i = 0; i < count; i++) {
      const thread = i % 2;
      const result = resolveDiscordInboundConversation(discordInputs[thread]!);
      assert.equal(
        result?.conversationId,
        thread ? "1510164477642014740" : "channel:1510164477642014999",
      );
    }
  },
  clickclack(count: number) {
    for (let i = 0; i < count; i++) {
      progress.onItemEvent(event);
    }
  },
};
const results = [];
for (const [workload, run] of Object.entries(workloads)) {
  run(100);
  global.gc();
  await nextTurn();
  const inspector = new Session();
  const gcDurations: number[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcDurations.push(entry.duration);
    }
  });
  if (mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  } else {
    observer.observe({ entryTypes: ["gc"] });
  }
  const hostLoad = loadavg();
  const batches = [];
  for (let batch = 0; batch < 5; batch++) {
    const cpu = process.threadCpuUsage();
    const start = performance.now();
    run(iterations / 5);
    const wallMs = performance.now() - start;
    const used = process.threadCpuUsage(cpu);
    batches.push({ wallMs, cpuMs: (used.user + used.system) / 1000 });
  }
  await nextTurn();
  await nextTurn();
  observer.disconnect();
  let sampledBytes: number | undefined;
  if (mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    inspector.disconnect();
  }
  results.push({
    workload,
    mode,
    iterations,
    batches,
    sampledBytes,
    hostLoad,
    gcMs: gcDurations.reduce((sum, ms) => sum + ms, 0),
    maxGcMs: Math.max(0, ...gcDurations),
    memory: process.memoryUsage(),
  });
}
await progress.finalize();
assert.deepEqual(lastLine, {
  id: "item:synthetic-tool",
  kind: "tool",
  text: `Read: ${detail}`,
  status: "running",
  tool_name: "read",
});
console.log(JSON.stringify({ node: process.version, results }));
