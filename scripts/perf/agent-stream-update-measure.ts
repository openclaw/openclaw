/**
 * Provider-update owner probe (1,000 history entries, 40 tools; no live services).
 * Run unchanged on base and candidate, alternating order for at least five pairs:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/agent-stream-update-measure.ts --mode timing --events 3000 --turns 200 --warmup 20
 * Repeat with --mode allocation; timing under the sampler is diagnostic only.
 * --snapshots false exercises partial-free text deltas instead of checkpoints.
 * --async-fragments true --events 4 --turns 5000 --warmup 250 replays async tool fragments
 * followed by a text tail; compare allocation and CPU per committed fragment.
 * --event-type text_delta|thinking_delta|toolcall_delta selects snapshot updates.
 * --transforms 1 (or 3) installs real adjacent stream-event decorators. Compare
 * against --transforms 0 to separate wrapper cost from the fixture generator.
 * --plugin-bound includes a registered plugin's iterator membrane; --owner can
 * select a frozen stream-wrapper.ts module for paired decorator measurements.
 * --mode promises counts Node promise initialization separately from timing.
 * --mode verify replays a fixed multi-turn recording with all update kinds, async
 * fragments and a blocking tool; hashes include provider request contexts.
 * Compare outputSha256 across revisions.
 * --layer responses-observer selects an isolated real iterator owner instead.
 * --layer all --mode promises inventories real layers using the promise-count
 * slope between 32 and --events reads; see agent-stream-update-measure.md.
 * --profile /path/profile.json saves allocation stacks. Use --no-turbo-inlining
 * for attribution only, and normal optimization for the paired measurements.
 * --dispatch session includes Agent state and AgentSession listener dispatch with
 * an in-memory transcript. Compare to --dispatch loop (the default) to attribute
 * listener promises. Session runs reset agent history before each prompt.
 * --extensions 40 loads unrelated session extensions to measure delta handler scans.
 * --dispatch tool-end isolates completion delivery to an asynchronous listener;
 * metrics are per completed tool rather than per streamed update.
 * Accept lower allocation or CPU/update with identical delivery counts; report tradeoffs.
 * this measures the real agent loop, not whole-Gateway throughput or latency.
 */
import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { runAgentLoop } from "../../packages/agent-core/src/agent-loop.js";
import {
  config,
  makeCall,
  makeAssistantMessage,
  makeTool,
  user,
} from "../../packages/agent-core/src/agent-loop.test-support.js";
import { emitToolExecutionEnd } from "../../packages/agent-core/src/agent-stream-response.js";
import { Agent } from "../../packages/agent-core/src/agent.js";
import type { AgentEvent } from "../../packages/agent-core/src/types.js";
import type { AssistantMessageEvent } from "../../packages/llm-core/src/types.js";
import type { MutableAssistantMessageEventStream } from "../../src/agents/stream-compat.js";
import { PluginInstance } from "../../src/plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";
import { createPluginRecord } from "../../src/plugins/status.test-helpers.js";

const { values } = parseArgs({
  options: {
    profile: { type: "string" },
    "event-type": { type: "string", default: "thinking_delta" },
    mode: { type: "string", default: "timing" },
    events: { type: "string", default: "20000" },
    turns: { type: "string", default: "10" },
    warmup: { type: "string", default: "1" },
    snapshots: { type: "string", default: "true" },
    "async-fragments": { type: "string", default: "false" },
    transforms: { type: "string", default: "0" },
    "plugin-bound": { type: "boolean", default: false },
    owner: { type: "string" },
    layer: { type: "string" },
    dispatch: { type: "string", default: "loop" },
    extensions: { type: "string", default: "0" },
  },
});
const {
  wrapStreamObjectEvents,
}: typeof import("../../src/agents/embedded-agent-runner/run/stream-wrapper.js") = await import(
  values.owner
    ? pathToFileURL(resolve(values.owner)).href
    : "../../src/agents/embedded-agent-runner/run/stream-wrapper.js"
);
const events = Number(values.events);
const turns = Number(values.turns);
const warmup = Number(values.warmup);
const transforms = Number(values.transforms);
const extensions = Number(values.extensions);
assert(Number.isSafeInteger(extensions) && extensions >= 0);
assert(Number.isSafeInteger(transforms) && transforms >= 0);
assert(Number.isSafeInteger(events) && events > 0);
assert(Number.isSafeInteger(turns) && turns > 0);
assert(Number.isSafeInteger(warmup) && warmup > 0);
assert(["timing", "allocation", "verify", "promises"].includes(values.mode));
assert(["loop", "session", "tool-end"].includes(values.dispatch));
assert(extensions === 0 || values.dispatch === "session");
assert(values.dispatch === "loop" || (!values.layer && values.mode !== "verify"));
if (values.layer) {
  const { measureStreamLayers } = await import("./agent-stream-update-layers.js");
  await measureStreamLayers({
    layer: values.layer,
    mode: values.mode,
    events,
    turns,
    warmup,
    profile: values.profile,
  });
  process.exit(0);
}
assert(values.snapshots === "true" || values.snapshots === "false");
assert(values["async-fragments"] === "true" || values["async-fragments"] === "false");
const asyncFragments = values["async-fragments"] === "true";
const snapshots = values.snapshots === "true";
const eventType = values["event-type"];
assert(
  eventType === "thinking_delta" || eventType === "text_delta" || eventType === "toolcall_delta",
);
const message = makeAssistantMessage(
  snapshots
    ? values["event-type"] === "thinking_delta"
      ? [{ type: "thinking", thinking: "synthetic thought" }]
      : values["event-type"] === "text_delta"
        ? [{ type: "text", text: "synthetic text" }]
        : [makeCall("synthetic_0", "call-probe")]
    : [],
);
const update: AssistantMessageEvent = snapshots
  ? { type: eventType, contentIndex: 0, delta: "x", partial: message }
  : { type: "text_delta", contentIndex: 0, delta: "x" };
const finalMessage = snapshots
  ? { ...message, stopReason: "stop" as const }
  : makeAssistantMessage([{ type: "text", text: "x".repeat(events) }]);
const history = Array.from({ length: 1000 }, (_, index) => user(`synthetic ${index}`, index));
const tools = Array.from({ length: 40 }, (_, index) => makeTool(`synthetic_${index}`));
const calls = asyncFragments
  ? Array.from({ length: events }, (_, index) => ({
      ...makeCall(`synthetic_${index % tools.length}`, `call-${index}`),
      async: true as const,
    }))
  : [];
const fragments = calls.map((call, index) => ({
  type: "toolcall_end" as const,
  contentIndex: index,
  toolCall: call,
  partial: {
    ...makeAssistantMessage(calls.slice(0, index + 1)),
    responseId: "synthetic-response",
  },
}));
const fragmentTail = {
  ...makeAssistantMessage([...calls, { type: "text", text: "done" }]),
  responseId: "synthetic-response",
  stopReason: "stop" as const,
};
let deliveries = 0;
let observations = 0;
const record = createPluginRecord({ id: "synthetic-stream", origin: "bundled" });
const plugin = values["plugin-bound"]
  ? new PluginInstance(record.id, {
      record,
      registry: { ...createEmptyPluginRegistry(), plugins: [record] },
    })
  : undefined;
function decorate(source: MutableAssistantMessageEventStream) {
  const stream = plugin?.wrap(source) ?? source;
  for (let index = 0; index < transforms; index++) {
    wrapStreamObjectEvents(stream, (event) => {
      if (event.type === eventType) {
        observations++;
      }
    });
  }
  return stream;
}
const onEvent = (event: { type: string }) => {
  if (event.type === "message_update") {
    deliveries++;
  }
};
const session = values.dispatch === "session" ? await createSession() : undefined;
const completedTool = {
  toolCall: makeCall("synthetic_0", "completed-call"),
  result: { content: [{ type: "text" as const, text: "result".repeat(1024) }], details: {} },
  isError: false,
  executionStarted: true,
};
let lastCompletion: AgentEvent | undefined;
const completionBatch = {
  assistantMessage: makeAssistantMessage([completedTool.toolCall]),
  emit: (event: AgentEvent) => {
    lastCompletion = event;
    deliveries++;
    return Promise.resolve();
  },
};
async function createSession() {
  const agent = new Agent({
    initialState: { model: config.model, tools },
    streamFn: () => {
      throw new Error("Probe stream not installed");
    },
  });
  const { AgentSession } = await import("../../src/agents/sessions/agent-session.js");
  const { AuthStorage } = await import("../../src/agents/sessions/auth-storage.js");
  const { ModelRegistry } = await import("../../src/agents/sessions/model-registry.js");
  const { SessionManager } = await import("../../src/agents/sessions/session-manager.js");
  const { SettingsManager } = await import("../../src/agents/sessions/settings-manager.js");
  const { DefaultResourceLoader } = await import("../../src/agents/sessions/resource-loader.js");
  const manager = SessionManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: manager.getCwd(),
    agentDir: manager.getCwd(),
    extensionFactories: Array.from({ length: extensions }, () => (api) => {
      api.on("session_start", () => {});
    }),
  });
  await resourceLoader.reload();
  assert.equal(resourceLoader.getExtensions().errors.length, 0);
  assert.equal(resourceLoader.getExtensions().extensions.length, extensions);
  const result = new AgentSession({
    agent,
    systemPrompt: "synthetic probe",
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
    cwd: manager.getCwd(),
    resourceLoader,
    modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
    allowedToolNames: [],
    cleanupProviderSessionResourcesOnDispose: false,
  });
  agent.state.tools = tools;
  result.subscribe(onEvent);
  return result;
}
async function run() {
  if (values.dispatch === "tool-end") {
    for (let index = 0; index < events; index++) {
      await emitToolExecutionEnd(completedTool, completionBatch);
    }
    return;
  }
  let responseCount = 0;
  const streamFn: NonNullable<Parameters<typeof runAgentLoop>[5]> = () => {
    const toolResponse = asyncFragments && responseCount === 0;
    const updates = responseCount++ === 0 ? events : 0;
    const result = toolResponse ? fragmentTail : finalMessage;
    return decorate({
      async *[Symbol.asyncIterator]() {
        yield { type: "start", partial: message } as const;
        if (toolResponse) {
          for (const fragment of fragments) {
            yield fragment;
          }
        } else {
          for (let index = 0; index < updates; index++) {
            yield update;
          }
        }
        yield { type: "done", reason: "stop", message: result } as const;
      },
      result: async () => result,
    });
  };
  if (session) {
    session.agent.state.messages = history;
    session.agent.streamFn = streamFn;
    await session.agent.prompt(user());
    return;
  }
  await runAgentLoop(
    [user()],
    { systemPrompt: "synthetic probe", messages: history, tools },
    config,
    onEvent,
    undefined,
    streamFn,
  );
}
// Record checkpoints before replay so provider fixture allocation is not confused
// with the owner. Freeze time only in this separate byte-equality pass.
async function verifyRecording() {
  const asyncCall = { ...makeCall("synthetic_0", "async-call"), async: true as const };
  const blockingCall = makeCall("synthetic_1", "blocking-call");
  const recordedMessage = makeAssistantMessage([]);
  recordedMessage.responseId = "recorded-response";
  const recording: AssistantMessageEvent[] = [
    { type: "start", partial: structuredClone(recordedMessage) },
  ];
  const checkpoint = () => structuredClone(recordedMessage);
  for (const block of [
    { type: "thinking", thinking: "inspect" } as const,
    { type: "text", text: "before" } as const,
    asyncCall,
    { type: "text", text: "after" } as const,
    blockingCall,
  ]) {
    const contentIndex = recordedMessage.content.length;
    recordedMessage.content.push(block);
    if (block.type === "toolCall") {
      recording.push(
        { type: "toolcall_start", contentIndex, partial: checkpoint() },
        { type: "toolcall_delta", contentIndex, delta: "{}", partial: checkpoint() },
        { type: "toolcall_end", contentIndex, toolCall: block, partial: checkpoint() },
      );
    } else if (block.type === "thinking") {
      recording.push(
        { type: "thinking_start", contentIndex, partial: checkpoint() },
        { type: "thinking_delta", contentIndex, delta: block.thinking, partial: checkpoint() },
        { type: "thinking_end", contentIndex, content: block.thinking, partial: checkpoint() },
      );
    } else {
      recording.push(
        { type: "text_start", contentIndex, partial: checkpoint() },
        { type: "text_delta", contentIndex, delta: block.text, partial: checkpoint() },
        { type: "text_delta", contentIndex, delta: "!" },
        { type: "text_delta", contentIndex, delta: "?", partial: undefined },
        { type: "text_end", contentIndex, content: block.text, partial: checkpoint() },
      );
    }
  }
  recordedMessage.stopReason = "toolUse";
  recording.push({ type: "done", reason: "toolUse", message: checkpoint() });
  const terminal = makeAssistantMessage([{ type: "text", text: "finished" }]);
  const continuation: AssistantMessageEvent[] = [
    { type: "start", partial: terminal },
    { type: "text_delta", contentIndex: 0, delta: "finished", partial: terminal },
    { type: "done", reason: "stop", message: terminal },
  ];
  const output = createHash("sha256");
  let emitted = 0;
  let request = 0;
  const now = Date.now;
  Date.now = () => 1;
  try {
    const messages = await runAgentLoop(
      [user()],
      { systemPrompt: "synthetic recording", messages: history, tools },
      config,
      (event) => {
        output.update(JSON.stringify(event));
        emitted++;
      },
      undefined,
      (_model, context) => {
        output.update(JSON.stringify(context));
        const replay = request++ === 0 ? recording : continuation;
        assert(request <= 2);
        return decorate({
          async *[Symbol.asyncIterator]() {
            yield* replay;
          },
          result: async () => (replay === recording ? recordedMessage : terminal),
        });
      },
    );
    output.update(JSON.stringify(messages));
  } finally {
    Date.now = now;
  }
  assert.equal(request, 2);
  console.log(
    JSON.stringify({
      mode: "verify",
      emitted,
      requests: request,
      outputSha256: output.digest("hex"),
    }),
  );
}
if (values.mode === "verify") {
  await verifyRecording();
  process.exit(0);
}
for (let turn = 0; turn < warmup; turn++) {
  await run();
}
deliveries = 0;
observations = 0;
globalThis.gc?.();
const allocation = values.mode === "allocation";
const inspector = new Session();
if (allocation) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 512,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoad = loadavg();
let promises = 0;
const hook = createHook({
  init(_id, type) {
    if (type === "PROMISE") {
      promises++;
    }
  },
});
if (values.mode === "promises") {
  hook.enable();
}
const cpu = process.cpuUsage();
const threadCpu = process.threadCpuUsage();
const start = performance.now();
for (let turn = 0; turn < turns; turn++) {
  await run();
}
const elapsedMs = performance.now() - start;
const used = process.cpuUsage(cpu);
const threadUsed = process.threadCpuUsage(threadCpu);
hook.disable();
let allocatedBytes: number | undefined;
if (allocation) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  inspector.disconnect();
  if (values.profile) {
    writeFileSync(values.profile, JSON.stringify(profile));
  }
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  allocatedBytes = sum(profile.head);
}
assert.equal(deliveries, events * turns);
if (values.dispatch === "tool-end") {
  assert.equal(lastCompletion?.type, "tool_execution_end");
}
if (!asyncFragments && snapshots) {
  assert.equal(observations, transforms * deliveries);
}
console.log(
  JSON.stringify({
    mode: values.mode,
    dispatch: values.dispatch,
    eventType: values["event-type"],
    snapshots,
    asyncFragments,
    events,
    turns,
    warmup,
    transforms,
    pluginBound: Boolean(plugin),
    extensions,
    observations,
    promisesPerUpdate: values.mode === "promises" ? promises / deliveries : undefined,
    deliveries,
    hostLoad,
    elapsedMs,
    cpuNsPerUpdate: ((used.user + used.system) * 1000) / deliveries,
    mainThreadCpuNsPerUpdate: ((threadUsed.user + threadUsed.system) * 1000) / deliveries,
    allocatedBytesPerUpdate: allocatedBytes === undefined ? undefined : allocatedBytes / deliveries,
  }),
);
session?.dispose();
await plugin?.dispose();
