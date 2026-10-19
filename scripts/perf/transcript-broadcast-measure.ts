import { spawn, type ChildProcess } from "node:child_process";
import { createCipheriv, createHash, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { stripInboundMetadata } from "../../src/auto-reply/reply/strip-inbound-meta.js";
import { encodePngRgba } from "../../src/media/png-encode.js";
import { applyMockOpenAiModelConfig } from "../e2e/lib/fixtures/mock-openai-config.mjs";
import {
  readMockUserText,
  summarizeMockInferenceRequest,
} from "../e2e/lib/mock-inference-facts.ts";
import { readBody } from "../e2e/lib/mock-openai-http.mjs";
import { stopChild } from "../lib/gateway-bench-child.ts";
import {
  readGatewayCpuUsage,
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
    scenario: { type: "string", default: "transcript-broadcast" },
    revision: { type: "string" },
    operations: { type: "string" },
    limit: { type: "string", default: "100" },
    "row-mode": { type: "string", default: "compact" },
    entry: { type: "string", default: "dist/entry.js" },
    port: { type: "string", default: "41033" },
    "mock-port": { type: "string", default: "41034" },
    clients: { type: "string", default: "60" },
    runs: { type: "string", default: "20" },
    rounds: { type: "string", default: "5" },
    chunks: { type: "string", default: "100" },
    "prompt-kib": { type: "string", default: "128" },
    "heap-snapshot": { type: "boolean", default: false },
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
    "plugins.reload",
  ].includes(scenario)
) {
  throw new Error(
    "--scenario must be sessions.list, subscribe, chat.send, transcript-broadcast, attempt-retention, or plugins.reload",
  );
}
const retentionScenario = scenario === "attempt-retention";
const turnScenario =
  scenario === "chat.send" || scenario === "transcript-broadcast" || retentionScenario;
if (!values.allocations && scenario !== "transcript-broadcast" && !retentionScenario) {
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
const runCount = scenario === "chat.send" ? 1 : integer(values.runs, "--runs");
const rounds = integer(values.rounds, "--rounds");
const chunkCount = integer(values.chunks, "--chunks");
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
  entries: { "memory-core": { config: { dreaming: { enabled: false } } } },
};
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
let cohort:
  | {
      id: string;
      arrivals: Set<number>;
      toolCallIds: Set<string>;
      outputLimited: Set<string>;
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
    const continuation =
      (scenario === "chat.send" || retentionScenario) && toolOutput !== undefined;
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
        if (cohort.arrivals.size === runCount) {
          cohort.release();
        }
        await cohort.ready;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      let toolAnswer;
      if (primary && (scenario === "chat.send" || retentionScenario) && cohort) {
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
      let answer = toolAnswer ?? (primary || continuation ? events : utilityEvents);
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
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if ((primary || continuation) && event.type === "response.output_text.delta") {
          await delay(10);
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
const perClientCounters: Map<string, number>[] = [];
let measuring = false;
let lastSubscriberEventAt = performance.now();
let closing = false;
let subscriberFailure: Error | undefined;
let gateway: ChildProcess | undefined;
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
) {
  assertGatewayAlive();
  const response = await client.request(method, params, 180_000);
  assertGatewayAlive();
  if (!response.ok) {
    throw new Error(`${method}: ${JSON.stringify(response.error)}`);
  }
  return response.payload;
}
async function runRound(client: ReturnType<typeof createGatewayWsClient>) {
  if (retentionScenario) {
    // Retire each previous session generation so retained history is not the measurement.
    for (const key of keys) {
      await rpc(client, "sessions.reset", { key });
    }
  }
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
    ready: cohortReady,
    release,
    reject,
  };
  const current = cohort;
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
    await Promise.all([
      cohortReady,
      ...keys.map(async (sessionKey, index) => {
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
    ]);
  } finally {
    clearTimeout(timeout);
    current.release();
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
    let previousSeq: number | undefined;
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
        if (measuring) {
          counters.set(event.event, (counters.get(event.event) ?? 0) + 1);
          clientCounters.set(event.event, (clientCounters.get(event.event) ?? 0) + 1);
        }
      },
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
      caps: ["session-scoped-events", "chat-only-assistant-text"],
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
          parentSessionKey: parentKey,
          spawnDepth: 1,
          fork: false,
          visibility: "shared",
          displayName: "Synthetic broadcast child",
        });
        await rpc(client, "sessions.reset", { key });
      }
    }
    await rpc(client, "sessions.subscribe", {});
    for (const key of keys) {
      await rpc(client, "sessions.messages.subscribe", { key, subscriptionId: key });
    }
  }
  const sender = clients[0];
  if (!sender) {
    throw new Error("no sender client");
  }
  console.log("PHASE subscribed-and-reset");
  const runScenario = async () => {
    if (turnScenario) {
      await runRound(sender);
      return;
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
  };
  await runScenario();
  console.log("PHASE warmed");
  await drainEvents();
  const initialRetainedResources = retentionScenario
    ? await readGatewayResources(gateway, { collectGarbage: true })
    : undefined;
  const samples = [];
  for (let round = 0; round < rounds; round++) {
    counters.clear();
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
    const before = await readGatewayCpuUsage(gateway);
    measuring = true;
    const workload = async () => {
      await runScenario();
      await drainEvents();
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
    measuring = false;
    assertGatewayAlive();
    if (clients.some((client) => client.ws.readyState !== client.ws.OPEN)) {
      throw new Error("a subscriber was lost during the measured round");
    }
    if (turnScenario && (peakPrimaryStreams !== runCount || primaryStreamRequests !== runCount)) {
      throw new Error(
        `expected ${runCount} primary streams: peak=${peakPrimaryStreams}, requests=${primaryStreamRequests}`,
      );
    }
    if (scenario === "chat.send" && (toolCalls !== 1 || toolResults !== 1)) {
      throw new Error(
        `expected one completed tool call per turn, calls=${toolCalls}, results=${toolResults}`,
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
    const sample = {
      round,
      scenario,
      allocation,
      toolCalls,
      toolResults,
      ...(retentionScenario
        ? { outputLimitResponses, recoveredResponses, imageRequests, retainedResources }
        : {}),
      ...cpu,
      eventCounts: Object.fromEntries(counters),
      perClientEventCounts: perClientCounters.map((counts) => Object.fromEntries(counts)),
      peakStreams,
      peakPrimaryStreams,
      primaryStreamRequests,
      utilityStreamRequests: streamRequests - primaryStreamRequests - toolResults,
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
  const result = {
    output,
    scenario,
    revision: values.revision ?? null,
    operationsPerRound: turnScenario ? runCount : operations,
    limit,
    rowMode,
    clientCount,
    runCount,
    chunks: chunkCount,
    peakStreams,
    streamRequests,
    fixture,
    ...(retentionScenario ? { promptBytes, initialRetainedResources } : {}),
    samples,
  };
  writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(`RESULT ${path.join(output, "result.json")}`);
} finally {
  await cleanup();
}
