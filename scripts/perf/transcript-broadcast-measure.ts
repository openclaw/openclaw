import { spawn, type ChildProcess } from "node:child_process";
import { createCipheriv, createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  appendFileSync,
  createWriteStream,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { Profiler } from "node:inspector";
import path from "node:path";
import { finished } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Value } from "typebox/value";
import { rawDataToString } from "../../packages/gateway-client/src/websocket-data.ts";
import { HelloOkSchema } from "../../packages/gateway-protocol/src/schema/frames.ts";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { stripInboundMetadata } from "../../src/auto-reply/reply/strip-inbound-meta.js";
import { prepareSessionEventMetrics } from "../../src/gateway/session-event-metrics.js";
import { encodePngRgba } from "../../src/media/png-encode.js";
import { GatewaySessionRowEvents } from "../../ui/src/api/gateway-session-row-events.ts";
import { applyMockOpenAiModelConfig } from "../e2e/lib/fixtures/mock-openai-config.mjs";
import {
  readMockUserText,
  summarizeMockInferenceRequest,
} from "../e2e/lib/mock-inference-facts.ts";
import { readBody } from "../e2e/lib/mock-openai-http.mjs";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { startGatewayBenchDiagnostics } from "../lib/gateway-bench-diagnostics.ts";
import {
  GATEWAY_PROFILE_CHANNEL,
  controlGatewayProfile,
  readGatewayCpuProfile,
  readGatewayHeapProfile,
  readGatewayGcTrace,
  readGatewayCpuUsage,
  startGatewayDiagnostics,
  readGatewayResources,
  measureGatewayCpuUsage,
  measureGatewayAllocations,
} from "../lib/gateway-bench-profile.ts";
import {
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  writePluginFixtures,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    allocations: { type: "boolean", default: false },
    diagnostics: { type: "boolean", default: false },
    "prep-trace": { type: "boolean", default: false },
    "cpu-profile": { type: "boolean", default: false },
    "workload-cpu-profile": { type: "boolean", default: false },
    "capture-responses": { type: "boolean", default: false },
    "trace-gc": { type: "boolean", default: false },
    "stress-tools": { type: "boolean", default: false },
    "stress-subagents": { type: "boolean", default: false },
    "mixed-rpc": { type: "boolean", default: false },
    "stream-start-diagnostics": { type: "boolean", default: false },
    "stream-start-allocations": { type: "boolean", default: false },
    "active-work-diagnostics": { type: "boolean", default: false },
    scenario: { type: "string", default: "transcript-broadcast" },
    revision: { type: "string" },
    operations: { type: "string" },
    "rpc-concurrency": { type: "string", default: "1" },
    "reconnect-stagger-ms": { type: "string", default: "125" },
    limit: { type: "string", default: "100" },
    "row-mode": { type: "string", default: "compact" },
    entry: { type: "string", default: "dist/entry.js" },
    port: { type: "string", default: "41033" },
    "mock-port": { type: "string", default: "41034" },
    clients: { type: "string", default: "60" },
    "exact-clients": { type: "string" },
    "activity-summaries": { type: "boolean", default: false },
    "recap-burst-repeats": { type: "string", default: "0" },
    "recap-burst-interval-ms": { type: "string", default: "50" },
    runs: { type: "string", default: "20" },
    sessions: { type: "string", default: "100" },
    "history-turns": { type: "string", default: "0" },
    "seed-history": { type: "boolean", default: false },
    rounds: { type: "string", default: "5" },
    "duration-ms": { type: "string", default: "3600000" },
    "warmup-ms": { type: "string", default: "300000" },
    "round-interval-ms": { type: "string", default: "15000" },
    "memory-interval-ms": { type: "string", default: "60000" },
    "retained-profile-ms": { type: "string", default: "600000" },
    "reset-every-rounds": { type: "string", default: "20" },
    chunks: { type: "string", default: "100" },
    "chunk-interval-ms": { type: "string", default: "10" },
    "prompt-kib": { type: "string", default: "128" },
    "heap-snapshot": { type: "boolean", default: false },
    "session-census": { type: "boolean", default: false },
    "session-row-deltas": { type: "boolean", default: false },
    "session-envelope-refs": { type: "boolean", default: false },
    "start-at": { type: "string" },
    "list-interval-ms": { type: "string", default: "0" },
    "poll-seed": { type: "string" },
  },
});
if (!values["state-dir"]) {
  throw new Error("--state-dir is required (existing team-shape fixture)");
}
const integer = (raw: string, label: string, min = 1) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
const port = integer(values.port, "--port", 40000);
const mockPort = integer(values["mock-port"], "--mock-port", 40000);
if (port > 65535 || mockPort > 65535 || port === mockPort) {
  throw new Error("ports must be distinct and <= 65535");
}
const scenario = values.scenario;
if (
  ![
    "sessions.list",
    "sessions.describe",
    "connect",
    "reconnect",
    "subscribe",
    "chat.send",
    "transcript-broadcast",
    "attempt-retention",
    "session-idle-retention",
    "memory-soak",
    "plugins.reload",
  ].includes(scenario)
) {
  throw new Error(
    "--scenario must be sessions.list, sessions.describe, connect, reconnect, subscribe, chat.send, transcript-broadcast, attempt-retention, session-idle-retention, memory-soak, or plugins.reload",
  );
}
const retentionScenario = scenario === "attempt-retention";
const idleScenario = scenario === "session-idle-retention";
const historyTurns = integer(values["history-turns"], "--history-turns", 0);
if ((historyTurns || values["seed-history"]) && !idleScenario) {
  throw new Error("--history-turns and --seed-history require session-idle-retention");
}
if (values["seed-history"] && !historyTurns) {
  throw new Error("--seed-history requires --history-turns > 0");
}
const soakScenario = scenario === "memory-soak";
const reasoningScenario = retentionScenario || idleScenario || soakScenario;
if (
  values["session-census"] &&
  (!idleScenario || path.resolve(values.entry) !== path.resolve("src/entry.ts"))
) {
  throw new Error(
    "--session-census requires --scenario session-idle-retention --entry src/entry.ts",
  );
}
const toolScenario = scenario === "chat.send" || reasoningScenario;
const turnScenario =
  scenario === "chat.send" ||
  scenario === "transcript-broadcast" ||
  retentionScenario ||
  idleScenario ||
  soakScenario;
if (
  !values.allocations &&
  !values["stream-start-allocations"] &&
  !values["workload-cpu-profile"] &&
  scenario !== "transcript-broadcast" &&
  !retentionScenario &&
  !idleScenario &&
  !soakScenario
) {
  throw new Error("--scenario requires --allocations or --workload-cpu-profile");
}
const operations = integer(
  values.operations ??
    (scenario === "plugins.reload" ? "1" : scenario === "reconnect" ? values.clients : "100"),
  "--operations",
);
const limit = integer(values.limit, "--limit");
const rowMode = values["row-mode"];
if (!["compact", "sidebar", "dashboard"].includes(rowMode)) {
  throw new Error("--row-mode must be compact, sidebar, or dashboard");
}
const clientCount =
  scenario === "chat.send" || idleScenario ? 1 : integer(values.clients, "--clients");
const rpcConcurrency = integer(values["rpc-concurrency"], "--rpc-concurrency");
if (rpcConcurrency > clientCount) {
  throw new Error("--rpc-concurrency must not exceed --clients");
}
const reconnectStaggerMs = integer(values["reconnect-stagger-ms"], "--reconnect-stagger-ms", 0);
const connectionScenario = scenario === "connect" || scenario === "reconnect";
if (
  scenario === "reconnect" &&
  (Math.min(operations, clientCount) - 1) * reconnectStaggerMs > 5000
) {
  throw new Error("reconnect storm starts must fit within 5000 ms; reduce --reconnect-stagger-ms");
}
const exactClients = integer(
  values["exact-clients"] ?? String(idleScenario ? 0 : clientCount),
  "--exact-clients",
  0,
);
if (exactClients > clientCount) {
  throw new Error("--exact-clients must not exceed --clients");
}
const runCount = scenario === "chat.send" ? 1 : integer(values.runs, "--runs");
const sessionCount = idleScenario ? integer(values.sessions, "--sessions") : runCount;
if (
  idleScenario &&
  (exactClients ||
    values["activity-summaries"] ||
    values["cpu-profile"] ||
    values["stream-start-allocations"] ||
    values["stream-start-diagnostics"])
) {
  throw new Error(
    "session-idle-retention requires no exact subscriptions, activity summaries, or stream-start profiling",
  );
}
const rounds = integer(values.rounds, "--rounds");
const durationMs = integer(values["duration-ms"], "--duration-ms");
const warmupMs = integer(values["warmup-ms"], "--warmup-ms", 0);
const roundIntervalMs = integer(values["round-interval-ms"], "--round-interval-ms");
const memoryIntervalMs = integer(values["memory-interval-ms"], "--memory-interval-ms");
const retainedProfileMs = integer(values["retained-profile-ms"], "--retained-profile-ms", 0);
const resetEveryRounds = integer(values["reset-every-rounds"], "--reset-every-rounds", 0);
if (
  soakScenario &&
  (values["stream-start-allocations"] ||
    (values.allocations && retainedProfileMs > 0) ||
    retainedProfileMs > durationMs)
) {
  throw new Error(
    "memory-soak requires --retained-profile-ms 0 for --allocations; retained capture must fit its duration and cannot overlap stream-start allocation capture",
  );
}
const chunkCount = integer(values.chunks, "--chunks");
const chunkIntervalMs = integer(values["chunk-interval-ms"], "--chunk-interval-ms", 0);
const listIntervalMs = integer(values["list-interval-ms"], "--list-interval-ms", 0);
if (connectionScenario && listIntervalMs) {
  throw new Error("connection scenarios use their own sidebar refresh; omit --list-interval-ms");
}
if (values["stress-tools"] && !toolScenario) {
  throw new Error(
    "--stress-tools requires chat.send, attempt-retention, session-idle-retention, or memory-soak",
  );
}
if (values["stress-subagents"] && (!soakScenario || !values["stress-tools"])) {
  throw new Error("--stress-subagents requires memory-soak and --stress-tools");
}
if (values["mixed-rpc"] && (!listIntervalMs || !turnScenario || clientCount < 4)) {
  throw new Error(
    "--mixed-rpc requires a turn scenario, --list-interval-ms, and at least four clients",
  );
}
const recapBurstRepeats = integer(values["recap-burst-repeats"], "--recap-burst-repeats", 0);
const recapBurstIntervalMs = integer(
  values["recap-burst-interval-ms"],
  "--recap-burst-interval-ms",
  0,
);
if (recapBurstRepeats > 100 || recapBurstIntervalMs > 1000) {
  throw new Error("recap burst limits are 100 repeats and a 1000 ms interval");
}
if (recapBurstRepeats && (!values["activity-summaries"] || !turnScenario)) {
  throw new Error("--recap-burst-repeats requires --activity-summaries and a turn scenario");
}
if ((values["cpu-profile"] || values["stream-start-diagnostics"]) && !turnScenario) {
  throw new Error("--cpu-profile and --stream-start-diagnostics require a turn scenario");
}
if (values["workload-cpu-profile"] && values["cpu-profile"]) {
  throw new Error("--workload-cpu-profile and --cpu-profile cannot capture CPU simultaneously");
}
if (
  values["workload-cpu-profile"] &&
  (values.allocations ||
    values["trace-gc"] ||
    values["stream-start-allocations"] ||
    (soakScenario && retainedProfileMs > 0))
) {
  throw new Error(
    "--workload-cpu-profile needs a separate pass without --allocations, --trace-gc, --stream-start-allocations, or memory-soak retained heap capture (--retained-profile-ms 0)",
  );
}
if (values["stream-start-allocations"] && (!turnScenario || values.allocations)) {
  throw new Error("--stream-start-allocations requires a turn scenario without --allocations");
}
if (values["poll-seed"] !== undefined && !listIntervalMs) {
  throw new Error("--poll-seed requires --list-interval-ms");
}
const recordListRequests =
  values.diagnostics ||
  values["stream-start-diagnostics"] ||
  values["cpu-profile"] ||
  values["poll-seed"] !== undefined;
const startAt = values["start-at"] ? integer(values["start-at"], "--start-at") : undefined;
if (values["session-envelope-refs"] && !values["session-row-deltas"]) {
  throw new Error("--session-envelope-refs requires --session-row-deltas");
}
const promptBytes = integer(values["prompt-kib"], "--prompt-kib") * 1024;
const promptContent = createCipheriv(
  "aes-256-ctr",
  createHash("sha256").update("attempt-retention-967").digest(),
  Buffer.alloc(16),
);
const root = path.resolve(values["state-dir"]);
const fixture: unknown = JSON.parse(
  readFileSync(path.join(root, "team-shape-summary.json"), "utf8"),
);
if (!isRecord(fixture) || fixture.format !== "openclaw-team-shape-v1") {
  throw new Error("--state-dir must contain a generated team-shape fixture");
}
const output = path.join(root, `broadcast-measure-${Date.now()}`);
mkdirSync(output);
const project = Array.isArray(fixture.projectWorktrees) ? fixture.projectWorktrees[0] : undefined;
const fixtureSessionCount = typeof fixture.sessionCount === "number" ? fixture.sessionCount : 0;
if (values["mixed-rpc"] && fixtureSessionCount < 1) {
  throw new Error("--mixed-rpc requires retained fixture sessions for chat.history");
}
let stressWorktree: string | undefined;
let diffControlOriginal: string | undefined;
if (values["stress-tools"] || values["mixed-rpc"]) {
  if (!isRecord(project) || typeof project.path !== "string") {
    throw new Error("stress tools and mixed RPCs require a fixture generated with --projects >= 1");
  }
  stressWorktree = realpathSync(project.path);
  if (
    !stressWorktree.startsWith(`${realpathSync(root)}${path.sep}`) ||
    !readFileSync(path.join(stressWorktree, ".git"), "utf8").startsWith("gitdir: ")
  ) {
    throw new Error("stress worktree must be a real linked worktree inside the synthetic fixture");
  }
  if (values["mixed-rpc"]) {
    diffControlOriginal = readFileSync(path.join(stressWorktree, "README.md"), "utf8");
  }
}
const cfg = JSON.parse(readFileSync(path.join(root, "openclaw.json"), "utf8"));
applyMockOpenAiModelConfig(cfg, { mockPort, modelRef: "openai/gpt-4.1" });
cfg.agents.defaults = {
  ...cfg.agents.defaults,
  maxConcurrent: runCount,
  subagents: { ...cfg.agents.defaults.subagents, maxConcurrent: runCount },
  skipBootstrap: true,
};
cfg.memory = { ...cfg.memory, search: { enabled: false } };
cfg.tools = {
  codeMode: values["stress-tools"],
  ...(values["stress-tools"] ? { exec: { host: "gateway", mode: "full" } } : {}),
};
if (stressWorktree) {
  cfg.agents.entries.main.workspace = stressWorktree;
}
cfg.plugins = {
  ...cfg.plugins,
  entries: {
    ...(soakScenario ? cfg.plugins?.entries : {}),
    "memory-core": { config: { dreaming: { enabled: false } } },
  },
};
if (values["active-work-diagnostics"]) {
  if (scenario !== "transcript-broadcast") {
    throw new Error("--active-work-diagnostics requires --scenario transcript-broadcast");
  }
  cfg.diagnostics = { ...cfg.diagnostics, enabled: true };
  cfg.plugins.entries["diagnostics-prometheus"] = { enabled: true };
}
if (soakScenario) {
  cfg.diagnostics = { ...cfg.diagnostics, enabled: true };
  if (cfg.plugins.allow?.length) {
    cfg.plugins.allow = [...new Set([...cfg.plugins.allow, "diagnostics-prometheus"])];
  }
  cfg.plugins.entries["diagnostics-prometheus"] = { enabled: true };
  if (values["stress-tools"]) {
    cfg.cron = { ...cfg.cron, enabled: true };
  }
}
let reloadPluginId: string | undefined;
if (scenario === "plugins.reload") {
  const plugin = writePluginFixtures(output, { count: 1, activationOnStartup: true });
  reloadPluginId = plugin.pluginIds[0];
  cfg.plugins = { enabled: true, allow: plugin.pluginIds, load: { paths: [plugin.pluginsDir] } };
}
const toolPaths = Array.from({ length: retentionScenario ? 3 : 1 }, (_, index) => {
  const file = path.join(root, "workspace", `synthetic-tool-input-${index}.txt`);
  writeFileSync(
    file,
    "Synthetic allocation benchmark tool result.\n" +
      (retentionScenario ? promptContent.update(Buffer.alloc(8192)).toString("hex") : ""),
  );
  return file;
});
const configPath = path.join(output, "openclaw.json");
writeFileSync(configPath, JSON.stringify(cfg));
const chunk = "Synthetic streamed answer. ";
function responseEvents(chunks: string[]) {
  const text = chunks.join("");
  const item = {
    type: "message",
    id: "msg_broadcast",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    ...chunks.map((delta) => ({
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta,
    })),
    {
      type: "response.output_text.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_broadcast",
        status: "completed",
        output: [item],
        usage: { input_tokens: 11, output_tokens: chunks.length, total_tokens: 11 + chunks.length },
      },
    },
  ];
}
function functionCallEvents(name: string, args: unknown, callId: string) {
  const item = {
    type: "function_call",
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  };
  return [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${callId}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 11, output_tokens: 10, total_tokens: 21 },
      },
    },
  ];
}
function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content)
    ? content
        .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
        .join("\n")
    : "";
}
type StressSubagent = {
  parentPrompt: string;
  childPrompt: string;
  childResult: string;
  parentAck: string;
  spawnCallId: string;
  yieldCallId: string;
  phase: "initial" | "spawn-issued" | "yield-issued" | "ack-issued";
  accepted?: { childSessionKey: string; runId: string };
  childRequests: number;
  yieldObserved: boolean;
  cancelled: boolean;
  releaseChild: () => void;
  childReady: Promise<void>;
  cohortReady: Promise<void>;
};
let stressSubagent: StressSubagent | undefined;
async function stressSubagentEvents(body: unknown, input: unknown, purpose: string) {
  const state = stressSubagent;
  if (
    !state ||
    !Array.isArray(input) ||
    purpose === "activity-recap" ||
    purpose === "session-observer"
  ) {
    return undefined;
  }
  const userTexts = input
    .filter((item) => isRecord(item) && item.role === "user")
    .map((item) => stripInboundMetadata(contentText(item.content)).trim());
  const isParent = userTexts.includes(state.parentPrompt);
  // Native child envelopes reach the provider with escaped delimiters. The parent's
  // completion quotes that task too, so its original prompt takes precedence.
  if (!isParent && userTexts.some((text) => text.split("\n").includes(state.childPrompt))) {
    if (++state.childRequests !== 1) {
      throw new Error("stress subagent issued more than one child model request");
    }
    // Parent yield releases its main-lane slot; all foreground streams must be admitted too.
    await Promise.all([state.childReady, state.cohortReady]);
    if (state.cancelled) {
      throw new Error("stress subagent cohort was cancelled");
    }
    return responseEvents([state.childResult]);
  }
  if (!isParent) {
    return undefined;
  }
  if (state.phase === "initial") {
    const tools = isRecord(body) && Array.isArray(body.tools) ? body.tools : [];
    for (const name of ["exec", "sessions_yield"]) {
      if (!tools.some((tool) => isRecord(tool) && tool.type === "function" && tool.name === name)) {
        throw new Error(`stress subagent parent is missing declared tool ${name}`);
      }
    }
    state.phase = "spawn-issued";
    return functionCallEvents(
      "exec",
      {
        title: "Start the synthetic child task",
        awaitResults: true,
        code: `return await sessions_spawn(${JSON.stringify({
          task: state.childPrompt,
          agentId: "main",
          runtime: "subagent",
          mode: "run",
          context: "isolated",
          cleanup: "delete",
          completionTarget: "parent",
          runTimeoutSeconds: 120,
        })});`,
      },
      state.spawnCallId,
    );
  }
  if (state.phase === "spawn-issued") {
    const spawnOutput = input.findLast(
      (item) =>
        isRecord(item) &&
        item.type === "function_call_output" &&
        item.call_id === state.spawnCallId,
    );
    const receipt: unknown = JSON.parse(contentText(spawnOutput?.output));
    const accepted = isRecord(receipt) ? receipt.value : undefined;
    if (
      !isRecord(receipt) ||
      receipt.status !== "completed" ||
      !isRecord(accepted) ||
      accepted.status !== "accepted" ||
      accepted.context !== "isolated" ||
      accepted.completionTarget !== "parent" ||
      typeof accepted.runId !== "string" ||
      typeof accepted.childSessionKey !== "string" ||
      !accepted.childSessionKey.startsWith("agent:main:subagent:")
    ) {
      throw new Error("stress subagent spawn did not return an accepted native child");
    }
    state.accepted = { runId: accepted.runId, childSessionKey: accepted.childSessionKey };
    state.phase = "yield-issued";
    return functionCallEvents(
      "sessions_yield",
      { message: "Await the synthetic child result." },
      state.yieldCallId,
    );
  }
  if (
    state.phase !== "yield-issued" ||
    !state.yieldObserved ||
    state.childRequests !== 1 ||
    !userTexts.some((text) => text.includes(state.childResult))
  ) {
    throw new Error(
      `stress subagent parent resumed without its yielded child result: phase=${state.phase}, yielded=${state.yieldObserved}, childRequests=${state.childRequests}, resultObserved=${userTexts.some((text) => text.includes(state.childResult))}`,
    );
  }
  state.phase = "ack-issued";
  return responseEvents([state.parentAck]);
}
const events = responseEvents(Array.from({ length: chunkCount }, () => chunk));
const utilityEvents = responseEvents(["Synthetic acknowledgement."]);
let activeStreams = 0;
let peakStreams = 0;
let streamRequests = 0;
let primaryStreamRequests = 0;
let activePrimaryStreams = 0;
let peakPrimaryStreams = 0;
let toolCalls = 0;
let toolResults = 0;
let outputLimitResponses = 0;
let recoveredResponses = 0;
let imageRequests = 0;
let reasoningResponses = 0;
let reasoningReplayRequests = 0;
let activeWorkCounts: { running: number; queued: number } | undefined;
async function readActiveWorkCounts() {
  let lastCounts: { running: number; queued: number } | undefined;
  for (let attempt = 0; attempt < 50; attempt++) {
    const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics/prometheus`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`active-work metrics scrape failed: HTTP ${response.status}`);
    }
    const metrics = await response.text();
    const running = metrics.match(/^openclaw_sessions_active\{state="running"\} (\d+)$/mu);
    const queued = metrics.match(/^openclaw_sessions_active\{state="queued"\} (\d+)$/mu);
    if (running && queued) {
      lastCounts = { running: Number(running[1]), queued: Number(queued[1]) };
      if (lastCounts.running === runCount && lastCounts.queued === 0) {
        writeFileSync(path.join(output, `held-streams-${cohort?.id}.prom`), metrics);
        return lastCounts;
      }
    }
    await delay(100);
  }
  throw new Error(
    `active-work exporter did not observe ${runCount} running and zero queued held streams: ${JSON.stringify(lastCounts)}`,
  );
}
type StreamStartPhases = {
  admissionStartedAtEpochMs: number;
  firstPrimaryRequestAtEpochMs?: number;
  lastPrimaryRequestAtEpochMs?: number;
  streamsReleasedAtEpochMs?: number;
  firstPrimarySseWrittenAtEpochMs?: number;
  completedAtEpochMs?: number;
};
type TurnTiming = {
  runId: string;
  startedAt: number;
  providerRequestMs?: number;
  providerBarrierMs?: number;
  firstTextMs?: number;
};
const epochNow = () => performance.timeOrigin + performance.now();
function createPollRandom(round: number, client: number) {
  if (values["poll-seed"] === undefined) {
    return undefined;
  }
  let state = createHash("sha256")
    .update(JSON.stringify([values["poll-seed"], round, client]))
    .digest()
    .readUInt32LE();
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
let cohort:
  | {
      id: string;
      expectedCount: number;
      arrivals: Set<number>;
      turns: Map<number, TurnTiming>;
      toolCallIds: Set<string>;
      outputLimited: Set<string>;
      reasoningSignatures: Map<string, string>;
      incompleteReasoningSignatures: Map<string, string>;
      phases: StreamStartPhases;
      beforeRelease?: () => Promise<void>;
      ready: Promise<void>;
      release: () => void;
      reject: (error: Error) => void;
    }
  | undefined;
const mock = createServer((req, res) => {
  if (req.url === "/health") {
    res.end("ok");
    return;
  }
  void (async () => {
    const body: unknown = JSON.parse(await readBody(req));
    const facts = summarizeMockInferenceRequest(body);
    if (facts.purpose === "activity-recap") {
      recapRequests++;
    }
    let input: unknown;
    if (body && typeof body === "object") {
      if ("input" in body) {
        input = body.input;
      }
      if (input === undefined && "messages" in body) {
        input = body.messages;
      }
    }
    const lastUser = Array.isArray(input)
      ? input
          .toReversed()
          .map(readMockUserText)
          .find((text) => text !== undefined)
      : undefined;
    const index = facts.turnIndex;
    const toolOutputs =
      Array.isArray(input) && cohort
        ? input.filter(
            (item) =>
              item?.type === "function_call_output" && cohort?.toolCallIds.has(item.call_id),
          )
        : [];
    const toolOutput = toolOutputs.at(-1);
    const continuation = toolScenario && toolOutput !== undefined;
    if (continuation) {
      if (reasoningScenario) {
        const expectedSignature = cohort?.reasoningSignatures.get(toolOutput.call_id);
        if (
          expectedSignature === undefined ||
          !Array.isArray(input) ||
          !input.some(
            (item) => item?.type === "reasoning" && item.encrypted_content === expectedSignature,
          )
        ) {
          throw new Error("synthetic reasoning signature did not survive the provider request");
        }
        const incompleteSignature = cohort?.incompleteReasoningSignatures.get(toolOutput.call_id);
        if (
          incompleteSignature !== undefined &&
          input.some(
            (item) => item?.type === "reasoning" && item.encrypted_content === incompleteSignature,
          )
        ) {
          throw new Error("reasoning-only output-limit signature was replayed during recovery");
        }
        reasoningReplayRequests++;
      }
      if (
        toolOutputs.some(
          (toolResult) =>
            typeof toolResult.output !== "string" ||
            !toolResult.output.includes("Synthetic allocation benchmark tool result.") ||
            (values["stress-tools"] && !toolResult.output.includes("synthetic-code-exec-verified")),
        )
      ) {
        throw new Error(
          "synthetic tool result did not verify its read and optional code-mode exec",
        );
      }
      if (!retentionScenario || !cohort?.outputLimited.has(toolOutput.call_id)) {
        toolResults += toolOutputs.length;
      }
    }
    const primary =
      cohort &&
      facts.purpose === "benchmark-turn" &&
      !facts.hasToolOutput &&
      !continuation &&
      index !== undefined &&
      index >= 1 &&
      index <= runCount &&
      lastUser !== undefined &&
      stripInboundMetadata(lastUser).trim().split("\n")[0] ===
        `Reply with benchmark stream ${index}. Transcript-broadcast cohort ${cohort.id}.`;
    if (retentionScenario && (primary || continuation)) {
      const hasImage =
        Array.isArray(input) &&
        input.some(
          (message) =>
            Array.isArray(message?.content) &&
            message.content.some(
              (part: unknown) =>
                isRecord(part) &&
                part.type === "input_image" &&
                typeof part.image_url === "string" &&
                part.image_url.startsWith("data:image/"),
            ),
        );
      if (!hasImage) {
        throw new Error("synthetic inline image did not survive the provider request");
      }
      imageRequests++;
    }
    activeStreams++;
    peakStreams = Math.max(peakStreams, activeStreams);
    streamRequests++;
    if (primary) {
      primaryStreamRequests++;
      activePrimaryStreams++;
      peakPrimaryStreams = Math.max(peakPrimaryStreams, activePrimaryStreams);
    }
    try {
      if (primary && cohort) {
        if (cohort.arrivals.has(index)) {
          throw new Error(`duplicate primary stream ${index} in cohort ${cohort.id}`);
        }
        cohort.arrivals.add(index);
        const timing = cohort.turns.get(index)!;
        timing.providerRequestMs = performance.now() - timing.startedAt;
        cohort.phases.firstPrimaryRequestAtEpochMs ??= epochNow();
        cohort.phases.lastPrimaryRequestAtEpochMs = epochNow();
        if (cohort.arrivals.size === cohort.expectedCount) {
          if (values["active-work-diagnostics"]) {
            activeWorkCounts = await readActiveWorkCounts();
          }
          if (cohort.beforeRelease) {
            await cohort.beforeRelease();
          }
          cohort.phases.streamsReleasedAtEpochMs = epochNow();
          cohort.release();
        }
        await cohort.ready;
        timing.providerBarrierMs = performance.now() - timing.startedAt - timing.providerRequestMs;
      }
      const subagentAnswer = await stressSubagentEvents(body, input, facts.purpose);
      res.writeHead(200, { "content-type": "text/event-stream" });
      let toolAnswer;
      let reasoningReplayKey = toolOutput?.call_id;
      if (primary && toolScenario && cohort) {
        const currentCohort = cohort;
        const items = toolPaths.map((toolPath, toolIndex) => {
          const callId = `call_allocation_${currentCohort.id}_${index}_${toolIndex}`;
          currentCohort.toolCallIds.add(callId);
          return {
            type: "function_call",
            id: `fc_${currentCohort.id}_${index}_${toolIndex}`,
            call_id: callId,
            name: values["stress-tools"] ? "exec" : "read",
            arguments: JSON.stringify(
              values["stress-tools"]
                ? {
                    title: "Read the synthetic fixture and verify its worktree",
                    awaitResults: true,
                    code:
                      `json(await read({ path: ${JSON.stringify(toolPath)} }));\n` +
                      `const shell = await exec({ command: "pwd", workdir: ${JSON.stringify(stressWorktree)} });\n` +
                      `if (shell.exitCode !== 0 || shell.aggregated.trim() !== ${JSON.stringify(stressWorktree)}) throw new Error("Synthetic exec worktree mismatch");\n` +
                      'return "synthetic-code-exec-verified";',
                  }
                : { path: toolPath },
            ),
          };
        });
        toolCalls += items.length;
        reasoningReplayKey = items.at(-1)?.call_id;
        toolAnswer = [
          ...items.flatMap((item, output_index) => [
            { type: "response.output_item.added", output_index, item: { ...item, arguments: "" } },
            {
              type: "response.function_call_arguments.delta",
              item_id: item.id,
              output_index,
              delta: item.arguments,
            },
            { type: "response.output_item.done", output_index, item },
          ]),
          {
            type: "response.completed",
            response: {
              id: `resp_${cohort.id}`,
              status: "completed",
              output: items,
              usage: { input_tokens: 11, output_tokens: 10, total_tokens: 21 },
            },
          },
        ];
      }
      let answer =
        subagentAnswer ??
        toolAnswer ??
        (facts.purpose === "activity-recap"
          ? responseEvents([`Synthetic recap for cohort ${cohort?.id}.`])
          : primary || continuation
            ? events
            : utilityEvents);
      if (retentionScenario && continuation && cohort) {
        if (!cohort.outputLimited.has(toolOutput.call_id)) {
          cohort.outputLimited.add(toolOutput.call_id);
          outputLimitResponses++;
          const outputLimitAnswer = [
            {
              type: "response.incomplete",
              response: {
                id: `resp_limit_${toolOutput.call_id}`,
                status: "incomplete",
                incomplete_details: { reason: "max_output_tokens" },
                output: [],
                usage: { input_tokens: 11, output_tokens: 4096, total_tokens: 4107 },
              },
            },
          ];
          answer = outputLimitAnswer;
        } else {
          recoveredResponses++;
        }
      }
      for (const event of answer) {
        if (res.destroyed) {
          break;
        }
        if (primary && cohort) {
          cohort.phases.firstPrimarySseWrittenAtEpochMs ??= epochNow();
        }
        if (
          reasoningScenario &&
          (primary || continuation) &&
          "response" in event &&
          event.response !== undefined
        ) {
          const reasoning = {
            type: "reasoning",
            id: `rs_${cohort?.id}_${index}_${reasoningResponses++}`,
            status: "completed",
            summary: [],
            encrypted_content: promptContent.update(Buffer.alloc(8192)).toString("hex"),
          };
          if (reasoningReplayKey) {
            // Replay keeps completed reasoning and drops reasoning-only length stops.
            const signatures =
              event.type === "response.completed"
                ? cohort?.reasoningSignatures
                : cohort?.incompleteReasoningSignatures;
            signatures?.set(reasoningReplayKey, reasoning.encrypted_content);
          }
          const output_index = event.response.output.length;
          for (const type of ["response.output_item.added", "response.output_item.done"]) {
            res.write(`data: ${JSON.stringify({ type, output_index, item: reasoning })}\n\n`);
          }
          res.write(
            `data: ${JSON.stringify({ ...event, response: { ...event.response, output: [...event.response.output, reasoning] } })}\n\n`,
          );
        } else {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        if ((primary || continuation) && event.type === "response.output_text.delta") {
          await delay(chunkIntervalMs);
        }
      }
      res.end("data: [DONE]\n\n");
    } finally {
      activeStreams--;
      if (primary) {
        activePrimaryStreams--;
      }
    }
  })().catch((error: unknown) => {
    subscriberFailure ??= error instanceof Error ? error : new Error(String(error));
    res.destroy();
  });
});
const children: ChildProcess[] = [];
const clients: ReturnType<typeof createGatewayWsClient>[] = [];
const expectedClosures = new WeakSet<ReturnType<typeof createGatewayWsClient>>();
const responseFrameBytes = new WeakMap<
  ReturnType<typeof createGatewayWsClient>,
  Map<string, number>
>();
type RpcMeasurement = {
  latenciesMs: number[];
  responseBytes: number;
  representativeResponse?: { payload: unknown };
};
const rpcMeasurements = new Map<string, RpcMeasurement>();
const handshakeLatenciesMs: number[] = [];
const reconnectStorms: Array<{
  clients: number;
  startSpreadMs: number;
  allSidebarsCurrentMs: number;
}> = [];
const childLogs: ReturnType<typeof createWriteStream>[] = [];
const counters = new Map<string, number>();
const eventBytes = new Map<string, number>();
const sessionEventSizes = new Map<string, { frames: number; bytes: number }>();
type FrameSizes = {
  frameBytes: number;
  payloadBytes: number;
  fields: Record<string, number>;
  sessionFields?: Record<string, number>;
  duplicateEnvelopeFields?: number;
  potentialNumericRefsFrameBytes?: number;
};
const representativeFrames = new Map<string, FrameSizes>();
let initialFullFrame: FrameSizes | undefined;
const perClientCounters: Map<string, number>[] = [];
let measuring = false;
let lastSubscriberEventAt = performance.now();
let closing = false;
let subscriberFailure: Error | undefined;
let recapRequests = 0;
type RecapReceipt = {
  client: number;
  key: string;
  state: unknown;
  text: unknown;
  updatedAt: unknown;
  receivedAtEpochMs: number;
};
const perClientRecaps: Map<string, RecapReceipt>[] = [];
const recapReceipts: RecapReceipt[] = [];
let recapPhase: Awaited<ReturnType<typeof runRecapBurst>> | undefined;
let gateway: ChildProcess | undefined;
let stressCronJobId: string | undefined;
function fieldBytes(record: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(record).map(([field, value]) => [
      field,
      Buffer.byteLength(JSON.stringify({ [field]: value })) - 2,
    ]),
  );
}
function measureFrameFields(
  event: { payload?: unknown },
  payload: Record<string, unknown>,
  frameBytes: number,
): FrameSizes {
  const wire = isRecord(payload.session) ? payload.session : undefined;
  const full =
    wire && isRecord(wire.full) ? wire.full : wire && !("base" in wire) ? wire : undefined;
  const fields = wire && isRecord(wire.set) ? wire.set : full;
  const result: FrameSizes = {
    frameBytes,
    payloadBytes: Buffer.byteLength(JSON.stringify(payload)),
    fields: fieldBytes(payload),
    ...(fields ? { sessionFields: fieldBytes(fields) } : {}),
  };
  if (full) {
    const sortedFields = Object.keys(full).toSorted();
    const duplicateFields = sortedFields.filter(
      (field) =>
        field !== "key" &&
        field !== "agentId" &&
        Object.hasOwn(payload, field) &&
        JSON.stringify(payload[field]) === JSON.stringify(full[field]),
    );
    const potential: Record<string, unknown> = {
      ...payload,
      sessionFieldRefs: duplicateFields.map((field) => sortedFields.indexOf(field)),
    };
    for (const field of duplicateFields) {
      delete potential[field];
    }
    result.duplicateEnvelopeFields = duplicateFields.length;
    result.potentialNumericRefsFrameBytes = Buffer.byteLength(
      JSON.stringify({ ...event, payload: potential }),
    );
  }
  return result;
}
const ownedListeners = new Set<ChildProcess>();
const env = {
  ...createGatewayBenchEnv(path.join(root, "home"), configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: root,
  TMPDIR: path.join(root, "tmp"),
  OPENAI_API_KEY: "synthetic-fixture",
  OPENCLAW_PROFILE: `team-shape-${port}`,
  OPENCLAW_SYSTEMD_UNIT: `openclaw-gateway-team-shape-${port}`,
  ...(values["prep-trace"] ? { OPENCLAW_LOG_LEVEL: "trace" } : {}),
  ...(idleScenario ? { OPENCLAW_BENCH_FIRST_TEXT: "1" } : {}),
};
function launch(args: string[], name: string, extraEnv: NodeJS.ProcessEnv = {}, ipc = false) {
  const log = createWriteStream(path.join(output, `${name}.log`));
  const child = spawn(process.execPath, args, {
    env: { ...env, ...extraEnv },
    detached: true,
    stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.on("message", (message: unknown) => {
    if (
      isRecord(message) &&
      message.channel === GATEWAY_PROFILE_CHANNEL &&
      message.kind === "agent-text" &&
      typeof message.atEpochMs === "number"
    ) {
      const turn = [...(cohort?.turns.values() ?? [])].find(
        (candidate) => candidate.runId === message.runId,
      );
      if (turn) {
        turn.firstTextMs ??= message.atEpochMs - performance.timeOrigin - turn.startedAt;
      }
    }
  });
  child.once("close", () => log.end());
  childLogs.push(log);
  if (values.allocations || values["stream-start-allocations"] || values["trace-gc"]) {
    // Keep stderr diagnostics from interleaving with V8's line-oriented GC trace.
    const stdoutLog = createWriteStream(path.join(output, `${name}.stdout.log`));
    child.stdout?.pipe(stdoutLog, { end: false });
    child.once("close", () => stdoutLog.end());
    childLogs.push(stdoutLog);
  }
  let startupOutput = "";
  const observeStartup = (data: Buffer) => {
    if (!ownedListeners.has(child)) {
      startupOutput = (startupOutput + data.toString()).slice(-4096);
      if (startupOutput.includes("http server listening (")) {
        ownedListeners.add(child);
      }
    }
  };
  child.stdout?.on("data", observeStartup);
  child.stderr?.on("data", observeStartup);
  children.push(child);
  return child;
}
function assertGatewayAlive() {
  if (!gateway || !gateway.connected || gateway.exitCode !== null || gateway.signalCode !== null) {
    throw new Error(`owned Gateway exited; inspect ${output}`);
  }
  if (subscriberFailure) {
    throw subscriberFailure;
  }
}
async function assertPortAvailable(targetPort: number) {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(targetPort, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
}
async function ready(targetPort: number, endpoint: string, owned?: ChildProcess) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (owned) {
      assertGatewayAlive();
      // Preflight is best effort; the owned bind-success log handles another process taking the port.
      if (!ownedListeners.has(owned)) {
        await delay(500);
        continue;
      }
    }
    try {
      if ((await fetch(`http://127.0.0.1:${targetPort}${endpoint}`)).ok) {
        if (owned) {
          assertGatewayAlive();
        }
        return;
      }
    } catch {
      /* Startup has no listener yet. */
    }
    await delay(500);
  }
  throw new Error(`listener ${targetPort} did not become ready; inspect ${output}`);
}
const parentKey = "agent:main:transcript-broadcast-measure-parent";
const stressParentKey = "agent:main:transcript-broadcast-measure-native-parent";
const keys = Array.from(
  { length: sessionCount },
  (_, index) => `agent:main:transcript-broadcast-measure-child-${index}`,
);
const historySeedPath = path.join(root, "reopen-history.json");
if (values["seed-history"]) {
  // Run offline, separately from measurement, using the transcript append owner.
  mkdirSync(path.join(root, "reopen-history-seed"));
  process.env = { ...env };
  const [
    { SessionManager },
    { upsertSessionEntryCore, loadExactSessionEntry },
    { resolveOpenClawAgentSqlitePath },
    agentDb,
    stateDb,
    lifecycle,
  ] = await Promise.all([
    import("../../src/agents/sessions/session-manager.js"),
    import("../../src/config/sessions/session-accessor.js"),
    import("../../src/state/openclaw-agent-db.paths.js"),
    import("../../src/state/openclaw-agent-db.js"),
    import("../../src/state/openclaw-state-db.js"),
    import("../../src/shared/global-singleton.js"),
  ]);
  try {
    const timestamp = Number(fixture.now);
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
    const parentTarget = { agentId: "main", sessionKey: parentKey, storePath, env };
    if (loadExactSessionEntry(parentTarget)) {
      throw new Error("Synthetic reopen parent already exists");
    }
    await upsertSessionEntryCore(parentTarget, {
      sessionId: "reopen-history-parent",
      updatedAt: timestamp,
      createdAt: timestamp,
      lifecycleRevision: "reopen-history-v1",
      createdVia: "operator",
      visibility: "shared",
    });
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    for (const [index, sessionKey] of keys.entries()) {
      const sessionId = `reopen-history-${index}`;
      const target = { agentId: "main", sessionId, sessionKey, storePath, env };
      if (loadExactSessionEntry(target)) {
        throw new Error(`Synthetic reopen session already exists: ${sessionKey}`);
      }
      await upsertSessionEntryCore(target, {
        sessionId,
        createdAt: timestamp,
        updatedAt: timestamp,
        lifecycleRevision: "reopen-history-v1",
        createdVia: "operator",
        visibility: "shared",
        parentSessionKey: parentKey,
        parentSessionId: "reopen-history-parent",
        parentSessionLifecycleRevision: "reopen-history-v1",
        spawnDepth: 1,
      });
      const manager = await SessionManager.openAsync(target, path.join(root, "workspace"));
      await manager.appendModelChange("openai", "gpt-4.1");
      await manager.appendThinkingLevelChange("off");
      for (let turn = 0; turn < historyTurns; turn++) {
        const callId = `fixture-${turn}`;
        const assistant = {
          role: "assistant" as const,
          api: "openai-responses" as const,
          provider: "openai",
          model: "gpt-4.1",
          usage,
          timestamp: timestamp + turn,
        };
        await manager.appendMessageAsync({
          role: "user",
          content: `Inspect synthetic file ${turn}.`,
          timestamp: timestamp + turn,
        });
        await manager.appendMessageAsync({
          ...assistant,
          stopReason: "toolUse",
          content: [
            { type: "toolCall", id: callId, name: "read", arguments: { path: "fixture.txt" } },
          ],
        });
        await manager.appendMessageAsync({
          role: "toolResult",
          toolCallId: callId,
          toolName: "read",
          isError: false,
          content: [
            { type: "text", text: `Synthetic file ${turn}.\n${"Fixture content. ".repeat(128)}` },
          ],
          timestamp: timestamp + turn,
        });
        await manager.appendMessageAsync({
          ...assistant,
          stopReason: "stop",
          content: [{ type: "text", text: `Synthetic inspection ${turn} complete.` }],
        });
      }
      console.log(`SEEDED ${index + 1}/${sessionCount}`);
    }
    writeFileSync(historySeedPath, JSON.stringify({ sessionCount, historyTurns }));
  } finally {
    await agentDb.closeOpenClawAgentDatabasesAsync();
    await stateDb.closeOpenClawStateDatabaseAsync();
    await lifecycle.drainGlobalSingletonLifecycleState();
  }
  process.exit(0);
}
if (historyTurns) {
  const seeded = JSON.parse(readFileSync(historySeedPath, "utf8"));
  if (seeded.sessionCount !== sessionCount || seeded.historyTurns !== historyTurns) {
    throw new Error("Run --seed-history with matching --sessions and --history-turns first");
  }
}
const connectParams = {
  minProtocol: PROTOCOL_VERSION,
  maxProtocol: PROTOCOL_VERSION,
  client: {
    id: "gateway-client",
    displayName: "synthetic-broadcast-measurement",
    version: "1.0.0",
    platform: process.platform,
    mode: "backend",
  },
  role: "operator",
  scopes: ["operator.read", "operator.admin"],
  caps: [
    "session-scoped-events",
    "chat-only-assistant-text",
    ...(exactClients < clientCount ? ["roster-message-bodies-optional"] : []),
    ...(values["session-row-deltas"] ? ["session-row-deltas"] : []),
    ...(values["session-envelope-refs"] ? ["session-event-field-refs"] : []),
  ],
};
function summarizeLatencies(latencies: number[]) {
  const sorted = latencies.toSorted((a, b) => a - b);
  return {
    count: sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    p99: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null,
    max: sorted.at(-1) ?? null,
    latencies,
  };
}
function validateDiff(result: unknown, additions = 1) {
  if (
    !isRecord(result) ||
    result.root !== stressWorktree ||
    result.unavailableReason !== undefined ||
    !Array.isArray(result.files) ||
    !result.files.some(
      (file: unknown) =>
        isRecord(file) && file.path === "README.md" && file.additions === additions,
    )
  ) {
    throw new Error(
      `sessions.diff did not return the synthetic worktree control (${additions} added lines): ${JSON.stringify(result)}`,
    );
  }
}
async function rpc(
  client: ReturnType<typeof createGatewayWsClient>,
  method: string,
  params: unknown,
  onResponse?: (id: string) => void,
) {
  assertGatewayAlive();
  const started = performance.now();
  const response = await client.request(method, params, 180_000);
  const rpcDurationMs = performance.now() - started;
  assertGatewayAlive();
  if (!response.ok) {
    throw new Error(`${method}: ${JSON.stringify(response.error)}`);
  }
  if (
    method === "sessions.messages.subscribe" &&
    (!isRecord(params) ||
      !isRecord(response.payload) ||
      response.payload.subscribed !== true ||
      response.payload.key !== params.key ||
      response.payload.agentId !== "main")
  ) {
    throw new Error(
      "sessions.messages.subscribe did not acknowledge the requested fixture session",
    );
  }
  if (measuring) {
    const measured: RpcMeasurement = rpcMeasurements.get(method) ?? {
      latenciesMs: [],
      responseBytes: 0,
    };
    const bytes = responseFrameBytes.get(client)?.get(response.id);
    if (bytes === undefined) {
      throw new Error(`missing wire response size for ${method}`);
    }
    if (values["capture-responses"] && measured.latenciesMs.length === 0) {
      measured.representativeResponse = { payload: response.payload };
    }
    measured.latenciesMs.push(rpcDurationMs);
    measured.responseBytes += bytes;
    rpcMeasurements.set(method, measured);
    responseFrameBytes.get(client)?.delete(response.id);
  }
  onResponse?.(response.id);
  return response.payload;
}
function latencySummary(latenciesMs: number[]) {
  const sorted = latenciesMs.toSorted((a, b) => a - b);
  return {
    count: sorted.length,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null,
  };
}
function readPromotion(profilePath: string, operationCount: number) {
  const gcTrace = readGatewayGcTrace(path.join(output, "gateway.stdout.log"), profilePath);
  return { gcTrace, promotedBytesPerOperation: gcTrace.promotedBytes / operationCount };
}
function assertListPage(
  page: unknown,
  method: string,
): asserts page is { totalCount: number; count: number; sessions: unknown[] } {
  if (
    !isRecord(page) ||
    typeof page.totalCount !== "number" ||
    page.count !== Math.min(limit, page.totalCount) ||
    !Array.isArray(page.sessions) ||
    page.sessions.length !== page.count ||
    page.count === 0
  ) {
    throw new Error(`${method} did not return the requested nonempty page`);
  }
}
function sidebarIdentity(page: unknown) {
  assertListPage(page, "sessions.list");
  return JSON.stringify({
    totalCount: page.totalCount,
    sessions: page.sessions.map((row) => {
      if (!isRecord(row) || typeof row.key !== "string") {
        throw new Error("sidebar response contains an invalid session row");
      }
      return [row.key, row.sessionId, row.updatedAt];
    }),
  });
}
function summarizeCpuProfile(profilePath: string) {
  const profile: Profiler.Profile = JSON.parse(readFileSync(profilePath, "utf8"));
  const nodes = new Map(profile.nodes.map((node) => [node.id, node.callFrame]));
  const childNodes = new Map(profile.nodes.map((node) => [node.id, node.children ?? []]));
  const broadcastNodes = new Set<number>();
  const pending = profile.nodes
    .filter((node) => node.callFrame.functionName === "broadcastInternal")
    .map((node) => node.id);
  while (pending.length) {
    const id = pending.pop()!;
    broadcastNodes.add(id);
    pending.push(...(childNodes.get(id) ?? []));
  }
  let broadcastSampledMs = 0;
  const sites = new Map<
    string,
    { frame: Profiler.ProfileNode["callFrame"]; sampledSelfMs: number }
  >();
  for (const [index, id] of (profile.samples ?? []).entries()) {
    const frame = nodes.get(id);
    if (!frame) {
      continue;
    }
    const key = JSON.stringify(frame);
    const site = sites.get(key) ?? { frame, sampledSelfMs: 0 };
    const sampledMs = (profile.timeDeltas?.[index] ?? 1000) / 1000;
    site.sampledSelfMs += sampledMs;
    if (broadcastNodes.has(id)) {
      broadcastSampledMs += sampledMs;
    }
    sites.set(key, site);
  }
  return {
    ...readGatewayCpuProfile(profilePath),
    broadcastSampledMs,
    topSelfTime: [...sites.values()]
      .toSorted((left, right) => right.sampledSelfMs - left.sampledSelfMs)
      .slice(0, 40),
  };
}
async function startStressSubagent(
  client: ReturnType<typeof createGatewayWsClient>,
  current: NonNullable<typeof cohort>,
) {
  await rpc(client, "sessions.reset", { key: stressParentKey });
  let releaseChild!: () => void;
  const childReady = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  const state: StressSubagent = {
    parentPrompt: `LANE1486_PARENT_${current.id}`,
    childPrompt: `LANE1486_CHILD_${current.id}`,
    childResult: `LANE1486_CHILD_RESULT_${current.id}`,
    parentAck: `LANE1486_PARENT_ACK_${current.id}`,
    spawnCallId: `call_stress_spawn_${current.id}`,
    yieldCallId: `call_stress_yield_${current.id}`,
    phase: "initial",
    childRequests: 0,
    yieldObserved: false,
    cancelled: false,
    releaseChild,
    childReady,
    cohortReady: current.ready,
  };
  stressSubagent = state;
  const started = performance.now();
  await rpc(client, "agent", {
    sessionKey: stressParentKey,
    message: state.parentPrompt,
    deliver: false,
    idempotencyKey: randomUUID(),
  });
  return { state, started };
}
async function finishStressSubagent(
  client: ReturnType<typeof createGatewayWsClient>,
  work: Awaited<ReturnType<typeof startStressSubagent>>,
) {
  const { state, started } = work;
  let childCompleted = false;
  while (performance.now() - started < 180_000) {
    assertGatewayAlive();
    const history = await rpc(client, "chat.history", { sessionKey: stressParentKey, limit: 100 });
    if (!isRecord(history) || !Array.isArray(history.messages)) {
      throw new Error("stress subagent parent history is missing");
    }
    if (!state.yieldObserved) {
      const blocks = history.messages.flatMap((message) =>
        isRecord(message)
          ? [message, ...(Array.isArray(message.content) ? message.content.filter(isRecord) : [])]
          : [],
      );
      const yielded = blocks.find(
        (block) =>
          block.toolCallId === `${state.yieldCallId}|fc_${state.yieldCallId}` &&
          block.toolName === "sessions_yield",
      );
      if (yielded) {
        const receipt: unknown = JSON.parse(contentText(yielded.content));
        if (!isRecord(receipt) || receipt.status !== "yielded" || !state.accepted) {
          throw new Error("stress subagent parent did not persist a successful yield");
        }
        state.yieldObserved = true;
        // Observe the real child run before cleanup can retire its session.
        const completion = rpc(client, "agent.wait", {
          runId: state.accepted.runId,
          timeoutMs: 170_000,
        });
        state.releaseChild();
        const result = await completion;
        if (!isRecord(result) || result.status !== "ok") {
          throw new Error("stress subagent child did not complete successfully");
        }
        childCompleted = true;
      }
    }
    const ack = history.messages.find(
      (message) =>
        isRecord(message) &&
        message.role === "assistant" &&
        contentText(message.content).trim() === state.parentAck,
    );
    if (ack) {
      const metadata = ack["__openclaw"];
      const runId = isRecord(metadata) ? metadata.runId : undefined;
      if (state.phase !== "ack-issued" || !childCompleted || typeof runId !== "string") {
        throw new Error("stress subagent parent acknowledgment lacks completed run evidence");
      }
      const result = await rpc(client, "agent.wait", { runId, timeoutMs: 170_000 });
      if (!isRecord(result) || result.status !== "ok") {
        throw new Error("stress subagent parent continuation did not complete successfully");
      }
      return {
        childRunId: state.accepted!.runId,
        childSessionKey: state.accepted!.childSessionKey,
        parentContinuationRunId: runId,
        parentYielded: true,
        childCompleted: true,
        parentResultObserved: true,
        parentAcknowledgmentPersisted: true,
        durationMs: performance.now() - started,
      };
    }
    await delay(250);
  }
  throw new Error(`stress subagent completion timed out in phase ${state.phase}`);
}
let completedSoakRounds = 0;
let sessionResets = 0;
async function runRound(
  client: ReturnType<typeof createGatewayWsClient>,
  measuredRound?: number,
  roundKeys = keys,
) {
  if (
    retentionScenario ||
    (soakScenario && resetEveryRounds > 0 && completedSoakRounds % resetEveryRounds === 0)
  ) {
    // Retire each previous session generation so retained history is not the measurement.
    for (const key of keys) {
      await rpc(client, "sessions.reset", { key });
      sessionResets++;
    }
  }
  const child = gateway;
  if (!child) {
    throw new Error("owned Gateway is unavailable");
  }
  const profilePath =
    measuredRound !== undefined && values["cpu-profile"]
      ? path.join(output, `stream-start-${measuredRound}.cpuprofile`)
      : undefined;
  if (profilePath) {
    await controlGatewayProfile(child, "cpu", "start", profilePath);
  }
  const heapProfilePath =
    measuredRound !== undefined && values["stream-start-allocations"]
      ? path.join(output, `stream-start-${measuredRound}.heapprofile`)
      : undefined;
  const deliveredSessionEvents = () =>
    (perClientCounters[0]?.get("session.message") ?? 0) +
    (perClientCounters[0]?.get("sessions.changed") ?? 0);
  const eventsBeforeProfile = deliveredSessionEvents();
  if (heapProfilePath) {
    await controlGatewayProfile(child, "heap", "start", heapProfilePath);
  }
  let finishAdmissionDiagnostics =
    measuredRound !== undefined && values["stream-start-diagnostics"]
      ? await startGatewayDiagnostics(child, `stream-admission-${measuredRound}`)
      : undefined;
  if (finishAdmissionDiagnostics) {
    // Prime the 20 ms loop-delay timer before admitting the measured burst.
    await delay(25);
    await readGatewayCpuUsage(child);
  }
  let finishReleaseDiagnostics: typeof finishAdmissionDiagnostics;
  let admissionDiagnostics: ReturnType<ReturnType<typeof startGatewayBenchDiagnostics>> | undefined;
  let capture:
    | {
        cpuProfile?: ReturnType<typeof summarizeCpuProfile>;
        heapProfile?: ReturnType<typeof readGatewayHeapProfile>;
        observedSessionPublications?: number;
        admissionDiagnostics?: typeof admissionDiagnostics;
        releaseDiagnostics?: typeof admissionDiagnostics;
      }
    | undefined;
  let release!: () => void;
  let reject!: (error: Error) => void;
  const cohortReady = new Promise<void>((resolve, rejectReady) => {
    release = resolve;
    reject = rejectReady;
  });
  cohort = {
    id: randomUUID(),
    expectedCount: roundKeys.length,
    arrivals: new Set(),
    turns: new Map(),
    toolCallIds: new Set(),
    outputLimited: new Set(),
    reasoningSignatures: new Map(),
    incompleteReasoningSignatures: new Map(),
    phases: { admissionStartedAtEpochMs: epochNow() },
    beforeRelease: finishAdmissionDiagnostics
      ? async () => {
          admissionDiagnostics = await finishAdmissionDiagnostics?.();
          finishAdmissionDiagnostics = undefined;
          finishReleaseDiagnostics = await startGatewayDiagnostics(
            child,
            `stream-release-${measuredRound}`,
          );
          await delay(25);
          await readGatewayCpuUsage(child);
        }
      : undefined,
    ready: cohortReady,
    release,
    reject,
  };
  const current = cohort;
  // Include the first response processing after the mock releases the whole cohort.
  const captureWork =
    profilePath || heapProfilePath || finishAdmissionDiagnostics
      ? (async () => {
          try {
            await cohortReady;
            await delay(500);
          } finally {
            if (finishAdmissionDiagnostics) {
              admissionDiagnostics = await finishAdmissionDiagnostics();
            }
            const releaseDiagnostics = await finishReleaseDiagnostics?.();
            capture = { admissionDiagnostics, releaseDiagnostics };
            if (heapProfilePath) {
              await controlGatewayProfile(child, "heap", "stop", heapProfilePath);
              capture.heapProfile = readGatewayHeapProfile(heapProfilePath);
              capture.observedSessionPublications = deliveredSessionEvents() - eventsBeforeProfile;
            }
            if (profilePath) {
              await controlGatewayProfile(child, "cpu", "stop", profilePath);
              capture.cpuProfile = summarizeCpuProfile(profilePath);
            }
          }
        })()
      : undefined;
  const timeout = setTimeout(
    () =>
      current.reject(
        new Error(
          `only ${current.arrivals.size}/${current.expectedCount} primary model requests arrived in 45s`,
        ),
      ),
    45_000,
  );
  const turnLatencies: number[] = [];
  let subagentWork: Awaited<ReturnType<typeof startStressSubagent>> | undefined;
  try {
    // Admit the parent before filling the main lane with the foreground cohort.
    if (values["stress-subagents"]) {
      subagentWork = await startStressSubagent(client, current);
    }
    const turns = Promise.all(
      roundKeys.map(async (sessionKey, index) => {
        const turnStarted = performance.now();
        const runId = randomUUID();
        current.turns.set(index + 1, { runId, startedAt: turnStarted });
        const image = retentionScenario
          ? promptContent.update(Buffer.alloc(256 * 128 * 4))
          : undefined;
        if (image) {
          for (let alpha = 3; alpha < image.length; alpha += 4) {
            image[alpha] = 255;
          }
        }
        await rpc(client, scenario === "chat.send" ? "chat.send" : "agent", {
          sessionKey,
          message:
            `Reply with benchmark stream ${index + 1}. Transcript-broadcast cohort ${current.id}.` +
            (retentionScenario || idleScenario
              ? `\nSynthetic prompt payload: ${promptContent.update(Buffer.alloc(promptBytes / 2)).toString("hex")}`
              : ""),
          deliver: false,
          idempotencyKey: runId,
          ...(image
            ? {
                attachments: [
                  {
                    type: "file",
                    mimeType: "image/png",
                    fileName: "synthetic-noise.png",
                    content: encodePngRgba(image, 256, 128).toString("base64"),
                  },
                ],
              }
            : {}),
        });
        const result = await rpc(client, "agent.wait", { runId, timeoutMs: 170_000 });
        if (
          !result ||
          typeof result !== "object" ||
          !("status" in result) ||
          result.status !== "ok"
        ) {
          throw new Error(`agent.wait: ${JSON.stringify(result)}`);
        }
        turnLatencies.push(performance.now() - turnStarted);
      }),
    ).then(() => {
      current.phases.completedAtEpochMs = epochNow();
    });
    const subagentCompletion = subagentWork
      ? finishStressSubagent(client, subagentWork)
      : undefined;
    await Promise.all([cohortReady, captureWork, turns, subagentCompletion]);
    const subagent = await subagentCompletion;
    if (soakScenario) {
      completedSoakRounds++;
    }
    return {
      phases: current.phases,
      turnLatencyMs: summarizeLatencies(turnLatencies),
      providerRequestMs: summarizeLatencies(
        [...current.turns.values()].flatMap((turn) => turn.providerRequestMs ?? []),
      ),
      providerBarrierMs: summarizeLatencies(
        [...current.turns.values()].flatMap((turn) => turn.providerBarrierMs ?? []),
      ),
      firstTextMs: summarizeLatencies(
        [...current.turns.values()].flatMap((turn) => turn.firstTextMs ?? []),
      ),
      ...(subagent ? { subagent } : {}),
      ...capture,
    };
  } finally {
    if (stressSubagent) {
      stressSubagent.cancelled = true;
      stressSubagent.releaseChild();
      stressSubagent = undefined;
    }
    clearTimeout(timeout);
    current.release();
    await captureWork;
  }
}
async function drainEvents() {
  const started = performance.now();
  while (performance.now() - started < 15_000) {
    assertGatewayAlive();
    if (activeStreams === 0 && performance.now() - lastSubscriberEventAt >= 1000) {
      return;
    }
    await delay(50);
  }
  throw new Error("model streams and subscriber events did not drain within 15s");
}
async function ensureRecaps(client: ReturnType<typeof createGatewayWsClient>) {
  const states: unknown[] = [];
  for (let offset = 0; offset < keys.length; offset += 20) {
    const batch = keys.slice(offset, offset + 20);
    const result = await rpc(client, "sessions.activitySummary.ensure", {
      sessions: batch.map((key) => ({ key })),
    });
    if (
      !isRecord(result) ||
      !Array.isArray(result.sessions) ||
      result.sessions.length !== batch.length ||
      result.sessions.some(
        (row: unknown) =>
          !isRecord(row) ||
          !isRecord(row.activitySummary) ||
          row.activitySummary.state === "unavailable",
      )
    ) {
      throw new Error("sessions.activitySummary.ensure did not admit the measured sessions");
    }
    for (const row of result.sessions) {
      states.push(row.activitySummary.state);
    }
  }
  return states;
}
async function waitForCurrentRecaps(text: string, since = 0, pendingKeys: string[] = keys) {
  const started = performance.now();
  while (performance.now() - started < 15_000) {
    assertGatewayAlive();
    if (
      perClientRecaps.every((rows) =>
        keys.every((key) => {
          const row = rows.get(key);
          return (
            row?.state === "current" &&
            row.text === text &&
            (!pendingKeys.includes(key) || row.receivedAtEpochMs >= since)
          );
        }),
      )
    ) {
      return;
    }
    await delay(25);
  }
  throw new Error("latest current recap did not reach every subscriber within 15s");
}
async function runRecapBurst(
  client: ReturnType<typeof createGatewayWsClient>,
  measuredRound?: number,
) {
  const child = gateway;
  if (!child) {
    throw new Error("owned Gateway is unavailable");
  }
  const text = `Synthetic recap for cohort ${cohort?.id}.`;
  await ensureRecaps(client);
  await waitForCurrentRecaps(text);
  await drainEvents();
  const initial = sessionEventSizesSnapshot();
  const initialModelRequests = recapRequests;
  const profilePath =
    values["cpu-profile"] && measuredRound !== undefined
      ? path.join(output, `recap-ensure-${measuredRound}.cpuprofile`)
      : undefined;
  if (profilePath) {
    await controlGatewayProfile(child, "cpu", "start", profilePath);
  }
  const beforeRepeatCpu = await readGatewayCpuUsage(child);
  const startedAtEpochMs = epochNow();
  const repeats = [];
  for (let repeat = 0; repeat < recapBurstRepeats; repeat++) {
    const started = epochNow();
    const responseStates = await ensureRecaps(client);
    repeats.push({ startedAtEpochMs: started, completedAtEpochMs: epochNow(), responseStates });
    if (repeat + 1 < recapBurstRepeats) {
      await delay(Math.max(0, recapBurstIntervalMs - (epochNow() - started)));
    }
  }
  const lastRepeat = repeats.at(-1);
  await waitForCurrentRecaps(
    text,
    lastRepeat?.startedAtEpochMs,
    keys.filter((_, index) => lastRepeat?.responseStates[index] === "updating"),
  );
  await drainEvents();
  const completedAtEpochMs = epochNow();
  const repeatCpu = measureGatewayCpuUsage(beforeRepeatCpu, await readGatewayCpuUsage(child));
  if (profilePath) {
    await controlGatewayProfile(child, "cpu", "stop", profilePath);
  }
  const noopSizes = Object.fromEntries(
    [...sessionEventSizes].map(([bucket, sizes]) => [
      bucket,
      {
        frames: sizes.frames - (initial[bucket]?.frames ?? 0),
        bytes: sizes.bytes - (initial[bucket]?.bytes ?? 0),
      },
    ]),
  );
  for (const key of keys) {
    const result = await rpc(client, "sessions.describe", { key });
    const row = isRecord(result) && isRecord(result.session) ? result.session : undefined;
    const summary = row && isRecord(row.activitySummary) ? row.activitySummary : undefined;
    if (
      !summary ||
      summary.state !== "current" ||
      summary.text !== text ||
      perClientRecaps.some((rows) => rows.get(key)?.updatedAt !== summary.updatedAt)
    ) {
      throw new Error(`delivered recap differs from the final authoritative row for ${key}`);
    }
  }
  const latestValueDelivery = perClientRecaps.flatMap((_, clientIndex) =>
    keys.map((key) => {
      const receipt = recapReceipts.find(
        (candidate) =>
          candidate.client === clientIndex &&
          candidate.key === key &&
          candidate.state === "current" &&
          candidate.text === text,
      );
      if (!receipt || typeof receipt.updatedAt !== "number") {
        throw new Error(`client ${clientIndex} missed the final activity-summary event for ${key}`);
      }
      return {
        client: clientIndex,
        key,
        committedToReceivedMs: receipt.receivedAtEpochMs - receipt.updatedAt,
      };
    }),
  );
  return {
    latestValueDelivery,
    finalRecapsMatch: true,
    turnAndInitialRecap: { modelRequests: initialModelRequests, sessionEventSizes: initial },
    repeatedEnsure: {
      repeats,
      intervalMs: recapBurstIntervalMs,
      startedAtEpochMs,
      completedAtEpochMs,
      ...repeatCpu,
      ...(profilePath ? { cpuProfile: summarizeCpuProfile(profilePath) } : {}),
      modelRequests: recapRequests - initialModelRequests,
      sessionEventSizes: noopSizes,
      finalReceiptAfterLastEnsureMs: lastRepeat
        ? Math.max(
            0,
            ...perClientRecaps.flatMap((rows) =>
              keys.map((key) => rows.get(key)!.receivedAtEpochMs - lastRepeat.completedAtEpochMs),
            ),
          )
        : null,
    },
  };
}
function sessionEventSizesSnapshot() {
  return Object.fromEntries(
    [...sessionEventSizes].map(([bucket, sizes]) => [bucket, { ...sizes }]),
  );
}
function trackClientFrames(
  client: ReturnType<typeof createGatewayWsClient>,
  onFrame?: (bytes: number) => void,
) {
  const responseSizes = new Map<string, number>();
  responseFrameBytes.set(client, responseSizes);
  // The helper parses frames before onEvent; capture their exact uncompressed size first.
  client.ws.prependListener("message", (data: import("ws").RawData) => {
    const receivedFrameBytes = Array.isArray(data)
      ? data.reduce((sum, part) => sum + part.byteLength, 0)
      : data.byteLength;
    onFrame?.(receivedFrameBytes);
    if (measuring) {
      const frame = JSON.parse(rawDataToString(data));
      if (frame.type === "res" && typeof frame.id === "string") {
        responseSizes.set(frame.id, receivedFrameBytes);
      }
    }
  });
}
async function connectClient(index: number) {
  const started = performance.now();
  assertGatewayAlive();
  const clientCounters = (perClientCounters[index] ??= new Map<string, number>());
  const recapRows = new Map<string, RecapReceipt>();
  perClientRecaps[index] = recapRows;
  const rowEvents = new GatewaySessionRowEvents();
  let previousSeq: number | undefined;
  let receivedFrameBytes = 0;
  const client = createGatewayWsClient({
    url: `ws://127.0.0.1:${port}`,
    onEvent: (event) => {
      lastSubscriberEventAt = performance.now();
      if (event.seq !== undefined) {
        if (previousSeq !== undefined && event.seq !== previousSeq + 1) {
          subscriberFailure ??= new Error(
            `client ${index} event sequence gap: ${previousSeq} -> ${event.seq}`,
          );
        }
        previousSeq = event.seq;
      }
      const payload = isRecord(event.payload) ? event.payload : undefined;
      if (values["activity-summaries"]) {
        const decoded = rowEvents.project(event);
        if (decoded.missingBaseline) {
          subscriberFailure ??= new Error(`client ${index} lost its session row baseline`);
        }
        const facts = isRecord(decoded.event.payload) ? decoded.event.payload : undefined;
        const row = facts && isRecord(facts.session) ? facts.session : undefined;
        const summary = row && isRecord(row.activitySummary) ? row.activitySummary : undefined;
        if (summary && typeof facts?.sessionKey === "string" && keys.includes(facts.sessionKey)) {
          const receipt = {
            client: index,
            key: facts.sessionKey,
            state: summary.state,
            text: summary.text,
            updatedAt: summary.updatedAt,
            receivedAtEpochMs: epochNow(),
          };
          recapRows.set(facts.sessionKey, receipt);
          if (facts.reason === "activity-summary") {
            recapReceipts.push(receipt);
          }
        }
      }
      if (index === 0 && !initialFullFrame && event.event === "sessions.changed" && payload) {
        const sizes = measureFrameFields(event, payload, receivedFrameBytes);
        if (sizes.duplicateEnvelopeFields !== undefined) {
          initialFullFrame = sizes;
        }
      }
      if (measuring) {
        counters.set(event.event, (counters.get(event.event) ?? 0) + 1);
        clientCounters.set(event.event, (clientCounters.get(event.event) ?? 0) + 1);
        eventBytes.set(event.event, (eventBytes.get(event.event) ?? 0) + receivedFrameBytes);
        const attribution = prepareSessionEventMetrics(event.event, payload, [], undefined)?.("");
        if (attribution) {
          const delivery =
            index < exactClients &&
            typeof payload?.sessionKey === "string" &&
            keys.includes(payload.sessionKey)
              ? "subscribed"
              : "roster";
          const bucket = `${event.event}:${attribution.reason}:${delivery}`;
          const sizes = sessionEventSizes.get(bucket) ?? { frames: 0, bytes: 0 };
          sizes.frames++;
          sizes.bytes += receivedFrameBytes;
          sessionEventSizes.set(bucket, sizes);
          if (
            index === 0 &&
            event.event === "sessions.changed" &&
            payload &&
            receivedFrameBytes > (representativeFrames.get(bucket)?.frameBytes ?? 0)
          ) {
            representativeFrames.set(
              bucket,
              measureFrameFields(event, payload, receivedFrameBytes),
            );
          }
        }
      }
    },
  });
  trackClientFrames(client, (bytes) => {
    receivedFrameBytes = bytes;
  });
  client.ws.on("close", (code) => {
    if (!closing && !expectedClosures.has(client)) {
      subscriberFailure ??= new Error(`subscriber ${index} unexpectedly closed (${code})`);
    }
  });
  client.ws.on("error", (error) => {
    if (!closing && !expectedClosures.has(client)) {
      subscriberFailure ??= new Error(`subscriber ${index}: ${error.message}`);
    }
  });
  clients[index] = client;
  await client.waitOpen();
  const hello = await rpc(client, "connect", connectParams);
  const handshakeElapsedMs = performance.now() - started;
  if (
    !Value.Check(HelloOkSchema, hello) ||
    hello.protocol !== PROTOCOL_VERSION ||
    !hello.features.methods.includes("sessions.list") ||
    !hello.features.methods.includes("sessions.describe") ||
    hello.auth.role !== "operator" ||
    !hello.auth.scopes.includes("operator.admin") ||
    hello.snapshot.sessionDefaults?.defaultAgentId !== "main"
  ) {
    throw new Error("connect did not return a valid hello snapshot");
  }
  if (measuring) {
    handshakeLatenciesMs.push(handshakeElapsedMs);
  }
  return client;
}
let cleanupPromise: Promise<void> | undefined;
function cleanup() {
  return (cleanupPromise ??= (async () => {
    closing = true;
    cohort?.release();
    if (stressCronJobId) {
      try {
        const result = await clients[0]?.request("cron.remove", { id: stressCronJobId }, 5000);
        if (!result?.ok) {
          throw new Error("cron.remove did not succeed");
        }
      } catch (error) {
        console.warn("Stress cron cleanup failed; discard this fixture before reuse:", error);
      }
    }
    for (const client of clients) {
      client.close();
    }
    await Promise.all(
      children.map((child) => stopChild(child, { teardownGraceMs: 10_000, killGraceMs: 2000 })),
    );
    await Promise.all(childLogs.map((log) => finished(log)));
    mock.closeAllConnections();
    if (mock.listening) {
      await new Promise<void>((resolve, reject) => {
        mock.close((error) => (error ? reject(error) : resolve()));
      });
    }
    if (stressWorktree && diffControlOriginal !== undefined) {
      writeFileSync(path.join(stressWorktree, "README.md"), diffControlOriginal);
    }
  })());
}
for (const [signal, exitCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(exitCode));
  });
}
try {
  await assertPortAvailable(port);
  await assertPortAvailable(mockPort);
  await new Promise<void>((resolve, reject) => {
    mock.once("error", reject);
    mock.listen(mockPort, "127.0.0.1", resolve);
  });
  await ready(mockPort, "/health");
  gateway = launch(
    buildGatewayBenchChildArgs(values.entry, port, [
      ...(values.allocations || values["stream-start-allocations"] || values["trace-gc"]
        ? ["--trace-gc-nvp"]
        : []),
      "--import",
      "./scripts/tsx.mjs",
      "--import",
      "./scripts/lib/gateway-bench-profile-preload.ts",
    ]),
    "gateway",
    {},
    true,
  );
  await ready(port, "/readyz", gateway);
  await readGatewayCpuUsage(gateway);
  console.log("PHASE gateway-ready");
  // Startup recovery for the retained-run inventory is outside the measured workload.
  await delay(10_000);
  for (let index = 0; index < clientCount; index++) {
    const client = await connectClient(index);
    if (index === 0) {
      if (!historyTurns) {
        await rpc(client, "sessions.create", {
          key: parentKey,
          ...(stressWorktree ? { cwd: stressWorktree } : {}),
          visibility: "shared",
          displayName: "Synthetic broadcast parent",
        });
        await rpc(client, "sessions.reset", { key: parentKey });
      }
      if (values["stress-subagents"]) {
        await rpc(client, "sessions.create", {
          key: stressParentKey,
          cwd: stressWorktree,
          visibility: "shared",
          displayName: "Synthetic native subagent parent",
        });
      }
      for (const key of keys) {
        if (historyTurns) {
          continue;
        }
        await rpc(client, "sessions.create", {
          key,
          ...(stressWorktree ? { cwd: stressWorktree } : {}),
          ...(values["activity-summaries"] ? {} : { parentSessionKey: parentKey, spawnDepth: 1 }),
          fork: false,
          visibility: "shared",
          displayName: "Synthetic broadcast child",
        });
        await rpc(client, "sessions.reset", { key });
      }
    }
    await rpc(client, "sessions.subscribe", {});
    for (const key of index < exactClients ? keys : []) {
      await rpc(client, "sessions.messages.subscribe", { key, subscriptionId: key });
    }
  }
  const sender = clients[0];
  if (!sender) {
    throw new Error("no sender client");
  }
  const expectedSidebar =
    scenario === "reconnect"
      ? sidebarIdentity(await rpc(sender, "sessions.list", { limit, rowMode, archived: "all" }))
      : undefined;
  if (stressWorktree && diffControlOriginal !== undefined) {
    // First work captures the baseline; later child announcements must not capture our edit.
    const runId = randomUUID();
    await rpc(sender, "agent", {
      sessionKey: parentKey,
      message: "Acknowledge this synthetic diff baseline preparation.",
      deliver: false,
      idempotencyKey: runId,
    });
    const result = await rpc(sender, "agent.wait", { runId, timeoutMs: 170_000 });
    if (!isRecord(result) || result.status !== "ok") {
      throw new Error(`diff baseline preparation failed: ${JSON.stringify(result)}`);
    }
    writeFileSync(
      path.join(stressWorktree, "README.md"),
      `${diffControlOriginal}Synthetic diff control.\n`,
    );
  }
  if (soakScenario && values["stress-tools"]) {
    const job = await rpc(sender, "cron.add", {
      name: "Synthetic allocation stress cron",
      agentId: "main",
      enabled: true,
      schedule: { kind: "every", everyMs: 30_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "Acknowledge this synthetic scheduled allocation probe.",
        timeoutSeconds: 120,
      },
      delivery: { mode: "none" },
      failureAlert: false,
    });
    if (!isRecord(job) || typeof job.id !== "string") {
      throw new Error("stress cron.add did not return a job ID");
    }
    stressCronJobId = job.id;
    const run = await rpc(sender, "cron.run", {
      id: job.id,
      mode: "force",
      waitTimeoutMs: 170_000,
    });
    if (!isRecord(run) || !isRecord(run.run) || run.run.status !== "ok") {
      throw new Error(`stress cron did not complete its real agent turn: ${JSON.stringify(run)}`);
    }
  }
  console.log("PHASE subscribed-and-reset");
  let idleTurnCohorts: Awaited<ReturnType<typeof runRound>>[] = [];
  const runScenario = async (measuredRound?: number) => {
    if (idleScenario) {
      idleTurnCohorts = [];
      for (let offset = 0; offset < keys.length; offset += runCount) {
        idleTurnCohorts.push(
          await runRound(sender, measuredRound, keys.slice(offset, offset + runCount)),
        );
      }
      return undefined;
    }
    if (turnScenario) {
      const streamStart = await runRound(sender, measuredRound);
      if (values["activity-summaries"]) {
        recapPhase = await runRecapBurst(sender, measuredRound);
      }
      return streamStart;
    }
    for (let offset = 0; offset < operations; offset += clientCount) {
      const batchCount = Math.min(clientCount, operations - offset);
      const batchStarted = performance.now();
      const reconnectStarted: number[] = [];
      const slots = clients.slice(0, batchCount).entries();
      await Promise.all(
        clients.slice(0, Math.min(rpcConcurrency, batchCount)).map(async (workerClient) => {
          for (const [index, oldClient] of slots) {
            if (connectionScenario) {
              if (scenario === "reconnect") {
                await delay(
                  Math.max(0, batchStarted + index * reconnectStaggerMs - performance.now()),
                );
                reconnectStarted.push(performance.now() - batchStarted);
              }
              expectedClosures.add(oldClient);
              const closed = once(oldClient.ws, "close");
              oldClient.close();
              await closed;
              const client = await connectClient(index);
              if (scenario === "reconnect") {
                const subscription = await rpc(client, "sessions.subscribe", {
                  limit,
                  rowMode,
                  archived: "all",
                });
                assertListPage(
                  isRecord(subscription) && subscription.subscribed === true
                    ? subscription.list
                    : undefined,
                  "sessions.subscribe",
                );
                for (const key of index < exactClients ? keys : []) {
                  await rpc(client, "sessions.messages.subscribe", { key, subscriptionId: key });
                }
                const sidebar = await rpc(client, "sessions.list", {
                  limit,
                  rowMode,
                  archived: "all",
                });
                if (sidebarIdentity(sidebar) !== expectedSidebar) {
                  throw new Error(
                    `reconnected client ${index} did not recover the current sidebar`,
                  );
                }
              }
            } else if (scenario === "sessions.list" || scenario === "subscribe") {
              const method = scenario === "subscribe" ? "sessions.subscribe" : "sessions.list";
              const result = await rpc(workerClient, method, {
                limit,
                rowMode,
                archived: "all",
              });
              assertListPage(
                scenario === "subscribe"
                  ? isRecord(result) && result.subscribed === true
                    ? result.list
                    : undefined
                  : result,
                method,
              );
            } else if (scenario === "sessions.describe") {
              const result = await rpc(workerClient, "sessions.describe", {
                key: parentKey,
              });
              const row = isRecord(result) ? result.session : undefined;
              const childKeys = isRecord(row) ? row.childSessions : undefined;
              if (
                !isRecord(row) ||
                row.key !== parentKey ||
                !Array.isArray(childKeys) ||
                childKeys.length !== keys.length ||
                !keys.every((key) => childKeys.includes(key))
              ) {
                throw new Error("sessions.describe did not return the parent with seeded children");
              }
            } else {
              const result = await rpc(workerClient, "plugins.reload", {
                plugins: [{ pluginId: reloadPluginId }],
                waitForDrain: true,
              });
              if (!isRecord(result) || result.restartRequired !== false) {
                throw new Error("synthetic plugin reload did not apply live");
              }
            }
          }
        }),
      );
      if (scenario === "reconnect") {
        const startSpreadMs = Math.max(...reconnectStarted) - Math.min(...reconnectStarted);
        if (startSpreadMs > 5000) {
          throw new Error("reconnect starts exceeded 5000 ms; increase --rpc-concurrency");
        }
        if (measuring) {
          reconnectStorms.push({
            clients: batchCount,
            startSpreadMs,
            allSidebarsCurrentMs: performance.now() - batchStarted,
          });
        }
      }
    }
    return undefined;
  };
  const warmupStartedAt = performance.now();
  do {
    // Warm runtime imports on the parent, leaving all measured sessions untouched.
    if (idleScenario) {
      await runRound(sender, undefined, [parentKey]);
      await drainEvents();
      break;
    }
    const started = performance.now();
    await runScenario();
    await drainEvents();
    if (!soakScenario) {
      break;
    }
    await delay(
      Math.max(
        0,
        Math.min(
          roundIntervalMs - (performance.now() - started),
          warmupMs - (performance.now() - warmupStartedAt),
        ),
      ),
    );
  } while (performance.now() - warmupStartedAt < warmupMs);
  console.log("PHASE warmed");
  if (startAt !== undefined) {
    if (Date.now() >= startAt) {
      throw new Error("--start-at passed before fixture readiness and warmup");
    }
    await delay(startAt - Date.now());
  }
  const initialRetainedResources = reasoningScenario
    ? await readGatewayResources(gateway, {
        collectGarbage: !soakScenario || !values.allocations,
        sessionCensus: values["session-census"],
        ...(idleScenario && values["heap-snapshot"]
          ? { snapshotPath: path.join(output, "initial.heapsnapshot") }
          : {}),
      })
    : undefined;
  const soakAllocationPath =
    soakScenario && values.allocations
      ? path.join(output, "allocation-soak.heapprofile")
      : undefined;
  // A twenty-minute churn profile needs coarser sampling to bound native records and JSON export.
  const soakSamplingIntervalBytes = 512 * 1024;
  if (soakAllocationPath) {
    // Reading or stopping a V8 sampling profile forces GC; keep one window for the entire soak.
    await controlGatewayProfile(gateway, "heap", "start", soakAllocationPath, {
      samplingIntervalBytes: soakSamplingIntervalBytes,
    });
  }
  const measurementStartedAt = Date.now();
  const measuredGateway = gateway;
  const finishWholeSoakDiagnostics =
    soakScenario && (values.diagnostics || values.allocations || values["trace-gc"])
      ? await startGatewayDiagnostics(gateway, "whole-soak")
      : undefined;
  const samples = [];
  const memorySamples: Array<{
    atEpochMs: number;
    elapsedMs: number;
    completedRounds: number;
    sessionResets: number;
    collectedGarbage: boolean;
    resources: Awaited<ReturnType<typeof readGatewayResources>>;
    phase?: string;
  }> = [];
  const sampleMemory = async (collectGarbage = false, phase?: string) => {
    const resources = await readGatewayResources(measuredGateway, {
      collectGarbage,
      sessionCensus: collectGarbage && values["session-census"],
      ...(idleScenario && phase && values["heap-snapshot"]
        ? { snapshotPath: path.join(output, `${phase}.heapsnapshot`) }
        : {}),
    });
    const sample = {
      atEpochMs: Date.now(),
      elapsedMs: Date.now() - measurementStartedAt,
      completedRounds: samples.length,
      sessionResets,
      collectedGarbage: collectGarbage,
      resources,
      ...(phase ? { phase } : {}),
    };
    memorySamples.push(sample);
    appendFileSync(path.join(output, "memory-samples.jsonl"), `${JSON.stringify(sample)}\n`);
    console.log(`MEMORY ${JSON.stringify(sample)}`);
    return resources;
  };
  const idleHistories = new Map<string, { messages: number; digest: string }>();
  const verifyIdleHistories = async (phase: "touched" | "reopened") => {
    for (const sessionKey of keys) {
      const messages: unknown[] = [];
      let offset = 0;
      while (true) {
        const history = await rpc(sender, "chat.history", { sessionKey, limit: 100, offset });
        if (!isRecord(history) || !Array.isArray(history.messages)) {
          throw new Error(`missing idle-session history: ${sessionKey}`);
        }
        messages.unshift(...history.messages);
        if (!history.hasMore) {
          break;
        }
        if (typeof history.nextOffset !== "number" || history.nextOffset <= offset) {
          throw new Error(`idle-session history pagination did not advance: ${sessionKey}`);
        }
        offset = history.nextOffset;
      }
      if (messages.length < historyTurns * 4) {
        throw new Error(`seeded idle-session history was lost: ${sessionKey}`);
      }
      const digest = (entries: unknown[]) =>
        createHash("sha256").update(JSON.stringify(entries)).digest("hex");
      const previous = idleHistories.get(sessionKey);
      if (previous && digest(messages.slice(0, previous.messages)) !== previous.digest) {
        throw new Error(`idle-session transcript changed during ${phase}: ${sessionKey}`);
      }
      const answers = messages.filter(
        (message) =>
          isRecord(message) &&
          message.role === "assistant" &&
          contentText(message.content).trim() === chunk.repeat(chunkCount).trim(),
      );
      if (answers.length !== (phase === "reopened" ? 2 : 1)) {
        throw new Error(`idle-session answer missing or duplicated during ${phase}: ${sessionKey}`);
      }
      if (phase === "touched") {
        idleHistories.set(sessionKey, { messages: messages.length, digest: digest(messages) });
      }
    }
  };
  let postIdleResources: Awaited<ReturnType<typeof readGatewayResources>> | undefined;
  let idleDiagnostics: ReturnType<ReturnType<typeof startGatewayBenchDiagnostics>> | undefined;
  const retainedProfilePath = path.join(output, "retained.heapprofile");
  let retainedProfileStartedAt: number | undefined;
  if (soakScenario) {
    await sampleMemory();
  }
  for (
    let round = 0;
    soakScenario
      ? Date.now() - measurementStartedAt < durationMs
      : round < (idleScenario ? 2 : rounds);
    round++
  ) {
    const roundStartedAt = Date.now();
    if (
      soakScenario &&
      retainedProfileMs > 0 &&
      retainedProfileStartedAt === undefined &&
      roundStartedAt - measurementStartedAt >= durationMs - retainedProfileMs
    ) {
      await controlGatewayProfile(gateway, "heap", "start", retainedProfilePath, {
        includeCollectedObjects: false,
      });
      retainedProfileStartedAt = Date.now();
    }
    counters.clear();
    rpcMeasurements.clear();
    handshakeLatenciesMs.length = 0;
    reconnectStorms.length = 0;
    eventBytes.clear();
    sessionEventSizes.clear();
    representativeFrames.clear();
    for (const counts of perClientCounters) {
      counts.clear();
    }
    peakStreams = 0;
    peakPrimaryStreams = 0;
    streamRequests = 0;
    primaryStreamRequests = 0;
    toolCalls = 0;
    toolResults = 0;
    outputLimitResponses = 0;
    recoveredResponses = 0;
    imageRequests = 0;
    reasoningResponses = 0;
    reasoningReplayRequests = 0;
    recapRequests = 0;
    recapReceipts.length = 0;
    recapPhase = undefined;
    activeWorkCounts = undefined;
    const finishGatewayDiagnostics = values.diagnostics
      ? await startGatewayDiagnostics(gateway)
      : undefined;
    const finishControllerDiagnostics = values.diagnostics
      ? startGatewayBenchDiagnostics()
      : undefined;
    const before = await readGatewayCpuUsage(gateway);
    const workloadCpuProfilePath = values["workload-cpu-profile"]
      ? path.join(output, `workload-${round}.cpuprofile`)
      : undefined;
    measuring = !workloadCpuProfilePath;
    const rpcLatencies: Record<string, number[]> = {
      "sessions.list": [],
      "chat.history": [],
      "sessions.diff": [],
      connect: [],
    };
    const listLatencies = rpcLatencies["sessions.list"]!;
    const initialPollPhasesMs: number[] = [];
    let streamStart: Awaited<ReturnType<typeof runRound>> | undefined;
    const listRequests: Array<{
      method: string;
      responseId: string;
      client: number;
      round: number;
      startedAtEpochMs: number;
      endedAtEpochMs: number;
      durationMs: number;
    }> = [];
    const workload = async () => {
      let polling = true;
      let stopPolling!: () => void;
      const stopped = new Promise<void>((resolve) => {
        stopPolling = resolve;
      });
      const listWork = listIntervalMs
        ? Promise.all(
            clients
              .map(async (client, clientIndex) => {
                const random = createPollRandom(round, clientIndex);
                const initialPhaseMs = random ? random() * listIntervalMs : 0;
                initialPollPhasesMs[clientIndex] = initialPhaseMs;
                if (random) {
                  await Promise.race([delay(initialPhaseMs, undefined, { ref: false }), stopped]);
                }
                let poll = clientIndex;
                while (true) {
                  if (!polling) {
                    break;
                  }
                  const started = performance.now();
                  let responseId = "";
                  const method = values["mixed-rpc"]
                    ? ["sessions.list", "chat.history", "sessions.diff", "connect"][poll++ % 4]!
                    : "sessions.list";
                  const onResponse = recordListRequests
                    ? (id: string) => {
                        responseId = id;
                      }
                    : undefined;
                  if (method === "connect") {
                    const peer = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
                    trackClientFrames(peer);
                    try {
                      await peer.waitOpen();
                      const hello = await rpc(peer, "connect", connectParams, onResponse);
                      if (!Value.Check(HelloOkSchema, hello)) {
                        throw new Error("fresh connect did not return hello-ok");
                      }
                    } finally {
                      peer.close();
                    }
                  } else if (method === "chat.history") {
                    const history = await rpc(
                      client,
                      method,
                      {
                        sessionKey: `agent:main:team-shape-session-${clientIndex % fixtureSessionCount}`,
                        limit: 50,
                      },
                      onResponse,
                    );
                    if (
                      !isRecord(history) ||
                      !Array.isArray(history.messages) ||
                      !history.messages.length
                    ) {
                      throw new Error(
                        "chat.history did not return the retained fixture transcript",
                      );
                    }
                  } else if (method === "sessions.diff") {
                    validateDiff(
                      await rpc(
                        client,
                        method,
                        {
                          sessionKey: parentKey,
                          scope: "all",
                          summaryOnly: true,
                        },
                        onResponse,
                      ),
                    );
                  } else {
                    const page = await rpc(
                      client,
                      method,
                      { rowMode, limit, archived: "all" },
                      onResponse,
                    );
                    if (
                      !isRecord(page) ||
                      typeof page.totalCount !== "number" ||
                      page.count !== Math.min(limit, page.totalCount) ||
                      !Array.isArray(page.sessions) ||
                      page.sessions.length !== page.count ||
                      page.count === 0
                    ) {
                      throw new Error("concurrent sessions.list did not return the requested page");
                    }
                  }
                  const ended = performance.now();
                  const requestDurationMs = ended - started;
                  rpcLatencies[method]!.push(requestDurationMs);
                  if (recordListRequests) {
                    listRequests.push({
                      method,
                      responseId,
                      client: clientIndex,
                      round,
                      startedAtEpochMs: performance.timeOrigin + started,
                      endedAtEpochMs: performance.timeOrigin + ended,
                      durationMs: requestDurationMs,
                    });
                  }
                  const intervalMs = random ? listIntervalMs * (0.5 + random()) : listIntervalMs;
                  await Promise.race([
                    delay(Math.max(0, intervalMs - (performance.now() - started)), undefined, {
                      ref: false,
                    }),
                    stopped,
                  ]);
                }
              })
              .map((work) =>
                work.catch((error: unknown) => {
                  subscriberFailure ??= error instanceof Error ? error : new Error(String(error));
                  polling = false;
                  stopPolling();
                }),
              ),
          )
        : undefined;
      try {
        streamStart = await runScenario(round);
        await drainEvents();
      } finally {
        polling = false;
        stopPolling();
        await listWork;
      }
    };
    const measuredWorkload = workloadCpuProfilePath
      ? async () => {
          await controlGatewayProfile(measuredGateway, "cpu", "start", workloadCpuProfilePath);
          measuring = true;
          try {
            await workload();
          } finally {
            measuring = false;
            await controlGatewayProfile(measuredGateway, "cpu", "stop", workloadCpuProfilePath);
          }
        }
      : workload;
    const allocation =
      values.allocations && !soakScenario
        ? await measureGatewayAllocations(
            gateway,
            path.join(output, `allocation-${round}.heapprofile`),
            turnScenario ? sessionCount : operations,
            measuredWorkload,
          )
        : undefined;
    if (!values.allocations || soakScenario) {
      await measuredWorkload();
    }
    if (values["mixed-rpc"] && Object.values(rpcLatencies).some((latencies) => !latencies.length)) {
      throw new Error("mixed RPC workload must observe every method; increase cohort duration");
    }
    if (listIntervalMs && listLatencies.length === 0) {
      throw new Error("No sessions.list samples collected; shorten --list-interval-ms");
    }
    measuring = false;
    const diagnostics = finishGatewayDiagnostics
      ? { gateway: await finishGatewayDiagnostics(), controller: finishControllerDiagnostics?.() }
      : undefined;
    assertGatewayAlive();
    if (clients.some((client) => client.ws.readyState !== client.ws.OPEN)) {
      throw new Error("a subscriber was lost during the measured round");
    }
    if (
      turnScenario &&
      (peakPrimaryStreams !== Math.min(runCount, sessionCount) ||
        primaryStreamRequests !== sessionCount)
    ) {
      throw new Error(
        `expected ${sessionCount} primary streams with ${Math.min(runCount, sessionCount)} concurrent: peak=${peakPrimaryStreams}, requests=${primaryStreamRequests}`,
      );
    }
    if (
      (scenario === "chat.send" || soakScenario || idleScenario) &&
      (toolCalls !== sessionCount || toolResults !== sessionCount)
    ) {
      throw new Error(
        `expected ${sessionCount} completed tool calls, calls=${toolCalls}, results=${toolResults}`,
      );
    }
    if (
      retentionScenario &&
      (toolCalls !== runCount * toolPaths.length ||
        toolResults !== toolCalls ||
        outputLimitResponses !== runCount ||
        recoveredResponses !== runCount ||
        imageRequests !== runCount * 3)
    ) {
      throw new Error(
        `expected ${runCount} image/tool/recovery cycles: ${JSON.stringify({ toolCalls, toolResults, outputLimitResponses, recoveredResponses, imageRequests })}`,
      );
    }
    if (
      reasoningScenario &&
      (reasoningResponses !== sessionCount * (retentionScenario ? 3 : 2) ||
        reasoningReplayRequests !== sessionCount * (retentionScenario ? 2 : 1))
    ) {
      throw new Error(
        `incomplete synthetic reasoning replay: ${JSON.stringify({ reasoningResponses, reasoningReplayRequests })}`,
      );
    }
    for (const event of turnScenario ? ["session.message", "sessions.changed"] : []) {
      const expected = perClientCounters[0]?.get(event) ?? 0;
      if (!expected || perClientCounters.some((counts) => counts.get(event) !== expected)) {
        throw new Error(
          `incomplete ${event} fanout: ${JSON.stringify(perClientCounters.map((counts) => counts.get(event) ?? 0))}`,
        );
      }
    }
    if (
      values["activity-summaries"] &&
      (!recapRequests ||
        ![...sessionEventSizes].some(
          ([bucket, counts]) =>
            bucket.startsWith("sessions.changed:activity-summary:") && counts.frames > 0,
        ))
    ) {
      throw new Error(
        "activity recap model requests and sessions.changed events were not observed",
      );
    }
    const cpu = measureGatewayCpuUsage(before, await readGatewayCpuUsage(gateway));
    const retainedResources =
      retentionScenario || idleScenario
        ? await readGatewayResources(gateway, {
            collectGarbage: true,
            sessionCensus: values["session-census"],
            ...(idleScenario && values["heap-snapshot"]
              ? {
                  snapshotPath: path.join(
                    output,
                    round === 0 ? "post-work.heapsnapshot" : "post-reopen.heapsnapshot",
                  ),
                }
              : {}),
            ...(retentionScenario && values["heap-snapshot"] && round === rounds - 1
              ? { snapshotPath: path.join(output, "settled.heapsnapshot") }
              : {}),
          })
        : undefined;
    const deliveredEvents = [...counters.values()].reduce((sum, count) => sum + count, 0);
    const deliveredSessionEvents =
      (counters.get("session.message") ?? 0) + (counters.get("sessions.changed") ?? 0);
    const sourceEvents = deliveredSessionEvents / clientCount;
    const sortedListLatencies = listLatencies.toSorted((a, b) => a - b);
    const sample = {
      round,
      scenario,
      allocation,
      ...(workloadCpuProfilePath
        ? { workloadCpuProfile: summarizeCpuProfile(workloadCpuProfilePath) }
        : {}),
      rpc: Object.fromEntries(
        [...rpcMeasurements].map(([method, measurements]) => [
          method,
          {
            ...latencySummary(measurements.latenciesMs),
            callsPerMinute: (measurements.latenciesMs.length / cpu.wallMs) * 60_000,
            responseBytes: measurements.responseBytes,
            responseBytesPerCall: measurements.responseBytes / measurements.latenciesMs.length,
            ...(measurements.representativeResponse
              ? { representativeResponse: measurements.representativeResponse }
              : {}),
          },
        ]),
      ),
      ...(connectionScenario
        ? {
            handshake: latencySummary(handshakeLatenciesMs),
            reconnectStorms: [...reconnectStorms],
          }
        : {}),
      ...(turnScenario && allocation
        ? { allocatedMbPerTurn: allocation.estimatedAllocatedBytesPerOperation / 1_000_000 }
        : {}),
      diagnostics,
      streamStart,
      ...(values["mixed-rpc"]
        ? {
            rpcLatencyMs: Object.fromEntries(
              Object.entries(rpcLatencies).map(([method, latencies]) => [
                method,
                summarizeLatencies(latencies),
              ]),
            ),
          }
        : {}),
      activeWorkCounts,
      toolCalls,
      toolResults,
      ...(reasoningScenario && { reasoningResponses, reasoningReplayRequests }),
      recapRequests,
      ...(values["activity-summaries"] ? { recapPhase, recapReceipts: [...recapReceipts] } : {}),
      ...(retentionScenario
        ? { outputLimitResponses, recoveredResponses, imageRequests, retainedResources }
        : {}),
      ...(idleScenario
        ? {
            phase: round === 0 ? "touch" : "reopen",
            retainedResources,
            turnCohorts: idleTurnCohorts,
          }
        : {}),
      ...cpu,
      eventCounts: Object.fromEntries(counters),
      eventBytes: Object.fromEntries(eventBytes),
      sessionEventSizes: Object.fromEntries(sessionEventSizes),
      representativeFrames: Object.fromEntries(representativeFrames),
      ...(listIntervalMs
        ? {
            sessionsList: {
              count: listLatencies.length,
              p50: sortedListLatencies[Math.ceil(listLatencies.length * 0.5) - 1],
              p95: sortedListLatencies[Math.ceil(listLatencies.length * 0.95) - 1],
              p99: sortedListLatencies[Math.ceil(listLatencies.length * 0.99) - 1],
              latencies: listLatencies,
              ...(values["poll-seed"] !== undefined ? { initialPollPhasesMs } : {}),
              ...(recordListRequests
                ? {
                    requests: listRequests.filter((request) => request.method === "sessions.list"),
                    p99Request: listRequests
                      .filter((request) => request.method === "sessions.list")
                      .toSorted((a, b) => a.durationMs - b.durationMs)[
                      Math.ceil(listLatencies.length * 0.99) - 1
                    ],
                  }
                : {}),
            },
          }
        : {}),
      perClientEventCounts: perClientCounters.map((counts) => Object.fromEntries(counts)),
      peakStreams,
      peakPrimaryStreams,
      primaryStreamRequests,
      utilityStreamRequests:
        streamRequests -
        primaryStreamRequests -
        (retentionScenario ? outputLimitResponses + recoveredResponses : toolResults),
      streamRequests,
      deliveredEvents,
      deliveredSessionEvents,
      sourceEvents,
      mainThreadMsPerSessionEvent: sourceEvents ? cpu.mainThread.totalMs / sourceEvents : null,
      mainThreadMsPerSessionEventDelivery: deliveredSessionEvents
        ? cpu.mainThread.totalMs / deliveredSessionEvents
        : null,
      estimatedAllocatedBytesPerSessionEvent:
        allocation && sourceEvents ? allocation.sampledAllocatedBytes / sourceEvents : null,
      mainThreadMsPerSecond: (cpu.mainThread.totalMs / cpu.wallMs) * 1000,
      sessionEventsPerSecond: (sourceEvents / cpu.wallMs) * 1000,
    };
    samples.push(sample);
    console.log(
      JSON.stringify(sample, (key, value) =>
        key === "representativeResponse" ? undefined : value,
      ),
    );
    if (idleScenario) {
      await verifyIdleHistories(round === 0 ? "touched" : "reopened");
      if (round === 0) {
        const finishIdleDiagnostics = await startGatewayDiagnostics(gateway, "session-idle");
        const idleStartedAt = Date.now();
        while (Date.now() - idleStartedAt < durationMs) {
          await delay(Math.min(memoryIntervalMs, durationMs - (Date.now() - idleStartedAt)));
          assertGatewayAlive();
          await sampleMemory();
        }
        idleDiagnostics = await finishIdleDiagnostics();
        postIdleResources = await sampleMemory(true, "post-idle");
        // Verify the retained prefix after reopening; reading it now warms idle workers.
      }
    }
    if (soakScenario) {
      if (Date.now() - (memorySamples.at(-1)?.atEpochMs ?? 0) >= memoryIntervalMs) {
        await sampleMemory();
      }
      await delay(
        Math.max(
          0,
          Math.min(
            roundIntervalMs - (Date.now() - roundStartedAt),
            durationMs - (Date.now() - measurementStartedAt),
          ),
        ),
      );
    }
    if (allocation) {
      console.table([
        {
          scenario,
          round,
          operations: allocation.operationCount,
          "estimated bytes/op": Math.round(allocation.estimatedAllocatedBytesPerOperation),
          "GC ms": allocation.gcMs.toFixed(2),
          "GC ms/op": allocation.gcMsPerOperation.toFixed(3),
          "GC count": allocation.gcCount,
        },
      ]);
    }
  }
  const wholeSoakDiagnostics = await finishWholeSoakDiagnostics?.();
  let wholeSoakAllocation;
  if (soakAllocationPath) {
    // Stop after the GC/loop window so the profiler's forced collection cannot affect acceptance.
    await controlGatewayProfile(gateway, "heap", "stop", soakAllocationPath);
    const profile = readGatewayHeapProfile(soakAllocationPath, {
      samplingIntervalBytes: soakSamplingIntervalBytes,
    });
    const completedTurns = samples.length * runCount;
    wholeSoakAllocation = {
      ...profile,
      completedTurns,
      allocatedMbPerTurn: profile.sampledAllocatedBytes / 1_000_000 / completedTurns,
    };
  }
  let retainedProfile;
  if (soakScenario) {
    await sampleMemory();
    await sampleMemory(true);
    if (retainedProfileStartedAt !== undefined) {
      await controlGatewayProfile(gateway, "heap", "stop", retainedProfilePath);
      const { sampledAllocatedBytes, topAllocationSites, ...profile } = readGatewayHeapProfile(
        retainedProfilePath,
        { includeCollectedObjects: false },
      );
      retainedProfile = {
        ...profile,
        startedAtEpochMs: retainedProfileStartedAt,
        stoppedAtEpochMs: Date.now(),
        sampledRetainedBytes: sampledAllocatedBytes,
        topRetainedSites: topAllocationSites,
      };
    } else if (retainedProfileMs > 0) {
      throw new Error("no retained profile window captured; shorten the round duration");
    }
    if (values["heap-snapshot"]) {
      await readGatewayResources(gateway, {
        snapshotPath: path.join(output, "settled.heapsnapshot"),
      });
    }
  }
  let diffEditVisibilityMs: number | undefined;
  if (values["mixed-rpc"] && stressWorktree && diffControlOriginal !== undefined) {
    writeFileSync(
      path.join(stressWorktree, "README.md"),
      `${diffControlOriginal}Synthetic diff control.\nSynthetic edit control.\n`,
    );
    const editStarted = performance.now();
    let diff;
    do {
      diff = await rpc(sender, "sessions.diff", {
        sessionKey: parentKey,
        scope: "all",
        summaryOnly: true,
      });
      if (isRecord(diff) && diff.additions === 2) {
        break;
      }
      await delay(100);
    } while (performance.now() - editStarted < 12_000);
    validateDiff(diff, 2);
    diffEditVisibilityMs = performance.now() - editStarted;
  }
  let cronRuns;
  if (stressCronJobId) {
    await rpc(sender, "cron.update", { id: stressCronJobId, patch: { enabled: false } });
    const history = await rpc(sender, "cron.runs", { id: stressCronJobId, limit: 200 });
    if (
      !isRecord(history) ||
      !Array.isArray(history.entries) ||
      !history.entries.length ||
      history.entries.some((entry: unknown) => !isRecord(entry) || entry.status !== "ok")
    ) {
      throw new Error("stress cron history is missing or contains a failed run");
    }
    cronRuns = history.entries.filter(
      (entry: { runAtMs?: number }) => (entry.runAtMs ?? 0) >= measurementStartedAt,
    );
    if (durationMs >= 60_000 && !cronRuns.length) {
      throw new Error("stress cron did not complete during the measured soak");
    }
  }
  // Process exit plus drained log streams makes promotion accounting independent of pipe buffering.
  await cleanup();
  let wholeSoakGc;
  if (wholeSoakDiagnostics && (values.allocations || values["trace-gc"])) {
    const trace = readGatewayGcTrace(
      path.join(output, "gateway.stdout.log"),
      "whole-soak",
      "diagnostics",
    );
    const completedTurns = samples.length * runCount;
    const wallMs = wholeSoakDiagnostics.durationMs;
    wholeSoakGc = {
      ...trace,
      completedTurns,
      wallMs,
      promotedMbPerTurn: trace.promotedBytes / 1_000_000 / completedTurns,
      scavengeSecondsPerMinute:
        ((wholeSoakDiagnostics.gc.minorDurationMs?.total ?? 0) * 60) / wallMs,
      majorSecondsPerMinute: ((wholeSoakDiagnostics.gc.majorDurationMs?.total ?? 0) * 60) / wallMs,
    };
  }
  const result = {
    output,
    scenario,
    revision: values.revision ?? null,
    operationsPerRound: turnScenario ? sessionCount : operations,
    rpcConcurrency,
    reconnectStaggerMs,
    rpcLatencyScope:
      "client request-to-response; handler and queue timings are in Gateway diagnostics",
    perEventResourceScope:
      "whole measured workload main-isolate CPU and sampled allocations divided by session publications or deliveries; not encode/send-only cost",
    connectionMeasurementScope: connectionScenario
      ? "owned socket replacement; handshake includes WebSocket open and connect; reconnect adds subscribe and list; events during intentional disconnection are not replayed"
      : undefined,
    limit,
    rowMode,
    sessionRowDeltas: values["session-row-deltas"],
    sessionEnvelopeRefs: values["session-envelope-refs"],
    listIntervalMs,
    mixedRpc: values["mixed-rpc"],
    stressTools: values["stress-tools"],
    stressSubagents: values["stress-subagents"],
    cronRuns,
    ...(values["mixed-rpc"] ? { diffEditControlVerified: true, diffEditVisibilityMs } : {}),
    pollSeed: values["poll-seed"] ?? null,
    diagnostics: values.diagnostics,
    cpuProfile: values["cpu-profile"],
    workloadCpuProfile: values["workload-cpu-profile"],
    captureResponses: values["capture-responses"],
    traceGc: values["trace-gc"] || values.allocations || values["stream-start-allocations"],
    streamStartDiagnostics: values["stream-start-diagnostics"],
    streamStartAllocations: values["stream-start-allocations"],
    activeWorkDiagnostics: values["active-work-diagnostics"],
    measurementStartedAt,
    initialFullFrame,
    clientCount,
    exactClients,
    activitySummaries: values["activity-summaries"],
    recapBurstRepeats,
    recapBurstIntervalMs,
    runCount,
    chunks: chunkCount,
    chunkIntervalMs,
    peakStreams,
    streamRequests,
    fixture,
    ...(retentionScenario ? { promptBytes, initialRetainedResources } : {}),
    ...(idleScenario
      ? {
          sessionCount,
          historyTurns,
          idleDurationMs: durationMs,
          promptBytes,
          initialRetainedResources,
          postIdleResources,
          heapGrowthAfterIdleBytes:
            postIdleResources && initialRetainedResources
              ? postIdleResources.memory.heapUsed - initialRetainedResources.memory.heapUsed
              : undefined,
          memorySamples,
          idleDiagnostics,
          idleGc:
            values["trace-gc"] || values.allocations
              ? readGatewayGcTrace(
                  path.join(output, "gateway.stdout.log"),
                  "session-idle",
                  "diagnostics",
                )
              : undefined,
          transcriptChecks: {
            appendOnlyAfterReopen: idleHistories.size,
          },
        }
      : {}),
    ...(soakScenario
      ? {
          durationMs,
          warmupMs,
          roundIntervalMs,
          memoryIntervalMs,
          retainedProfileMs,
          resetEveryRounds,
          sessionResets,
          completedSoakRounds,
          initialRetainedResources,
          initialMemoryCollected: !values.allocations,
          memorySamples,
          retainedProfile,
          wholeSoakAllocation,
          wholeSoakDiagnostics,
          wholeSoakGc,
        }
      : {}),
    samples: samples.map((sample) =>
      Object.assign(sample, {
        ...(sample.allocation
          ? {
              allocation: {
                ...sample.allocation,
                ...readPromotion(sample.allocation.profilePath, sample.allocation.operationCount),
              },
            }
          : {}),
        ...(sample.streamStart?.heapProfile
          ? {
              streamStart: {
                ...sample.streamStart,
                heapProfile: {
                  ...sample.streamStart.heapProfile,
                  ...readPromotion(sample.streamStart.heapProfile.profilePath, runCount),
                },
              },
            }
          : {}),
      }),
    ),
  };
  writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(`RESULT ${path.join(output, "result.json")}`);
} finally {
  await cleanup();
}
