/**
 * Synthetic long-session replay through the real AgentSession loop, attempt prompt
 * submission, stream observer, context guards, and foreground compaction budget.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/token-pressure-attempt-measure.ts \
 *   --mode timing --requests 32 --output /path/to/result.json
 * --base-dir loads pinned snapshots of the ownerPaths listed below. Run A/A, then alternating A/B
 * in separate processes, at least five samples each. Repeat --mode allocation
 * and --mode counts; counting hooks are absent from timing/allocation runs.
 * Acceptance: identical pressure/budget vectors, fewer scanned characters per
 * request, lower CPU/allocation, no >20% latency regression. Setup is excluded.
 * This measures the real in-memory attempt request path, not Gateway I/O,
 * startup, provider network latency, or durable SQLite/workspace scale.
 * --large-results uses 120 megabyte-scale CJK tool results and checks projection bytes.
 * Counts include character floors as well as token pressure.
 * Tools use the production finalizer; --mutable-tools covers raw SDK declarations.
 * --mode profile writes a warm main-thread CPU profile alongside --output.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { AssistantMessage, Message, Model } from "@openclaw/llm-core";
import type { EmbeddedAttemptExecutionPhaseInput } from "../../src/agents/embedded-agent-runner/run/attempt-execution-types.js";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import { sumSampledHeapBytes } from "../lib/heap-sampling.js";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    requests: { type: "string", default: "32" },
    "base-dir": { type: "string" },
    output: { type: "string" },
    "mutable-tools": { type: "boolean", default: false },
    "large-results": { type: "boolean", default: false },
  },
});
const requestCount = Number(values.requests);
assert(["timing", "allocation", "counts", "profile"].includes(values.mode));
assert(Number.isSafeInteger(requestCount) && requestCount >= 2);
assert(global.gc, "use --expose-gc");
const scans = { calls: 0, chars: 0 };
const scanLengths: number[] = [];
const scanOwners = new Map<string, { calls: number; chars: number }>();
const scanKey = Symbol.for("openclaw.perf.token-pressure.scan");
Reflect.set(globalThis, scanKey, (chars: number) => {
  scans.calls++;
  scans.chars += chars;
  scanLengths.push(chars);
  const owner = new Error().stack?.split("\n").slice(3, 8).join("\n") ?? "unknown";
  const value = scanOwners.get(owner) ?? { calls: 0, chars: 0 };
  value.calls++;
  value.chars += chars;
  scanOwners.set(owner, value);
});
const ownerPaths = [
  "src/agents/embedded-agent-runner/tool-result-truncation.ts",
  "src/agents/sessions/context-token-pressure.ts",
  "src/agents/embedded-agent-runner/run/preemptive-compaction.ts",
  "src/agents/sessions/compaction/request-budget.ts",
  "src/agents/embedded-agent-runner/run/attempt-setup.ts",
  "src/agents/embedded-agent-runner/run/attempt-stream.ts",
  "src/agents/embedded-agent-runner/run/attempt-prompt-submit.ts",
  "src/agents/embedded-agent-runner/run/attempt-prompt-phase.ts",
  "src/agents/embedded-agent-runner/run/attempt-prompt-preflight.ts",
  "src/agents/embedded-agent-runner/run/chatgpt-v2-compaction.ts",
];
const root = new URL("../../", import.meta.url);
const owners = new Set(ownerPaths.map((path) => new URL(path, root).href));
const cjkUrl = new URL("packages/normalization-core/src/cjk-chars.ts", root).href;
const loader = registerHooks({
  load(url, context, next) {
    if (!(values["base-dir"] && owners.has(url)) && !(values.mode === "counts" && url === cjkUrl)) {
      return next(url, context);
    }
    let source = readFileSync(
      values["base-dir"] && owners.has(url)
        ? resolve(values["base-dir"], basename(fileURLToPath(url)))
        : fileURLToPath(url),
      "utf8",
    );
    if (values.mode === "counts" && url === cjkUrl) {
      source = source.replace(
        /export function estimateStringCharsWithMinimumRawWeight\([\s\S]*?\): number \{/,
        (signature) =>
          `${signature}\n globalThis[Symbol.for("openclaw.perf.token-pressure.scan")](text.length);`,
      );
    }
    return { format: "module", source: stripTypeScriptTypes(source), shortCircuit: true };
  },
});
const [
  { createAssistantMessageEventStream },
  { Type },
  { createAgentSession },
  { SessionManager },
  { SettingsManager },
  { AuthStorage },
  { ModelRegistry },
  { DefaultResourceLoader },
  { installEmbeddedAttemptContextGuards },
  { installEmbeddedAttemptStreamGuards },
  { submitEmbeddedAttemptPrompt },
  { createToolResultPromptProjectionState },
  { createCompactionRequestBudget },
  { createDiagnosticEmbeddedRunOwner },
  { createDiagnosticTraceContext },
  { createStageTimingTracker },
  { createEmbeddedModelState },
] = await Promise.all([
  import("../../src/llm/utils/event-stream.js"),
  import("typebox"),
  import("../../src/agents/sessions/sdk.js"),
  import("../../src/agents/sessions/session-manager.js"),
  import("../../src/agents/sessions/settings-manager.js"),
  import("../../src/agents/sessions/auth-storage.js"),
  import("../../src/agents/sessions/model-registry.js"),
  import("../../src/agents/sessions/resource-loader.js"),
  import("../../src/agents/embedded-agent-runner/run/attempt-setup.js"),
  import("../../src/agents/embedded-agent-runner/run/attempt-stream.js"),
  import("../../src/agents/embedded-agent-runner/run/attempt-prompt-submit.js"),
  import("../../src/agents/embedded-agent-runner/session-prompt-state.js"),
  import("../../src/agents/sessions/compaction/request-budget.js"),
  import("../../src/logging/diagnostic-run-activity.js"),
  import("../../src/infra/diagnostic-trace-context.js"),
  import("../../src/shared/stage-timing.js"),
  import("../../src/agents/embedded-agent-subscribe.model-state.js"),
]);
loader.deregister();
const { getPublishedRuntimeToolInputSchema } = await import("@openclaw/ai/internal/tool-schema");
const noop = () => {};
const contextTokenBudget = values["large-results"] ? 10_000_000 : 1_000_000;
const model: Model = {
  id: "synthetic-pressure",
  name: "Synthetic pressure",
  api: "openai-responses",
  provider: "synthetic",
  baseUrl: "http://127.0.0.1:49999",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: contextTokenBudget,
  maxTokens: 4096,
};
const systemPrompt = "Inspect source evidence. 保持上下文。 Report exact identifiers.\n".repeat(
  700,
);
const sourceText = "const value = inspect(input); // 中文证据 한국어 カタカナ\n".repeat(
  values["large-results"] ? 24_000 : 90,
);
const pendingText = "New source evidence 中文工具结果. value = 12345;\n".repeat(
  values["large-results"] ? 24_000 : 120,
);
function assistant(round: number, tool: boolean): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: tool
      ? [
          { type: "text", text: `Inspecting source ${round}. 检查。` },
          {
            type: "toolCall",
            id: `read-${round}`,
            name: "read_0",
            arguments: { path: `src/file-${round}.ts` },
          },
        ]
      : [{ type: "text", text: "Evidence received. 完成。" }],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      contextUsage: { state: "unavailable" },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: tool ? "toolUse" : "stop",
    timestamp: round,
  };
}
const sessionManager = SessionManager.inMemory();
for (let round = 0; round < 120; round++) {
  const content: Extract<AgentMessage, { role: "user" }>["content"] =
    round % 20 === 0
      ? [
          { type: "text", text: `Inspect source ${round}.` },
          {
            type: "image",
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVJ8AAAAASUVORK5CYII=",
          },
        ]
      : `Inspect source ${round}.`;
  await sessionManager.appendMessageAsync({ role: "user", content, timestamp: round });
  await sessionManager.appendMessageAsync(assistant(round, true));
  await sessionManager.appendMessageAsync({
    role: "toolResult",
    toolName: "read_0",
    toolCallId: `read-${round}`,
    content: [{ type: "text", text: `${sourceText}// file ${round}` }],
    isError: false,
    timestamp: round,
  });
}
let initialMessages = 360;
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false, reserveTokens: 20_000 },
  retry: { enabled: false },
});
const authStorage = AuthStorage.inMemory();
authStorage.setRuntimeApiKey(model.provider, "synthetic-key");
const modelRegistry = ModelRegistry.inMemory(authStorage);
const resourceLoader = new DefaultResourceLoader({
  cwd: "/synthetic-pressure",
  agentDir: "/synthetic-pressure/agent",
  extensionFactories: [],
});
await resourceLoader.reload();
const rawTools = Array.from({ length: 100 }, (_, index) => ({
  name: `read_${index}`,
  label: `Read ${index}`,
  description: `Read source evidence ${index}. 返回证据。 ${"Repository source documentation. ".repeat(12)}`,
  parameters: Type.Object({
    path: Type.String(),
    ...Object.fromEntries(
      Array.from({ length: 12 }, (_value, field) => [
        `option_${field}`,
        Type.Optional(
          Type.String({ description: "Optional source selection. 选择源文件。 ".repeat(4) }),
        ),
      ]),
    ),
  }),
  execute: async () => ({ content: [{ type: "text" as const, text: pendingText }], details: {} }),
}));
const { finalizeAgentTools } = await import("../../src/agents/agent-tools.finalize.js");
const customTools = values["mutable-tools"]
  ? rawTools
  : finalizeAgentTools({ tools: rawTools, hookContext: {}, wrapBeforeToolCallHook: false });
const { session } = await createAgentSession({
  model,
  systemPrompt,
  thinkingLevel: "off",
  sessionManager,
  settingsManager,
  modelRegistry,
  resourceLoader,
  tools: customTools.map(({ name }) => name),
  customTools,
  contextOverflowRecoveryOwner: "caller",
  cleanupProviderSessionResourcesOnDispose: false,
});
const attempt = {
  config: {
    agents: { defaults: { compaction: { enabled: false, midTurnPrecheck: { enabled: true } } } },
  },
  model,
  modelId: model.id,
  provider: model.provider,
  contextTokenBudget,
  runId: "synthetic-pressure-run",
  sessionId: session.sessionId,
  sessionKey: "agent:synthetic:pressure",
  timeoutMs: 120_000,
  workspaceDir: "/synthetic-pressure",
  prompt: "Inspect the next files.",
};
const projectionState = createToolResultPromptProjectionState();
const contextGuards = installEmbeddedAttemptContextGuards({
  activeSession: session,
  agentDir: "/synthetic-pressure/agent",
  // Prepared auth/admission resources are unused by this in-memory boundary replay.
  attempt: attempt as Parameters<typeof installEmbeddedAttemptContextGuards>[0]["attempt"],
  computerContextEpoch: { value: 0 },
  dropThinkingBlocksForEstimate: false,
  effectiveCwd: "/synthetic-pressure",
  effectiveFsWorkspaceOnly: true,
  effectiveWorkspace: "/synthetic-pressure",
  getPrePromptMessageCount: () => initialMessages,
  getPromptCache: () => undefined,
  getPromptCacheRetention: () => "none",
  getCompactionReplayEnabled: () => false,
  getServerToolClearingEnabled: () => false,
  toolResultPromptProjectionState: projectionState,
  getSystemPrompt: () => systemPrompt,
  isOpenAIResponsesApi: true,
  repairToolUseResultPairing: false,
  sessionAgentId: "synthetic",
  sessionManager,
  settingsManager,
});
let requestIndex = 0;
let warming = true;
const requestHistories: Message[][] = [];
const pressures: number[] = [];
const budgets: number[] = [];
const requestScans: Array<{ calls: number; chars: number; lengths: number[] }> = [];
const requestMs: number[] = [];
let requestStarted = 0;
let previousScans = { calls: 0, chars: 0 };
session.agent.streamFn = (_model, context) => {
  requestHistories.push(context.messages);
  requestMs.push(performance.now() - requestStarted);
  requestScans.push({
    calls: scans.calls - previousScans.calls,
    chars: scans.chars - previousScans.chars,
    lengths: scanLengths.splice(0),
  });
  previousScans = { ...scans };
  const message = assistant(1_000 + requestIndex, ++requestIndex < requestCount && !warming);
  const stream = createAssistantMessageEventStream();
  stream.push({
    type: "done",
    reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
    message,
  });
  stream.end(message);
  return stream;
};
// The guard installers consume prepared attempt facts; real session/tool state remains owned by AgentSession.
const input = {
  attempt,
  runAbortController: new AbortController(),
  prepared: {
    sessionRuntime: {
      agentSession: { activeSession: session },
      contextGuards,
      sessionManager,
      anthropicPayloadLogger: null,
      cacheTrace: null,
      isOpenAIResponsesApi: true,
      state: { systemPromptText: systemPrompt },
      transcriptPolicy: {},
      transport: {
        effectiveAgentTransport: "sse",
        effectivePromptCacheRetention: "none",
        compactionReplayEnabled: false,
      },
    },
    toolCatalog: {
      toolSearchRunPlan: {
        liveAllowedToolNames: new Set(customTools.map(({ name }) => name)),
        replayAllowedToolNames: new Set(customTools.map(({ name }) => name)),
      },
    },
  },
  setup: {
    sessionAgentId: "synthetic",
    prepStages: createStageTimingTracker(() => 0),
    emitPrepStageSummary: noop,
  },
  diagnostics: { runTrace: createDiagnosticTraceContext() },
  lifecycle: { readYieldState: () => ({ yieldDetected: false }) },
} as unknown as EmbeddedAttemptExecutionPhaseInput;
const guardedCheck = contextGuards.checkMidTurnPrecheck;
contextGuards.checkMidTurnPrecheck = async (request) => {
  const pressure = await guardedCheck(request);
  pressures.push(pressure);
  return pressure;
};
const streamGuards = installEmbeddedAttemptStreamGuards(input, {
  onRejectedProviderReplayRepaired: () => assert.fail("unexpected replay repair"),
  onIdleTimeout: (error) => {
    throw error;
  },
  diagnosticOwner: createDiagnosticEmbeddedRunOwner(attempt),
});
const modelState = createEmbeddedModelState(
  { session, runId: attempt.runId, onModelUsage: streamGuards.onModelUsage },
  { warn: noop },
);
const unsubscribe = session.subscribe((event) => {
  if (
    event.type === "message_start" ||
    event.type === "message_update" ||
    event.type === "message_end"
  ) {
    modelState.captureModelEvent(event);
  }
});
// Match each revision's foreground preparation composition; all estimates come from production owners.
const tokenPressure = await import("../../src/agents/sessions/context-token-pressure.js");
const estimateFixed =
  typeof tokenPressure.createFixedRequestTokenEstimator === "function"
    ? tokenPressure.createFixedRequestTokenEstimator()
    : undefined;
const toolObservations: object[] = [];
let previousTools: unknown;
let previousParameters: unknown;
const observeTools = (context: Parameters<typeof streamGuards.onModelRequest>[1]) => {
  if (values.mode === "counts" && toolObservations.length < 4) {
    const parameters = context.tools?.[0]?.parameters;
    toolObservations.push({
      sameSet: previousTools === context.tools,
      sameParameters: previousParameters === parameters,
      frozenParameters: Object.isFrozen(parameters),
      publishedParameters: Boolean(getPublishedRuntimeToolInputSchema(parameters)),
    });
    previousTools = context.tools;
    previousParameters = parameters;
  }
};
const prepareRequestTokenPressure = estimateFixed
  ? (context: Parameters<typeof streamGuards.onModelRequest>[1]) => {
      requestStarted = performance.now();
      observeTools(context);
      const fixedTokenPressure = estimateFixed(context);
      budgets.push(
        createCompactionRequestBudget({
          contextWindow: contextTokenBudget,
          reserveTokens: 20_000,
          fixedTokenPressure,
        }).fixedTokens,
      );
      return fixedTokenPressure;
    }
  : undefined;
if (!prepareRequestTokenPressure) {
  const provider = session.agent.streamFn;
  session.agent.streamFn = (activeModel, context, options) => {
    observeTools(context);
    budgets.push(
      createCompactionRequestBudget({
        contextWindow: contextTokenBudget,
        reserveTokens: 20_000,
        systemPrompt: context.systemPrompt,
        tools: context.tools,
      }).fixedTokens,
    );
    return provider(activeModel, context, options);
  };
}
async function replay() {
  const compactionRequestBudget = createCompactionRequestBudget({
    contextWindow: contextTokenBudget,
    reserveTokens: 20_000,
    systemPrompt,
    tools: session.agent.state.tools,
    pendingPrompt: attempt.prompt,
    fixedTokenPressure: estimateFixed?.({ systemPrompt, tools: session.agent.state.tools }),
  });
  await submitEmbeddedAttemptPrompt({
    attempt,
    activeSession: session,
    contextTokenBudget,
    compactionRequestBudget,
    images: [],
    modelPrompt: attempt.prompt,
    transcriptPrompt: attempt.prompt,
    runtimeOnly: false,
    systemPrompt,
    toolResultMaxChars: 100_000,
    toolResultAggregateMaxChars: 4_000_000,
    toolResultPromptProjectionState: projectionState,
    trajectoryRecorder: null,
    transcriptLeafId: null,
    onFinalPromptText: noop,
    persistToolResultProjections: async () => {},
    prepareRequestTokenPressure,
    onModelRequest: async (...args) => {
      if (!prepareRequestTokenPressure) {
        requestStarted = performance.now();
      }
      return streamGuards.onModelRequest(...args);
    },
    normalizeToolCallIds: streamGuards.normalizeToolCallIds,
    promptActiveSession: (prompt, options) => session.prompt(prompt, options),
  });
}
await replay();
const coldScans = { ...scans };
initialMessages = session.messages.length;
warming = false;
requestIndex = 0;
requestHistories.length = 0;
pressures.length = 0;
budgets.length = 0;
requestScans.length = 0;
requestMs.length = 0;
previousScans = { calls: 0, chars: 0 };
global.gc();
const inspector = ["allocation", "profile"].includes(values.mode) ? new Session() : undefined;
if (inspector) {
  inspector.connect();
  if (values.mode === "profile") {
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.setSamplingInterval", { interval: 100 });
    await inspector.post("Profiler.start");
  } else {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4_096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
}
scans.calls = 0;
scans.chars = 0;
scanLengths.length = 0;
scanOwners.clear();
const cpuStart = process.cpuUsage();
const mainStart = process.threadCpuUsage();
const started = performance.now();
const hostLoad = loadavg();
try {
  await replay();
  assert.equal(requestIndex, requestCount);
  assert.equal(pressures.length, requestCount);
  assert(pressures[0]! >= 100_000, "fixture must exceed 100k estimated tokens");
  assert.equal(contextGuards.takePendingMidTurnPrecheckRequest(), null);
  if (values.mode === "counts" && !values["base-dir"] && !values["mutable-tools"]) {
    // Two requests warm projections of the initial history and first appended result.
    const tail = requestScans.slice(2);
    assert(
      tail.every(({ chars }) => chars < pendingText.length * 4 + 10_000),
      "steady requests must scan only appended text and its truncation slices",
    );
    assert(new Set(tail.map(({ chars }) => chars)).size <= 1, "scan work must stay constant");
  }
} finally {
  unsubscribe();
  contextGuards.remove();
  session.dispose();
}
const elapsedMs = performance.now() - started;
const cpu = process.cpuUsage(cpuStart);
const mainCpu = process.threadCpuUsage(mainStart);
let sampledBytes: number | undefined;
if (inspector) {
  if (values.mode === "profile") {
    const { profile } = await inspector.post("Profiler.stop");
    if (values.output) {
      writeFileSync(`${values.output}.cpuprofile`, JSON.stringify(profile));
    }
  } else {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledBytes = sumSampledHeapBytes(profile.head);
    if (values.output) {
      writeFileSync(`${values.output}.heapprofile`, JSON.stringify(profile));
    }
  }
  inspector.disconnect();
}
const sortedMs = requestMs.toSorted((a, b) => a - b);
const result = {
  mode: values.mode,
  arm: values["base-dir"] ? "base" : "candidate",
  requestCount,
  initialMessages,
  tools: 100,
  mutableTools: values["mutable-tools"],
  initialPressure: pressures[0],
  finalPressure: pressures.at(-1),
  projectionHash: createHash("sha256")
    .update(
      JSON.stringify(
        requestHistories.map((messages) =>
          messages.map(({ role, content }) => ({ role, content })),
        ),
      ),
    )
    .digest("hex"),
  estimateHash: createHash("sha256").update(JSON.stringify({ pressures, budgets })).digest("hex"),
  pressures,
  budgets,
  elapsedMs,
  cpuMs: (cpu.user + cpu.system) / 1000,
  mainCpuMs: (mainCpu.user + mainCpu.system) / 1000,
  cpuMsPerRequest: (mainCpu.user + mainCpu.system) / 1000 / requestCount,
  boundaryP50Ms: sortedMs[Math.floor(sortedMs.length * 0.5)],
  boundaryP95Ms: sortedMs[Math.floor(sortedMs.length * 0.95)],
  sampledBytes,
  bytesPerRequest: sampledBytes === undefined ? undefined : sampledBytes / requestCount,
  coldScans: values.mode === "counts" ? coldScans : undefined,
  scans: values.mode === "counts" ? scans : undefined,
  requestScans: values.mode === "counts" ? requestScans : undefined,
  scanOwners:
    values.mode === "counts"
      ? Array.from(scanOwners, ([owner, counts]) => ({ owner, ...counts })).toSorted(
          (a, b) => b.chars - a.chars,
        )
      : undefined,
  toolObservations: values.mode === "counts" ? toolObservations : undefined,
  hostLoad,
  proofScope:
    "Real AgentSession/tool loop and attempt submit/stream/context-guard path; synthetic provider, in-memory transcript, prepared setup facts; no Gateway or network.",
};
if (values.output) {
  writeFileSync(values.output, JSON.stringify(result, null, 2));
}
const {
  pressures: _pressures,
  budgets: _budgets,
  requestScans: _requestScans,
  scanOwners: _scanOwners,
  ...summary
} = result;
console.log(JSON.stringify(summary));
