import { spawn, type ChildProcess } from "node:child_process";
import { createCipheriv, createHash, randomUUID } from "node:crypto";
import { appendFileSync, createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Profiler } from "node:inspector";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
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
  controlGatewayProfile,
  readGatewayCpuProfile,
  readGatewayHeapProfile,
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
    "cpu-profile": { type: "boolean", default: false },
    "trace-gc": { type: "boolean", default: false },
    "stream-start-diagnostics": { type: "boolean", default: false },
    "stream-start-allocations": { type: "boolean", default: false },
    "active-work-diagnostics": { type: "boolean", default: false },
    scenario: { type: "string", default: "transcript-broadcast" },
    revision: { type: "string" },
    operations: { type: "string" },
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
    "subscribe",
    "chat.send",
    "transcript-broadcast",
    "attempt-retention",
    "memory-soak",
    "plugins.reload",
  ].includes(scenario)
) {
  throw new Error(
    "--scenario must be sessions.list, subscribe, chat.send, transcript-broadcast, attempt-retention, memory-soak, or plugins.reload",
  );
}
const retentionScenario = scenario === "attempt-retention";
const soakScenario = scenario === "memory-soak";
const toolScenario = scenario === "chat.send" || retentionScenario || soakScenario;
const turnScenario =
  scenario === "chat.send" ||
  scenario === "transcript-broadcast" ||
  retentionScenario ||
  soakScenario;
if (
  !values.allocations &&
  !values["stream-start-allocations"] &&
  scenario !== "transcript-broadcast" &&
  !retentionScenario &&
  !soakScenario
) {
  throw new Error("--scenario requires --allocations");
}
const operations = integer(
  values.operations ?? (scenario === "plugins.reload" ? "1" : "100"),
  "--operations",
);
const limit = integer(values.limit, "--limit");
const rowMode = values["row-mode"];
if (!["compact", "sidebar", "dashboard"].includes(rowMode)) {
  throw new Error("--row-mode must be compact, sidebar, or dashboard");
}
const clientCount = scenario === "chat.send" ? 1 : integer(values.clients, "--clients");
const exactClients = integer(values["exact-clients"] ?? String(clientCount), "--exact-clients", 0);
if (exactClients > clientCount) {
  throw new Error("--exact-clients must not exceed --clients");
}
const runCount = scenario === "chat.send" ? 1 : integer(values.runs, "--runs");
const rounds = integer(values.rounds, "--rounds");
const durationMs = integer(values["duration-ms"], "--duration-ms");
const warmupMs = integer(values["warmup-ms"], "--warmup-ms", 0);
const roundIntervalMs = integer(values["round-interval-ms"], "--round-interval-ms");
const memoryIntervalMs = integer(values["memory-interval-ms"], "--memory-interval-ms");
const retainedProfileMs = integer(values["retained-profile-ms"], "--retained-profile-ms", 0);
const resetEveryRounds = integer(values["reset-every-rounds"], "--reset-every-rounds", 0);
if (
  soakScenario &&
  (values.allocations || values["stream-start-allocations"] || retainedProfileMs > durationMs)
) {
  throw new Error(
    "memory-soak needs a retained profile no longer than its duration and no allocation-churn capture",
  );
}
const chunkCount = integer(values.chunks, "--chunks");
const chunkIntervalMs = integer(values["chunk-interval-ms"], "--chunk-interval-ms", 0);
const listIntervalMs = integer(values["list-interval-ms"], "--list-interval-ms", 0);
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
if (
  !fixture ||
  typeof fixture !== "object" ||
  !("format" in fixture) ||
  fixture.format !== "openclaw-team-shape-v1"
) {
  throw new Error("--state-dir must contain a generated team-shape fixture");
}
const output = path.join(root, `broadcast-measure-${Date.now()}`);
mkdirSync(output);
const cfg = JSON.parse(readFileSync(path.join(root, "openclaw.json"), "utf8"));
applyMockOpenAiModelConfig(cfg, { mockPort, modelRef: "openai/gpt-4.1" });
cfg.agents.defaults = {
  ...cfg.agents.defaults,
  maxConcurrent: runCount,
  subagents: { ...cfg.agents.defaults.subagents, maxConcurrent: runCount },
  skipBootstrap: true,
};
cfg.memory = { ...cfg.memory, search: { enabled: false } };
cfg.tools = { codeMode: false };
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
      arrivals: Set<number>;
      toolCallIds: Set<string>;
      outputLimited: Set<string>;
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
      if (
        toolOutputs.some(
          (toolResult) =>
            typeof toolResult.output !== "string" ||
            !toolResult.output.includes("Synthetic allocation benchmark tool result."),
        )
      ) {
        throw new Error("synthetic read tool did not return its fixture text");
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
        cohort.phases.firstPrimaryRequestAtEpochMs ??= epochNow();
        cohort.phases.lastPrimaryRequestAtEpochMs = epochNow();
        if (cohort.arrivals.size === runCount) {
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
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      let toolAnswer;
      if (primary && toolScenario && cohort) {
        const currentCohort = cohort;
        const items = toolPaths.map((toolPath, toolIndex) => {
          const callId = `call_allocation_${currentCohort.id}_${index}_${toolIndex}`;
          currentCohort.toolCallIds.add(callId);
          return {
            type: "function_call",
            id: `fc_${currentCohort.id}_${index}_${toolIndex}`,
            call_id: callId,
            name: "read",
            arguments: JSON.stringify({ path: toolPath }),
          };
        });
        toolCalls += items.length;
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
        res.write(`data: ${JSON.stringify(event)}\n\n`);
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
};
function launch(args: string[], name: string, extraEnv: NodeJS.ProcessEnv = {}, ipc = false) {
  const log = createWriteStream(path.join(output, `${name}.log`));
  const child = spawn(process.execPath, args, {
    env: { ...env, ...extraEnv },
    detached: true,
    stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
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
const keys = Array.from(
  { length: runCount },
  (_, index) => `agent:main:transcript-broadcast-measure-child-${index}`,
);
async function rpc(
  client: ReturnType<typeof createGatewayWsClient>,
  method: string,
  params: unknown,
  onResponse?: (id: string) => void,
) {
  assertGatewayAlive();
  const response = await client.request(method, params, 180_000);
  assertGatewayAlive();
  if (!response.ok) {
    throw new Error(`${method}: ${JSON.stringify(response.error)}`);
  }
  onResponse?.(response.id);
  return response.payload;
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
let completedSoakRounds = 0;
let sessionResets = 0;
async function runRound(client: ReturnType<typeof createGatewayWsClient>, measuredRound?: number) {
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
    arrivals: new Set(),
    toolCallIds: new Set(),
    outputLimited: new Set(),
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
          `only ${current.arrivals.size}/${runCount} primary model requests arrived in 45s`,
        ),
      ),
    45_000,
  );
  try {
    const turns = Promise.all(
      keys.map(async (sessionKey, index) => {
        const runId = randomUUID();
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
            (retentionScenario
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
      }),
    ).then(() => {
      current.phases.completedAtEpochMs = epochNow();
    });
    await Promise.all([cohortReady, captureWork, turns]);
    if (soakScenario) {
      completedSoakRounds++;
    }
    return { phases: current.phases, ...capture };
  } finally {
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
let cleanupPromise: Promise<void> | undefined;
function cleanup() {
  return (cleanupPromise ??= (async () => {
    closing = true;
    cohort?.release();
    for (const client of clients) {
      client.close();
    }
    await Promise.all(
      children.map((child) => stopChild(child, { teardownGraceMs: 10_000, killGraceMs: 2000 })),
    );
    mock.closeAllConnections();
    if (mock.listening) {
      await new Promise<void>((resolve, reject) => {
        mock.close((error) => (error ? reject(error) : resolve()));
      });
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
      ...(values["trace-gc"] ? ["--trace-gc"] : []),
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
    assertGatewayAlive();
    const clientCounters = new Map<string, number>();
    perClientCounters.push(clientCounters);
    const recapRows = new Map<string, RecapReceipt>();
    perClientRecaps.push(recapRows);
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
    // The helper parses frames before onEvent; capture their exact uncompressed size first.
    client.ws.prependListener("message", (data: import("ws").RawData) => {
      receivedFrameBytes = Array.isArray(data)
        ? data.reduce((sum, part) => sum + part.byteLength, 0)
        : data.byteLength;
    });
    client.ws.on("close", (code) => {
      if (!closing) {
        subscriberFailure ??= new Error(`subscriber ${index} unexpectedly closed (${code})`);
      }
    });
    client.ws.on("error", (error) => {
      if (!closing) {
        subscriberFailure ??= new Error(`subscriber ${index}: ${error.message}`);
      }
    });
    clients.push(client);
    await client.waitOpen();
    await rpc(client, "connect", {
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
    });
    if (index === 0) {
      await rpc(client, "sessions.create", {
        key: parentKey,
        visibility: "shared",
        displayName: "Synthetic broadcast parent",
      });
      await rpc(client, "sessions.reset", { key: parentKey });
      for (const key of keys) {
        await rpc(client, "sessions.create", {
          key,
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
  console.log("PHASE subscribed-and-reset");
  const runScenario = async (measuredRound?: number) => {
    if (turnScenario) {
      const streamStart = await runRound(sender, measuredRound);
      if (values["activity-summaries"]) {
        recapPhase = await runRecapBurst(sender, measuredRound);
      }
      return streamStart;
    }
    for (let operation = 0; operation < operations; operation++) {
      if (scenario === "sessions.list" || scenario === "subscribe") {
        const method = scenario === "subscribe" ? "sessions.subscribe" : "sessions.list";
        const result = await rpc(sender, method, {
          limit,
          rowMode,
          archived: "all",
        });
        const page =
          scenario === "subscribe"
            ? isRecord(result) && result.subscribed === true
              ? result.list
              : undefined
            : result;
        if (
          !isRecord(page) ||
          typeof page.totalCount !== "number" ||
          page.count !== Math.min(limit, page.totalCount)
        ) {
          throw new Error(`${method} did not return the requested page`);
        }
      } else {
        const result = await rpc(sender, "plugins.reload", {
          plugins: [{ pluginId: reloadPluginId }],
          waitForDrain: true,
        });
        if (
          !result ||
          typeof result !== "object" ||
          !("restartRequired" in result) ||
          result.restartRequired !== false
        ) {
          throw new Error("synthetic plugin reload did not apply live");
        }
      }
    }
    return undefined;
  };
  const warmupStartedAt = performance.now();
  do {
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
  const initialRetainedResources =
    retentionScenario || soakScenario
      ? await readGatewayResources(gateway, { collectGarbage: true })
      : undefined;
  const measurementStartedAt = Date.now();
  const measuredGateway = gateway;
  const samples = [];
  const memorySamples: Array<{
    atEpochMs: number;
    elapsedMs: number;
    completedRounds: number;
    sessionResets: number;
    collectedGarbage: boolean;
    resources: Awaited<ReturnType<typeof readGatewayResources>>;
  }> = [];
  const sampleMemory = async (collectGarbage = false) => {
    const resources = await readGatewayResources(measuredGateway, { collectGarbage });
    const sample = {
      atEpochMs: Date.now(),
      elapsedMs: Date.now() - measurementStartedAt,
      completedRounds: samples.length,
      sessionResets,
      collectedGarbage: collectGarbage,
      resources,
    };
    memorySamples.push(sample);
    appendFileSync(path.join(output, "memory-samples.jsonl"), `${JSON.stringify(sample)}\n`);
    console.log(`MEMORY ${JSON.stringify(sample)}`);
  };
  const retainedProfilePath = path.join(output, "retained.heapprofile");
  let retainedProfileStartedAt: number | undefined;
  if (soakScenario) {
    await sampleMemory();
  }
  for (
    let round = 0;
    soakScenario ? Date.now() - measurementStartedAt < durationMs : round < rounds;
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
    measuring = true;
    const listLatencies: number[] = [];
    const initialPollPhasesMs: number[] = [];
    let streamStart: Awaited<ReturnType<typeof runRound>> | undefined;
    const listRequests: Array<{
      method: "sessions.list";
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
                while (true) {
                  if (!polling) {
                    break;
                  }
                  const started = performance.now();
                  let responseId = "";
                  const page = await rpc(
                    client,
                    "sessions.list",
                    { rowMode: "compact", limit, archived: "all" },
                    recordListRequests
                      ? (id) => {
                          responseId = id;
                        }
                      : undefined,
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
                  const ended = performance.now();
                  const requestDurationMs = ended - started;
                  listLatencies.push(requestDurationMs);
                  if (recordListRequests) {
                    listRequests.push({
                      method: "sessions.list",
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
    const allocation = values.allocations
      ? await measureGatewayAllocations(
          gateway,
          path.join(output, `allocation-${round}.heapprofile`),
          turnScenario ? runCount : operations,
          workload,
        )
      : undefined;
    if (!values.allocations) {
      await workload();
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
    if (turnScenario && (peakPrimaryStreams !== runCount || primaryStreamRequests !== runCount)) {
      throw new Error(
        `expected ${runCount} primary streams: peak=${peakPrimaryStreams}, requests=${primaryStreamRequests}`,
      );
    }
    if (
      (scenario === "chat.send" || soakScenario) &&
      (toolCalls !== runCount || toolResults !== runCount)
    ) {
      throw new Error(
        `expected ${runCount} completed tool calls, calls=${toolCalls}, results=${toolResults}`,
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
    const retainedResources = retentionScenario
      ? await readGatewayResources(gateway, {
          collectGarbage: true,
          ...(values["heap-snapshot"] && round === rounds - 1
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
      diagnostics,
      streamStart,
      activeWorkCounts,
      toolCalls,
      toolResults,
      recapRequests,
      ...(values["activity-summaries"] ? { recapPhase, recapReceipts: [...recapReceipts] } : {}),
      ...(retentionScenario
        ? { outputLimitResponses, recoveredResponses, imageRequests, retainedResources }
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
                    requests: listRequests,
                    p99Request: listRequests.toSorted((a, b) => a.durationMs - b.durationMs)[
                      Math.ceil(listRequests.length * 0.99) - 1
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
      mainThreadMsPerSecond: (cpu.mainThread.totalMs / cpu.wallMs) * 1000,
      sessionEventsPerSecond: (sourceEvents / cpu.wallMs) * 1000,
    };
    samples.push(sample);
    console.log(JSON.stringify(sample));
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
  const result = {
    output,
    scenario,
    revision: values.revision ?? null,
    operationsPerRound: turnScenario ? runCount : operations,
    limit,
    rowMode,
    sessionRowDeltas: values["session-row-deltas"],
    sessionEnvelopeRefs: values["session-envelope-refs"],
    listIntervalMs,
    pollSeed: values["poll-seed"] ?? null,
    diagnostics: values.diagnostics,
    cpuProfile: values["cpu-profile"],
    traceGc: values["trace-gc"],
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
          memorySamples,
          retainedProfile,
        }
      : {}),
    samples,
  };
  writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(`RESULT ${path.join(output, "result.json")}`);
} finally {
  await cleanup();
}
