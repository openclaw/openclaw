// Replay synthetic stream events through the real chat owner, without transport or persistence.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import type { AgentEventRuntimePayload } from "../../src/infra/agent-events.types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    turns: { type: "string", default: "1000" },
    samples: { type: "string", default: "5" },
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
const {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} = await import("../../src/gateway/server-chat.js");

const runId = "synthetic-run";
const sessionKey = "agent:main:synthetic";
const startTime = 1_700_000_000_000;
const sequence: Array<Pick<AgentEventRuntimePayload, "stream" | "data">> = [
  { stream: "lifecycle", data: { phase: "start", startedAt: startTime } },
  { stream: "tool", data: { phase: "start", name: "read", toolCallId: "read-1" } },
  {
    stream: "tool",
    data: { phase: "result", name: "read", toolCallId: "read-1", result: "synthetic result" },
  },
  ...Array.from({ length: 100 }, (_, index) => ({
    stream: "assistant",
    data: { itemId: "answer-1", text: "ok ".repeat(index + 1), delta: "ok " },
  })),
  { stream: "lifecycle", data: { phase: "end", endedAt: startTime + 10_400 } },
];
const events: AgentEventRuntimePayload[] = sequence.map((event, index) => ({
  stream: event.stream,
  data: event.data,
  runId,
  sessionKey,
  seq: index + 1,
  ts: startTime + index * 100,
  projectSessionLifecycle: false,
}));
let captured: Array<[string, unknown]> | undefined = [];
let frames = 0;
let lifecycleLookups = 0;
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
  resolveSessionKeyForRun: () => undefined,
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
  state.registry.add(runId, { sessionKey, clientRunId: runId, agentId: "main" });
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
  for (let index = 0; index < 100; index++) {
    turn();
  }
  inspector.connect();
  await inspector.post("HeapProfiler.enable");
  const results = [];
  for (let sample = 0; sample < samples; sample++) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32_768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    frames = 0;
    lifecycleLookups = 0;
    const startedAt = performance.now();
    for (let index = 0; index < turns; index++) {
      turn();
    }
    const elapsedMs = performance.now() - startedAt;
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const bytes = allocatedBytes(profile.head);
    const result = {
      sample,
      turns,
      events: events.length * turns,
      frames,
      lifecycleLookups,
      elapsedMs,
      allocatedBytes: bytes,
      bytesPerEvent: bytes / (events.length * turns),
    };
    results.push(result);
    writeFileSync(`${output}.${sample}.heapprofile`, JSON.stringify(profile));
    console.log(JSON.stringify(result));
  }
  writeFileSync(output, `${JSON.stringify({ goldenHash, samples: results }, null, 2)}\n`);
} finally {
  inspector.disconnect();
  await handler.dispose();
  state.clear();
  Date.now = originalNow;
}
