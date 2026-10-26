/**
 * Subscription event queue: 8 concurrent subscribers, 1,000 events per subscriber.
 * Run five counterbalanced base/candidate pairs, one process per side:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/embedded-subscribe-events-measure.ts \
 *   --owner /path/to/saved/embedded-agent-subscribe.handlers.ts
 * Omit --owner for the current handler. CPU and allocation use separate passes;
 * --retained excludes minor-collected samples for promotion-oriented attribution.
 * Import/setup/warmup are excluded. Output includes source hash and host load.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import type { SubscribeEmbeddedAgentSessionParams } from "../../src/agents/embedded-agent-subscribe.types.js";
import type { AgentSessionEvent } from "../../src/agents/sessions/index.js";

const { values } = parseArgs({
  options: { owner: { type: "string" }, retained: { type: "boolean", default: false } },
});
const ownerUrl = new URL("../../src/agents/embedded-agent-subscribe.handlers.ts", import.meta.url);
const source = readFileSync(values.owner ?? ownerUrl, "utf8");
let loaded = false;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url !== ownerUrl.href) {
      return nextLoad(url, context);
    }
    loaded = true;
    return { format: "module", source: stripTypeScriptTypes(source), shortCircuit: true };
  },
});
const { subscribeEmbeddedAgentSession } =
  await import("../../src/agents/embedded-agent-subscribe.js");
const { sessionManagerReadTranscriptStart } =
  await import("../../src/agents/sessions/session-manager-current-turn.js");
hooks.deregister();
assert(loaded, "The selected event owner must be loaded");

const subscribers = 8;
const eventsPerSubscriber = 1_000;
const rounds = 5;
let delivered = 0;
const onAgentEvent: SubscribeEmbeddedAgentSessionParams["onAgentEvent"] = (event) => {
  if (event.stream === "lifecycle" && event.data.phase === "end") {
    delivered++;
  }
};
async function round() {
  const gate = Promise.withResolvers<void>();
  const active = Array.from({ length: subscribers }, (_, index) => {
    let handler: ((event: AgentSessionEvent) => void) | undefined;
    // Only the subscriber's session boundary is synthetic; all event handlers run.
    const session = {
      sessionManager: { [sessionManagerReadTranscriptStart]: () => null },
      subscribe(callback: typeof handler) {
        handler = callback;
        return () => {
          handler = undefined;
        };
      },
    } as unknown as SubscribeEmbeddedAgentSessionParams["session"];
    const subscription = subscribeEmbeddedAgentSession({
      session,
      runId: `subscribe-queue-${index}`,
      onAgentEvent,
      onBeforeTerminalDelivery: () => gate.promise,
      sessionPersistence: "detached",
    });
    assert(handler);
    return { subscription, emit: handler };
  });
  const before = delivered;
  try {
    for (const item of active) {
      item.emit({ type: "agent_end", messages: [], willRetry: false });
    }
    for (let event = 0; event < eventsPerSubscriber; event++) {
      for (const item of active) {
        item.emit({ type: "turn_start" });
      }
    }
    assert.equal(delivered, before);
    gate.resolve();
    await Promise.all(active.map(({ subscription }) => subscription.waitForPendingEvents()));
    assert.equal(delivered, before + subscribers);
  } finally {
    gate.resolve();
    for (const item of active) {
      item.subscription.unsubscribe();
    }
  }
}
async function run() {
  for (let index = 0; index < rounds; index++) {
    await round();
  }
}
await round();
globalThis.gc?.();
const cpuStart = process.threadCpuUsage();
await run();
const cpu = process.threadCpuUsage(cpuStart);
globalThis.gc?.();
const inspector = new Session();
inspector.connect();
await inspector.post("HeapProfiler.startSampling", {
  samplingInterval: 1024,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: !values.retained,
});
const started = performance.now();
await run();
const allocationWallMs = performance.now() - started;
const { profile } = await inspector.post("HeapProfiler.stopSampling");
inspector.disconnect();
let sampledBytes = 0;
let subscribeSelfBytes = 0;
let handlerBytes = 0;
function sum(node: HeapProfiler.SamplingHeapProfileNode, inHandler = false) {
  sampledBytes += node.selfSize;
  if (node.callFrame.functionName === "subscribeEmbeddedAgentSession") {
    subscribeSelfBytes += node.selfSize;
  }
  const handler = inHandler || node.callFrame.url === ownerUrl.href;
  if (handler) {
    handlerBytes += node.selfSize;
  }
  for (const child of node.children) {
    sum(child, handler);
  }
}
sum(profile.head);
console.log(
  JSON.stringify({
    ownerSha256: createHash("sha256").update(source).digest("hex"),
    eventsPerPass: rounds * subscribers * eventsPerSubscriber,
    subscriptionsPerPass: rounds * subscribers,
    cpuMs: (cpu.user + cpu.system) / 1000,
    sampledBytes,
    handlerBytes,
    subscribeSelfBytes,
    allocationWallMs,
    retained: values.retained,
    hostLoad: loadavg(),
  }),
);
