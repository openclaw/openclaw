// Replay synthetic stream events through the real chat owner, without transport or persistence.
// node --import ./scripts/tsx.mjs scripts/perf/gateway-agent-event-measure.ts
// --output .local/chat-events/results.json --turns 10 --deltas 2000 --samples 5
// Add --resolve-session to omit run registration/event session keys and resolve against
// 10,000 synthetic session records. Run --no-allocation separately for untraced CPU.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { AgentEventRuntimePayload } from "../../src/infra/agent-events.types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  allowNegative: true,
  options: {
    output: { type: "string" },
    turns: { type: "string", default: "1000" },
    samples: { type: "string", default: "5" },
    deltas: { type: "string", default: "100" },
    allocation: { type: "boolean", default: true },
    "resolve-session": { type: "boolean", default: false },
  },
});
assert(values.output, "--output is required (inside an owned benchmark directory)");
const output = path.resolve(values.output);
const root = path.dirname(output);
mkdirSync(root, { recursive: true });
Object.assign(process.env, {
  HOME: root,
  OPENCLAW_HOME: root,
  OPENCLAW_STATE_DIR: path.join(root, "state"),
  OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
});
const integer = (raw: string, label: string) =>
  parseStrictIntegerOption({ raw, label, min: 1, fallback: 1 });
const turns = integer(values.turns, "--turns");
const samples = integer(values.samples, "--samples");
const deltas = integer(values.deltas, "--deltas");
const {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} = await import("../../src/gateway/server-chat.js");

const runId = "synthetic-run";
const sessionKey = "agent:main:synthetic";
const sessions = values["resolve-session"]
  ? new Map(
      Array.from(
        { length: 10_000 },
        (_, index) =>
          [
            index === 0 ? runId : `synthetic-run-${index}`,
            { sessionKey: index === 0 ? sessionKey : `agent:main:synthetic-${index}` },
          ] as const,
      ),
    )
  : undefined;
const startTime = 1_700_000_000_000;
const sequence: Array<Pick<AgentEventRuntimePayload, "stream" | "data">> = [
  { stream: "lifecycle", data: { phase: "start", startedAt: startTime } },
  { stream: "tool", data: { phase: "start", name: "read", toolCallId: "read-1" } },
  {
    stream: "tool",
    data: { phase: "result", name: "read", toolCallId: "read-1", result: "synthetic result" },
  },
  ...Array.from({ length: deltas }, (_, index) => ({
    stream: "assistant",
    data: { itemId: "answer-1", text: "ok ".repeat(index + 1), delta: "ok " },
  })),
  { stream: "lifecycle", data: { phase: "end", endedAt: startTime + (deltas + 4) * 100 } },
];
const events: AgentEventRuntimePayload[] = sequence.map((event, index) =>
  Object.assign({ stream: event.stream, data: event.data, runId }, sessions ? {} : { sessionKey }, {
    seq: index + 1,
    ts: startTime + index * 100,
    projectSessionLifecycle: false,
  }),
);
let captured: Array<[string, unknown]> | undefined = [];
let frames = 0;
let lifecycleLookups = 0;
let sessionLookups = 0;
const broadcast = (name: string, payload: unknown) => {
  frames++;
  captured?.push([name, payload]);
};
const state = createChatRunState();
const handler = createAgentEventHandler({
  broadcast,
  broadcastToConnIds: broadcast,
  nodeSendToSession() {},
  nodeHasSessionSubscribers: () => false,
  agentRunSeq: new Map(),
  chatRunState: state,
  resolveSessionKeyForRun: (id) => {
    sessionLookups++;
    return sessions?.get(id)?.sessionKey;
  },
  clearAgentRunContext() {},
  toolEventRecipients: state.toolEventRecipients,
  sessionEventSubscribers: createSessionEventSubscriberRegistry(),
  sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
  // Count demand at the callback boundary; registry lookup cost belongs to the Gateway workload.
  resolveActiveLifecycleGenerationForRun: () => {
    lifecycleLookups++;
    return "synthetic-generation";
  },
});
const originalNow = Date.now;
let now = startTime;
Date.now = () => now;
const inspector = new Session();
function turn() {
  if (!sessions) {
    state.registry.add(runId, { sessionKey, clientRunId: runId, agentId: "main" });
  }
  for (const event of events) {
    now = event.ts;
    assert.equal(handler(event), undefined, "fixture admission must stay synchronous");
  }
}
function allocatedBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocatedBytes(child), 0);
}
try {
  turn();
  const golden = JSON.stringify(captured);
  writeFileSync(`${output}.frames.json`, `${golden}\n`);
  const goldenHash = createHash("sha256").update(golden).digest("hex");
  captured = undefined;
  for (let index = 0; index < Math.ceil(10_000 / events.length); index++) {
    turn();
  }
  if (values.allocation) {
    inspector.connect();
    await inspector.post("HeapProfiler.enable");
  }
  const results = [];
  for (let sample = 0; sample < samples; sample++) {
    if (values.allocation) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32_768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    frames = 0;
    lifecycleLookups = 0;
    sessionLookups = 0;
    const cpuStart = process.threadCpuUsage();
    const startedAt = performance.now();
    for (let index = 0; index < turns; index++) {
      turn();
    }
    const elapsedMs = performance.now() - startedAt;
    const cpu = process.threadCpuUsage(cpuStart);
    const memory = process.memoryUsage();
    const load = loadavg();
    let bytes: number | undefined;
    if (values.allocation) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      bytes = allocatedBytes(profile.head);
      writeFileSync(`${output}.${sample}.heapprofile`, JSON.stringify(profile));
    }
    const result = {
      sample,
      turns,
      deltas,
      allocation: values.allocation,
      resolveSession: values["resolve-session"],
      events: events.length * turns,
      frames,
      lifecycleLookups,
      sessionLookups,
      elapsedMs,
      cpuUsPerEvent: (cpu.user + cpu.system) / (events.length * turns),
      allocatedBytes: bytes,
      bytesPerEvent: bytes === undefined ? undefined : bytes / (events.length * turns),
      memory,
      load,
    };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  writeFileSync(output, `${JSON.stringify({ goldenHash, samples: results }, null, 2)}\n`);
} finally {
  if (values.allocation) {
    inspector.disconnect();
  }
  await handler.dispose();
  state.clear();
  Date.now = originalNow;
}
