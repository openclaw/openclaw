import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  writeSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as immediate, setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { startQaBusServer, createQaBusState } from "../extensions/qa-lab/bus-api.ts";
import type { AnyAgentTool } from "../src/agents/agent-tools.types.js";
import type { ToolHandlerContext } from "../src/agents/embedded-agent-subscribe.handlers.types.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { applyMockOpenAiModelConfig } from "./e2e/lib/fixtures/mock-openai-config.mjs";
import { stopChild } from "./lib/gateway-bench-child.ts";
import { getFreePort } from "./lib/gateway-bench-probes.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  waitForInitialProbe,
  writeGatewayBenchConfig,
} from "./lib/gateway-bench-runtime.ts";
const { values } = parseArgs({
  options: {
    entry: { type: "string", default: "dist/entry.js" },
    help: { type: "boolean", short: "h" },
    "tool-invocations": { type: "boolean", default: false },
    "tool-argument-bytes": { type: "string", default: "65536" },
    "tool-progress-events": { type: "string", default: "500" },
    "tool-calls": { type: "string", default: "200" },
    "tool-samples": { type: "string", default: "5" },
    "tool-start-file": { type: "string" },
    "tool-interval-ms": { type: "string", default: "100" },
    "tool-gc-log": { type: "string" },
  },
});
if (values.help) {
  console.log(
    "Usage: node --import ./scripts/tsx.mjs scripts/bench-channel-turn.mts [--entry dist/entry.js]\nRuns one cold and ten warmed QA-channel turns with an isolated local mock provider.\nOr use --tool-invocations [--tool-argument-bytes 65536] [--tool-progress-events 500] [--tool-calls 200] [--tool-samples 5] [--tool-interval-ms 100] --tool-gc-log <stdout-log> with --expose-gc --trace-gc-nvp, redirecting stdout to that log, for real tool-owner allocation, promotion, GC and latency measurements without a Gateway.",
  );
  process.exit(0);
}
if (values["tool-invocations"]) {
  await measureToolInvocations();
  process.exit(0);
}
const output = mkdtempSync(path.join(tmpdir(), "sqlmeasure-channel-"));
const fixture = path.join(output, "fixture");
mkdirSync(fixture);
type TurnIdentity = { phase: string; turnId: string };
type TurnEvidence = TurnIdentity & {
  key: string;
  messageId: string;
  firstOutboundMs: number;
  result: { status: "ok" };
  outboundId: string;
};
const evidence: {
  output: string;
  harnessVersion: string;
  phases: { phase: string; start: number; end: number }[];
  turns: TurnEvidence[];
  children: { name: string; pid: number }[];
  ports?: { port: number; mockPort: number };
  ready?: unknown;
  shutdown?: [number | null, NodeJS.Signals | null];
  bus?: unknown;
  ok?: boolean;
  error?: string;
} = {
  output,
  harnessVersion: "2.0.0-channel.1",
  phases: [],
  turns: [],
  children: [],
};
const children: ChildProcess[] = [];
const traces: Record<string, TurnIdentity> = {};
const messages: Record<string, TurnIdentity> = {};
let phase = "01.boot";
let phaseStart = Date.now();
let bus: Awaited<ReturnType<typeof startQaBusServer>> | undefined;
let gateway: ChildProcess | undefined;
let interrupted = false;
let cleanupPromise: Promise<void> | undefined;
function save() {
  writeFileSync(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
}
function cleanup() {
  return (cleanupPromise ??= (async () => {
    try {
      await Promise.all(
        children.map((child) => stopChild(child, { teardownGraceMs: 10000, killGraceMs: 2000 })),
      );
    } finally {
      await bus?.stop();
      evidence.phases.push({ phase, start: phaseStart, end: Date.now() });
      save();
    }
  })());
}
function interrupt(signal: "SIGINT" | "SIGTERM") {
  if (interrupted) {
    return;
  }
  interrupted = true;
  evidence.ok = false;
  evidence.error = `Interrupted by ${signal}`;
  void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
}
const onSigint = () => interrupt("SIGINT");
const onSigterm = () => interrupt("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
function setPhase(next: string) {
  evidence.phases.push({ phase, start: phaseStart, end: Date.now() });
  phase = next;
  phaseStart = Date.now();
  writeFileSync(path.join(output, "phase.new"), phase);
  renameSync(path.join(output, "phase.new"), path.join(output, "phase"));
  console.log("PHASE", phase);
  save();
}
function launch(args: string[], env: NodeJS.ProcessEnv, name: string) {
  if (interrupted) {
    throw new Error("Benchmark interrupted");
  }
  const out = createWriteStream(path.join(output, name + ".log"));
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
  children.push(child);
  if (child.pid === undefined) {
    throw new Error(`Failed to spawn ${name}`);
  }
  evidence.children.push({ name, pid: child.pid });
  save();
  return child;
}
function publish(file: string, value: unknown) {
  const target = path.join(output, file);
  writeFileSync(target + ".new", JSON.stringify(value));
  renameSync(target + ".new", target);
}
writeFileSync(path.join(output, "phase"), phase);
console.log("OUTPUT", output);
try {
  const port = await getFreePort();
  const mockPort = await getFreePort();
  evidence.ports = { port, mockPort };
  const state = createQaBusState();
  bus = await startQaBusServer({ state });
  const cfg: OpenClawConfig = structuredClone(BASE_GATEWAY_BENCH_CONFIG);
  cfg.tools = { codeMode: false };
  applyMockOpenAiModelConfig(cfg, { mockPort, modelRef: "openai/gpt-4.1" });
  cfg.agents = {
    ...cfg.agents,
    defaults: { ...cfg.agents?.defaults, skipBootstrap: true },
  };
  cfg.agents.entries = { main: { workspace: path.join(fixture, "workspace") } };
  mkdirSync(path.join(fixture, "workspace"));
  cfg.plugins = {
    ...cfg.plugins,
    entries: {
      ...cfg.plugins?.entries,
      "memory-core": { config: { dreaming: { enabled: false } } },
      "qa-channel": { enabled: true },
    },
  };
  cfg.channels = {
    "qa-channel": { enabled: true, baseUrl: bus.baseUrl, allowFrom: ["*"], pollTimeoutMs: 100 },
  };
  const configPath = writeGatewayBenchConfig(fixture, cfg, {});
  const control = path.join(output, "mock-control.json");
  publish("channel-turns.json", messages);
  publish("trace-map.json", traces);
  launch(
    ["scripts/e2e/mock-openai-server.mjs"],
    {
      PATH: process.env.PATH,
      HOME: fixture,
      MOCK_PORT: String(mockPort),
      MOCK_RESPONSE_CONTROL: control,
      MOCK_REQUEST_LOG: path.join(output, "provider-requests.jsonl"),
    },
    "mock",
  );
  const mockReady = await waitForInitialProbe({
    port: mockPort,
    path: "/health",
    startAt: performance.now(),
    deadlineAt: performance.now() + 30000,
  });
  if (mockReady.status !== 200) {
    throw new Error("Mock provider not ready");
  }
  gateway = launch(
    buildGatewayBenchChildArgs(values.entry, port),
    {
      ...createGatewayBenchEnv(fixture, configPath, { caseEnv: {} }),
      OPENAI_API_KEY: "synthetic-sqlmeasure-fixture",
      SQLMEASURE_OUT: output,
      NODE_OPTIONS: process.env.OPENCLAW_CHANNEL_BENCH_NODE_OPTIONS ?? "--enable-source-maps",
    },
    "gateway",
  );
  const ready = await waitForInitialProbe({
    port,
    path: "/readyz",
    startAt: performance.now(),
    deadlineAt: performance.now() + 300000,
    isDone: () => gateway != null && (gateway.exitCode !== null || gateway.signalCode !== null),
  });
  evidence.ready = ready;
  if (ready.status !== 200) {
    throw new Error("Gateway not ready");
  }
  await delay(1000);
  for (let i = 0; i <= 10; i++) {
    setPhase(i === 0 ? "02.first-turn" : `03.turn-${String(i).padStart(2, "0")}`);
    const turnId = createHash("sha256").update(phase).digest("hex").slice(0, 32);
    const messageId = `sqlmeasure-${i}`;
    traces[turnId] = { phase, turnId };
    messages[messageId] = { phase, turnId };
    publish("trace-map.json", traces);
    publish("channel-turns.json", messages);
    const reply = `Synthetic channel measurement response ${i}. The Gateway receives this streamed answer from the local mock provider and delivers it to the isolated QA bus.`;
    publish("mock-control.json", { text: reply, chunkDelayMs: 5 });
    const start = Date.now();
    const cursor = state.getSnapshot().cursor;
    const firstOutbound = state
      .waitForCursorAdvance(cursor, 180000, (snapshot) =>
        snapshot.messages.some(
          (message) => message.direction === "outbound" && message.replyToId === messageId,
        ),
      )
      .then(() => Date.now() - start);
    void firstOutbound.catch(() => {});
    state.addInboundMessage(
      {
        accountId: "default",
        conversation: { kind: "direct", id: "sqlmeasure-peer" },
        senderId: "sqlmeasure-user",
        senderName: "SQL measurement",
        text: `Please give a short synthetic status report for measurement turn ${i}.`,
        timestamp: 1800000000000 + i,
      },
      messageId,
    );
    const inboundCursor = state.getSnapshot().cursor;
    await state.waitFor({
      kind: "message-text",
      direction: "outbound",
      textIncludes: reply,
      timeoutMs: 180000,
    });
    const firstOutboundMs = await firstOutbound;
    // The poll acknowledgement follows dispatch, preview cleanup and receipt settlement.
    const deadline = Date.now() + 180000;
    while (state.getAcknowledgedPollCursor("default") < inboundCursor) {
      if (gateway.exitCode !== null || gateway.signalCode !== null) {
        throw new Error("Gateway exited during turn");
      }
      if (Date.now() >= deadline) {
        throw new Error("Inbound dispatch did not settle");
      }
      await delay(50);
    }
    const result = state
      .getSnapshot()
      .messages.find(
        (message) =>
          message.direction === "outbound" &&
          message.replyToId === messageId &&
          message.text === reply &&
          !message.deleted &&
          !message.isError,
      );
    if (!result) {
      throw new Error("No durable outbound reply after dispatch settled");
    }
    evidence.turns.push({
      phase,
      key: "qa-channel:sqlmeasure-peer",
      turnId,
      messageId,
      firstOutboundMs,
      result: { status: "ok" },
      outboundId: result.id,
    });
    save();
    await delay(1000);
  }
  setPhase("08.shutdown");
  const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    gateway?.once("close", (code, signal) => resolve([code, signal]));
  });
  gateway.kill("SIGTERM");
  evidence.shutdown = await Promise.race<[number | null, NodeJS.Signals | null]>([
    closed,
    delay(120000, undefined, { ref: false }).then(() => {
      throw new Error("shutdown timeout");
    }),
  ]);
  evidence.bus = state.getSnapshot();
  evidence.ok = evidence.turns.length === 11 && evidence.shutdown[0] === 0;
  setPhase("done");
  console.log("COMPLETE", output, "ok=" + evidence.ok);
  if (!evidence.ok) {
    process.exitCode = 1;
  }
} catch (error) {
  evidence.error = String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await cleanup();
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}

/** Measures custody and progress through the real wrapper, harness and subscription handler. */
async function measureToolInvocations() {
  const integerOption = (
    name:
      | "tool-argument-bytes"
      | "tool-progress-events"
      | "tool-calls"
      | "tool-samples"
      | "tool-interval-ms",
    minimum = 1,
  ) => {
    const value = Number(values[name]);
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Error(`--${name} must be an integer >= ${minimum}`);
    }
    return value;
  };
  const argumentBytes = integerOption("tool-argument-bytes");
  const progressEvents = integerOption("tool-progress-events", 0);
  const calls = integerOption("tool-calls");
  const sampleCount = integerOption("tool-samples");
  const intervalMs = integerOption("tool-interval-ms");
  const gcLog = values["tool-gc-log"];
  if (!globalThis.gc) {
    throw new Error("--tool-invocations requires node --expose-gc");
  }
  if (!gcLog || !process.execArgv.includes("--trace-gc-nvp")) {
    throw new Error("--tool-invocations requires --trace-gc-nvp and --tool-gc-log <stdout-log>");
  }
  // Source imports and fixture construction are deliberately outside all sampling windows.
  const [
    { Session },
    { Type },
    { isRecord },
    { wrapToolWithBeforeToolCallHook },
    { finalizeToolTerminalPresentation },
    { peekAdjustedParamsForToolCall },
    { createAgentHarnessToolExecutionBoundaryRegistry },
    { runAgentHarnessToolInvocation },
    { handleToolExecutionUpdate },
    { EmbeddedAgentSubscribeState },
    { createToolTerminalObserver },
    { setToolTerminalPresentation },
    { startGatewayBenchDiagnostics },
    { GATEWAY_GC_TRACE_MARKER, readGatewayGcTrace },
  ] = await Promise.all([
    import("node:inspector/promises"),
    import("typebox"),
    import("@openclaw/normalization-core/record-coerce"),
    import("../src/agents/agent-tools.before-tool-call.wrapper.js"),
    import("../src/agents/agent-tools.before-tool-call.diagnostics.js"),
    import("../src/agents/agent-tools.before-tool-call.state.js"),
    import("../src/agents/harness/tool-execution.js"),
    import("../src/agents/harness/tool-invocation.js"),
    import("../src/agents/embedded-agent-subscribe.handlers.tools.progress.js"),
    import("../src/agents/embedded-agent-subscribe.run-state.js"),
    import("../src/agents/tool-terminal-outcome.js"),
    import("../src/agents/tool-terminal-presentation.js"),
    import("./lib/gateway-bench-diagnostics.ts"),
    import("./lib/gateway-bench-profile.ts"),
  ]);
  const toolOutput = mkdtempSync(path.join(tmpdir(), "tool-invocations-"));
  const runId = `tool-invocation-benchmark-${process.pid}`;
  const boundaries = createAgentHarnessToolExecutionBoundaryRegistry();
  const observeTerminal = createToolTerminalObserver(runId);
  const toolFixture = {
    benchmarkArgument: true,
    mutation: { executor: false, middleware: false },
    payload: {
      rows: Array.from({ length: Math.ceil(argumentBytes / 1024) }, (_, index) => ({
        index,
        text: "x".repeat(1024),
      })),
    },
  };
  const fixtureJson = JSON.stringify(toolFixture);
  const mutationOf = (args: unknown) => {
    if (!isRecord(args) || !isRecord(args.mutation)) {
      throw new Error("Synthetic tool received malformed nested arguments");
    }
    return args.mutation;
  };
  let updates = 0;
  let presentations = 0;
  let nextCall = 0;
  const noop = () => {};
  const ctx: ToolHandlerContext = {
    params: {
      runId,
      onAgentEvent(event) {
        if (event.stream === "item" && event.data.phase === "update") {
          updates += 1;
        }
      },
    },
    state: new EmbeddedAgentSubscribeState({}),
    log: { debug: noop, info: noop, warn: console.warn },
    flushBlockReplyBuffer: noop,
    shouldEmitToolResult: () => false,
    shouldEmitToolOutput: () => false,
    emitToolSummary: noop,
    emitToolOutput: noop,
    trimMessagingToolSent: noop,
  };
  const source: AnyAgentTool = {
    name: "synthetic_stream",
    label: "Synthetic stream",
    description: "Emit synthetic progress for allocation measurement.",
    parameters: Type.Object({}, { additionalProperties: true }),
    async execute(toolCallId, args) {
      // Real tools may mutate their inputs; snapshots must neither alias nor freeze them.
      mutationOf(args).executor = true;
      for (let index = 0; index < progressEvents; index++) {
        handleToolExecutionUpdate(ctx, {
          type: "tool_execution_update",
          toolName: source.name,
          toolCallId,
          args,
          partialResult: { content: [{ type: "text", text: `progress ${index}` }], details: {} },
        });
      }
      return { content: [{ type: "text", text: "synthetic tool completed" }], details: {} };
    },
  };
  setToolTerminalPresentation(source, (args) => {
    const mutation = mutationOf(args);
    if (mutation.executor !== true || mutation.middleware !== false) {
      throw new Error("Terminal formatter lost its post-execution argument snapshot");
    }
    return { text: "synthetic terminal verified" };
  });
  const tool = wrapToolWithBeforeToolCallHook(
    source,
    {
      runId,
      onToolOutcome: (outcome) => {
        if (
          outcome.presentationOnly &&
          outcome.terminalPresentation === "synthetic terminal verified"
        ) {
          presentations += 1;
        }
      },
    },
    { emitDiagnostics: false },
  );
  const invoke = async () => {
    const toolCallId = `synthetic-call-${nextCall++}`;
    const args: unknown = JSON.parse(fixtureJson);
    const previousUpdates = updates;
    const previousPresentations = presentations;
    await runAgentHarnessToolInvocation({
      tool,
      call: { toolCallId, toolName: source.name, arguments: args },
      runId,
      signal: new AbortController().signal,
      boundaries,
      retainExecutionSnapshot: true,
      applyMiddleware: async (event) => {
        mutationOf(event.args).middleware = true;
        return event.result;
      },
      onResult: (execution) => {
        const mutation = mutationOf(execution.executedArguments);
        if (mutation.executor !== false || mutation.middleware !== false) {
          throw new Error("Executed argument snapshot aliases mutable tool or middleware input");
        }
        observeTerminal({
          toolCallId,
          toolName: source.name,
          arguments: execution.executedArguments,
          result: execution.result,
          outcome: "success",
          executionStarted: execution.boundary.executionStarted,
        });
        finalizeToolTerminalPresentation({
          toolCallId,
          runId,
          result: execution.result,
          isError: execution.isError,
        });
      },
      onError: ({ error }) => {
        throw error;
      },
    });
    const snapshot = boundaries.consume(toolCallId);
    const mutation = mutationOf(args);
    if (
      !snapshot?.executionStarted ||
      peekAdjustedParamsForToolCall(toolCallId, runId) !== undefined ||
      mutation.executor !== true ||
      mutation.middleware !== false ||
      updates - previousUpdates !== progressEvents ||
      presentations - previousPresentations !== 1
    ) {
      throw new Error("Tool invocation, progress, presentation, or cleanup invariant failed");
    }
  };
  const inspector = new Session();
  inspector.connect();
  const markGc = (samplePhase: string, profilePath?: string) => {
    writeSync(
      1,
      `${GATEWAY_GC_TRACE_MARKER}${JSON.stringify({ phase: samplePhase, pid: process.pid, profilePath })}\n`,
    );
  };
  const originalClone = globalThis.structuredClone;
  let clones = 0;
  let argumentClones = 0;
  const percentile = (numbers: number[], fraction: number) =>
    numbers.toSorted((a, b) => a - b)[Math.ceil(numbers.length * fraction) - 1]!;
  const sample = async (samplePhase: string, count: number, cadenceMs: number) => {
    const profilePath = path.join(toolOutput, `${samplePhase}.heapprofile`);
    globalThis.gc?.();
    await delay(0);
    clones = 0;
    argumentClones = 0;
    const startFile = values["tool-start-file"];
    if (samplePhase === "warm-0" && startFile) {
      // Release both prepared processes with the same future capture timestamp.
      writeFileSync(`${startFile}.${process.pid}.ready`, "ready");
      const deadline = Date.now() + 120000;
      while (!existsSync(startFile)) {
        if (Date.now() > deadline) {
          throw new Error("Timed out waiting for the paired measurement barrier");
        }
        await delay(10);
      }
      const startAt = Number(readFileSync(startFile, "utf8"));
      if (!Number.isSafeInteger(startAt) || startAt < Date.now()) {
        throw new Error("Paired measurement barrier needs a future Unix timestamp in milliseconds");
      }
      await delay(startAt - Date.now());
    }
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const durations: number[] = [];
    let overCadenceCalls = 0;
    let lateStarts = 0;
    let maxStartLatenessMs = 0;
    globalThis.structuredClone = (value, options) => {
      clones += 1;
      if (isRecord(value) && value.benchmarkArgument === true) {
        argumentClones += 1;
      }
      return originalClone(value, options);
    };
    const stopDiagnostics = startGatewayBenchDiagnostics();
    markGc("heap-start", profilePath);
    const windowStart = performance.now();
    let diagnostics: ReturnType<typeof stopDiagnostics>;
    try {
      for (let index = 0; index < count; index++) {
        const scheduledAt = windowStart + index * cadenceMs;
        if (cadenceMs) {
          await delay(Math.max(0, scheduledAt - performance.now()));
        }
        const started = performance.now();
        const latenessMs = Math.max(0, started - scheduledAt);
        maxStartLatenessMs = Math.max(maxStartLatenessMs, latenessMs);
        if (cadenceMs && latenessMs >= cadenceMs) {
          lateStarts += 1;
        }
        await invoke();
        const durationMs = performance.now() - started;
        durations.push(durationMs);
        if (cadenceMs && durationMs > cadenceMs) {
          overCadenceCalls += 1;
        }
      }
      // Keep both sides at the same offered rate and drain observer callbacks naturally.
      await delay(Math.max(0, windowStart + count * cadenceMs - performance.now()));
      await immediate();
    } finally {
      diagnostics = stopDiagnostics();
      markGc("heap-stop", profilePath);
      globalThis.structuredClone = originalClone;
    }
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const trace = readGatewayGcTrace(gcLog, profilePath);
    writeFileSync(profilePath, JSON.stringify(profile));
    const nodes = [profile.head];
    let allocatedBytes = 0;
    while (nodes.length) {
      const node = nodes.pop();
      if (node) {
        allocatedBytes += node.selfSize;
        nodes.push(...node.children);
      }
    }
    return {
      phase: samplePhase,
      calls: count,
      clonesPerTool: clones / count,
      argumentClonesPerTool: argumentClones / count,
      sampledAllocatedBytesPerTool: allocatedBytes / count,
      promotedBytesPerTool: trace.promotedBytes / count,
      gcTrace: trace,
      diagnostics,
      gcSecondsPerMinute: {
        minor: ((diagnostics.gc.minorDurationMs?.total ?? 0) / diagnostics.durationMs) * 60,
        major: ((diagnostics.gc.majorDurationMs?.total ?? 0) / diagnostics.durationMs) * 60,
      },
      pacing: {
        intervalMs: cadenceMs,
        targetDurationMs: count * cadenceMs,
        overCadenceCalls,
        startsAtLeastOneIntervalLate: lateStarts,
        maxStartLatenessMs,
        skippedCalls: 0,
      },
      latencyMs: {
        median: percentile(durations, 0.5),
        p95: percentile(durations, 0.95),
        p99: percentile(durations, 0.99),
        mean: durations.reduce((sum, value) => sum + value, 0) / count,
      },
      profilePath,
    };
  };
  try {
    // Identify the main isolate once; this forced collection is outside every capture.
    markGc("identify-start");
    globalThis.gc();
    markGc("identify-stop");
    const cold = await sample("cold", 1, 0);
    for (let index = 0; index < 3; index++) {
      await invoke();
    }
    const samples = [];
    for (let index = 0; index < sampleCount; index++) {
      samples.push(await sample(`warm-${index}`, calls, intervalMs));
    }
    const result = {
      scenario: "tool-invocations",
      output: toolOutput,
      argumentBytes: Buffer.byteLength(fixtureJson),
      progressEvents,
      samplingIntervalBytes: 32768,
      includesCollectedObjects: true,
      note: "Main-isolate owner workload; imports, forced GC and profiler teardown excluded from warm captures. Tool latency excludes pacing and includes allocation sampling and clone counting. No enabled bundled plugins, Gateway RPC or provider work.",
      cold,
      samples,
      summary: {
        clonesPerTool: percentile(
          samples.map((value) => value.clonesPerTool),
          0.5,
        ),
        argumentClonesPerTool: percentile(
          samples.map((value) => value.argumentClonesPerTool),
          0.5,
        ),
        allocatedBytesPerTool: {
          median: percentile(
            samples.map((value) => value.sampledAllocatedBytesPerTool),
            0.5,
          ),
          p95: percentile(
            samples.map((value) => value.sampledAllocatedBytesPerTool),
            0.95,
          ),
        },
        latencyMs: {
          median: percentile(
            samples.map((value) => value.latencyMs.median),
            0.5,
          ),
          p95: percentile(
            samples.map((value) => value.latencyMs.p95),
            0.95,
          ),
          medianSampleP99: percentile(
            samples.map((value) => value.latencyMs.p99),
            0.5,
          ),
        },
      },
    };
    writeFileSync(path.join(toolOutput, "evidence.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    globalThis.structuredClone = originalClone;
    inspector.disconnect();
  }
}
