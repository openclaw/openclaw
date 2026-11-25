import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import {
  constants,
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
} from "node:perf_hooks";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { sanitizeSessionMessagesImages } from "../../src/agents/embedded-agent-helpers/images.js";
import {
  normalizeAssistantReplayContent,
  sanitizeSessionHistory,
} from "../../src/agents/embedded-agent-runner/replay-history.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { SessionManager } from "../../src/agents/sessions/index.js";
import { markInboundContextLabel } from "../../src/auto-reply/reply/inbound-context-marker.js";
import { isOwnedTranscriptPayload } from "../../src/config/sessions/transcript-json.js";

const { values } = parseArgs({
  options: {
    stage: { type: "string", default: "history" },
    messages: { type: "string", default: "1000" },
    attempts: { type: "string", default: "200" },
    allocations: { type: "boolean", default: false },
    "start-at": { type: "string", default: "0" },
    "start-file": { type: "string" },
    "ready-file": { type: "string" },
  },
});
const attempts = Number(values.attempts);
const messageCount = Number(values.messages);
if (
  !Number.isSafeInteger(attempts) ||
  attempts < 1 ||
  !Number.isSafeInteger(messageCount) ||
  messageCount < 2 ||
  messageCount % 2 !== 0
) {
  throw new Error("--attempts must be positive; --messages must be a positive even integer");
}
if (!["history", "normalize", "images"].includes(values.stage)) {
  throw new Error("--stage must be history, normalize, or images");
}
if (
  [...process.execArgv, process.env.NODE_OPTIONS ?? ""].some((value) => /--trace[-_]gc/.test(value))
) {
  throw new Error("Run timing and allocation separately without GC tracing");
}
const manager = SessionManager.inMemory();
const user = (index: number): Extract<AgentMessage, { role: "user" }> => ({
  role: "user",
  content: [{ type: "text", text: `Synthetic request ${index}: ${"context ".repeat(64)}` }],
  timestamp: index * 2,
});
for (let index = 0; index < messageCount / 2; index++) {
  await manager.appendMessageAsync(user(index));
  await manager.appendMessageAsync({
    role: "assistant",
    content: [
      {
        type: "text",
        text: [
          ...(index % 10 === 0
            ? [
                markInboundContextLabel("Conversation info:"),
                "```json",
                '{"message_id":"synthetic"}',
                "```",
                "",
              ]
            : []),
          `Synthetic answer ${index}: ${"answer ".repeat(64)}`,
        ].join("\n"),
      },
    ],
    api: "openai-completions",
    provider: "synthetic",
    model: "synthetic",
    usage: {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: index * 2 + 1,
  });
}
const messages = manager.buildSessionContext().messages;
const sanitize =
  values.stage === "normalize"
    ? async (input: AgentMessage[]) => normalizeAssistantReplayContent(input)
    : values.stage === "images"
      ? async (input: AgentMessage[]) =>
          sanitizeSessionMessagesImages(input, "session:history", { preserveSignatures: true })
      : async (input: AgentMessage[]) =>
          sanitizeSessionHistory({
            messages: input,
            sessionManager: manager,
            sessionId: "synthetic",
          });
const retainedHeap = () => {
  if (!global.gc) {
    return undefined;
  }
  global.gc();
  return process.memoryUsage().heapUsed;
};
const coldHeapBytes = retainedHeap();
for (let index = 0; index < 5; index++) {
  await sanitize(messages);
}
await nextTurn();
const warmHeapBytes = retainedHeap();
if (values["ready-file"]) {
  writeFileSync(values["ready-file"], "ready\n");
}
let startAt = Number(values["start-at"]);
if (values["start-file"]) {
  while (!existsSync(values["start-file"])) {
    await delay(20);
  }
  startAt = Number(readFileSync(values["start-file"], "utf8"));
}
if (!Number.isFinite(startAt)) {
  throw new Error("Start time must be epoch milliseconds");
}
if (startAt > Date.now()) {
  await delay(startAt - Date.now());
}
const inspector = new Session();
if (values.allocations) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 1024,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const pauses: Array<{ duration: number; kind: number }> = [];
const gc = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    const detail = (entry as typeof entry & { detail: { kind: number } }).detail;
    pauses.push({ duration: entry.duration, kind: detail.kind });
  }
});
gc.observe({ entryTypes: ["gc"] });
const loop = monitorEventLoopDelay({ resolution: 1 });
loop.enable();
await nextTurn();
const cpuStart = process.cpuUsage();
const start = performance.now();
const startedAt = Date.now();
let copiedMessages = 0;
let copiedContents = 0;
let presentedMessages = 0;
let reusedOutputMessages = 0;
let reusedOutputContents = 0;
let result: AgentMessage[] = [];
const latencies: number[] = [];
const contentOf = (message: AgentMessage | undefined) => {
  switch (message?.role) {
    case "user":
    case "assistant":
    case "toolResult":
      return message.content;
    default:
      return undefined;
  }
};
for (let index = 0; index < attempts; index++) {
  const input = [...messages, user(messages.length + index)];
  const previous = result;
  const operationStart = performance.now();
  result = await sanitize(input);
  latencies.push(performance.now() - operationStart);
  presentedMessages += input.length;
  for (let message = 0; message < input.length; message++) {
    copiedMessages += Number(result[message] !== input[message]);
    copiedContents += Number(contentOf(result[message]) !== contentOf(input[message]));
    if (index > 0 && message < messages.length) {
      reusedOutputMessages += Number(result[message] === previous[message]);
      reusedOutputContents += Number(contentOf(result[message]) === contentOf(previous[message]));
    }
  }
  if (index % 10 === 9) {
    await nextTurn();
  }
}
const elapsedMs = performance.now() - start;
const cpu = process.cpuUsage(cpuStart);
await nextTurn();
await nextTurn();
gc.disconnect();
loop.disable();
let allocatedBytes: number | undefined;
let allocationSamples: number | undefined;
if (values.allocations) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  allocationSamples = profile.samples?.length;
  const pending = [profile.head];
  allocatedBytes = 0;
  while (pending.length) {
    const node = pending.pop()!;
    allocatedBytes += node.selfSize;
    pending.push(...node.children);
  }
  inspector.disconnect();
}
const finalHeapBytes = retainedHeap();
const summarize = (samples: number[]) => {
  samples.sort((left, right) => left - right);
  return {
    count: samples.length,
    totalMs: samples.reduce((total, value) => total + value, 0),
    p95Ms: samples[Math.ceil(samples.length * 0.95) - 1] ?? 0,
    p99Ms: samples[Math.ceil(samples.length * 0.99) - 1] ?? 0,
    maxMs: samples.at(-1) ?? 0,
  };
};
console.log(
  JSON.stringify({
    stage: values.stage,
    attempts,
    historyMessages: messages.length,
    startedAt,
    ownedMessages: messages.filter(isOwnedTranscriptPayload).length,
    presentedMessages,
    copiedMessages,
    copiedContents,
    reusedOutputMessages,
    reusedOutputContents,
    elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    allocatedBytes,
    allocationSamples,
    gc: summarize(pauses.map(({ duration }) => duration)),
    minorGc: summarize(
      pauses
        .filter(({ kind }) => kind === constants.NODE_PERFORMANCE_GC_MINOR)
        .map(({ duration }) => duration),
    ),
    majorGc: summarize(
      pauses
        .filter(({ kind }) => kind === constants.NODE_PERFORMANCE_GC_MAJOR)
        .map(({ duration }) => duration),
    ),
    latency: summarize(latencies),
    eventLoop: {
      count: loop.count,
      p95Ms: loop.percentile(95) / 1e6,
      p99Ms: loop.percentile(99) / 1e6,
      maxMs: loop.max / 1e6,
    },
    retainedHeap:
      coldHeapBytes === undefined || warmHeapBytes === undefined || finalHeapBytes === undefined
        ? undefined
        : {
            coldBytes: coldHeapBytes,
            warmBytes: warmHeapBytes,
            finalBytes: finalHeapBytes,
            warmDeltaBytes: warmHeapBytes - coldHeapBytes,
            finalDeltaBytes: finalHeapBytes - coldHeapBytes,
          },
    inputHash: createHash("sha256").update(JSON.stringify(messages)).digest("hex"),
    payloadHash: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
  }),
);
