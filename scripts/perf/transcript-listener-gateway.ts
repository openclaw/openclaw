/**
 * Synthetic real-Gateway lifecycle soak. No credentials or operator state.
 * node --import ./scripts/tsx.mjs scripts/perf/transcript-listener-gateway.ts
 *   --output .local/listener-candidate --runs 200 [--cleanup-fail-every 5]
 * Baseline: --baseline-dir <directory containing exact baseline source files>.
 * Sampling is opt-in; compare instrumented allocations separately from timing.
 * --scenario all includes Code Mode, aborts, compaction, cron, yield and rejected steering.
 * --scenario restart separately proves managed restart/resume across process boundaries.
 * Use --settle-ms 17000 to outlive the diagnostic event owner before counting classes.
 * --scenario surge --active 68 --clients 30 --duration-seconds 60 holds real provider
 * streams concurrently while publishing row changes. --reuse-state-fixture reuses
 * one owned synthetic fixture serially; never point it at operator state.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  cpSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { OpenClawConfig } from "../../src/config/types.openclaw.ts";
import { buildMockOpenAiResponsesProvider } from "../../src/gateway/test-openai-responses-model.ts";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.ts";
import { stopChild, stopGatewayGracefully } from "../lib/gateway-bench-child.ts";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import {
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  waitForInitialProbe,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { generateTeamShapeFixture, parseTeamShapeOptions } from "./team-shape-fixture.ts";
import { createTeamStressFanoutReceipts } from "./team-shape-stress-receipts.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    runs: { type: "string", default: "200" },
    sessions: { type: "string", default: "4000" },
    "transcript-mib": { type: "string", default: "64" },
    "baseline-dir": { type: "string" },
    "baseline-revision": { type: "string" },
    "state-fixture": { type: "string" },
    "reuse-state-fixture": { type: "boolean", default: false },
    active: { type: "string", default: "68" },
    clients: { type: "string", default: "30" },
    "duration-seconds": { type: "string", default: "60" },
    "chunk-ms": { type: "string", default: "100" },
    "publication-ms": { type: "string", default: "1000" },
    profile: { type: "boolean", default: false },
    "cleanup-fail-every": { type: "string", default: "0" },
    allocations: { type: "boolean", default: false },
    "expect-released": { type: "boolean", default: false },
    "settle-ms": { type: "string", default: "100" },
    snapshot: { type: "boolean", default: false },
    scenario: { type: "string", default: "lifecycle" },
    "capture-every": { type: "string", default: "40" },
  },
});
assert(values.output, "--output must name a new task-owned directory");
const output = path.resolve(values.output);
mkdirSync(output);
const runs = Number(values.runs);
assert(Number.isSafeInteger(runs) && runs > 0);
const settleMs = Number(values["settle-ms"]);
assert(Number.isSafeInteger(settleMs) && settleMs >= 0);
let port = await getFreePort();
for (let attempt = 0; port < 40_000 && attempt < 20; attempt++) {
  port = await getFreePort();
}
assert(port >= 40_000, "Could not allocate a port in the synthetic fixture range");
let mode = "success";
let toolIssued = false;
let yieldIssued = false;
let replyMarker = "";
const scenario = values.scenario!;
const activeCount = Number(values.active);
const clientCount = Number(values.clients);
const durationMs = Number(values["duration-seconds"]) * 1000;
const chunkMs = Number(values["chunk-ms"]);
const publicationMs = Number(values["publication-ms"]);
for (const value of [activeCount, clientCount, durationMs, chunkMs, publicationMs]) {
  assert(Number.isSafeInteger(value) && value > 0);
}
assert(
  [
    "lifecycle",
    "all",
    "code",
    "degenerate",
    "subagent",
    "compact",
    "cron",
    "queue",
    "restart",
    "surge",
  ].includes(scenario),
);
function writeTool(response: ServerResponse, name: string, args: unknown) {
  const id = randomUUID();
  const item = {
    type: "function_call",
    id: `fc_${id}`,
    call_id: id,
    name,
    arguments: JSON.stringify(args),
  };
  writeOpenAiResponsesSse(response, [
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
        id: `resp_${id}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 64, output_tokens: 16, total_tokens: 80 },
      },
    },
  ]);
}
const providerProgress = { requests: 0 };
const held = new Set<ServerResponse>();
const streams = new Map<ServerResponse, { text: string; messageId: string; responseId: string }>();
let finishStreams = false;
let providerChunks = 0;
let peakStreams = 0;
const providerServer = createServer((request, response) => {
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString();
    const requestBody = JSON.parse(body);
    const toolCapable =
      Array.isArray(requestBody.tools) &&
      requestBody.tools.some((tool: { name?: string }) => tool.name === "exec");
    providerProgress.requests++;
    if (mode === "surge") {
      const stream = { text: "", messageId: randomUUID(), responseId: randomUUID() };
      streams.set(response, stream);
      peakStreams = Math.max(peakStreams, streams.size);
      held.add(response);
      response.once("close", () => {
        held.delete(response);
        streams.delete(response);
      });
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      const emit = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
      emit({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "message",
          id: stream.messageId,
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      });
      for (;;) {
        if (finishStreams || response.destroyed) {
          break;
        }
        const delta = `Synthetic stream ${providerChunks++}. `;
        stream.text += delta;
        emit({
          type: "response.output_text.delta",
          item_id: stream.messageId,
          output_index: 0,
          content_index: 0,
          delta,
        });
        await delay(chunkMs);
      }
      if (!response.destroyed) {
        const message = {
          type: "message",
          id: stream.messageId,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: stream.text, annotations: [] }],
        };
        emit({
          type: "response.output_text.done",
          item_id: stream.messageId,
          output_index: 0,
          content_index: 0,
          text: stream.text,
        });
        emit({ type: "response.output_item.done", output_index: 0, item: message });
        emit({
          type: "response.completed",
          response: {
            id: stream.responseId,
            status: "completed",
            output: [message],
            usage: { input_tokens: 16, output_tokens: 64, total_tokens: 80 },
          },
        });
        response.end("data: [DONE]\n\n");
      }
      return;
    }
    if (mode === "degenerate" && toolCapable && !toolIssued) {
      toolIssued = true;
      const item = {
        type: "function_call",
        id: "fc_degenerate",
        call_id: "degenerate",
        name: "exec",
        arguments: "",
      };
      writeOpenAiResponsesSse(response, [
        { type: "response.output_item.added", output_index: 0, item },
        {
          type: "response.function_call_arguments.delta",
          item_id: item.id,
          output_index: 0,
          delta: '{"code":"return 1;',
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: item.id,
          output_index: 0,
          delta: " ".repeat(4096),
        },
      ]);
      return;
    }
    if (["code", "subagent"].includes(mode) && toolCapable && !toolIssued) {
      toolIssued = true;
      writeTool(response, "exec", {
        title: "Synthetic retention probe",
        code:
          mode === "subagent"
            ? 'return await sessions_spawn({ task: "Return SYNTHETIC_CHILD_DONE", runtime: "subagent", context: "isolated", mode: "run", cleanup: "keep", runTimeoutSeconds: 60 });'
            : 'return { marker: "SYNTHETIC_CODE_DONE", sum: Array.from({length: 256}, (_, i) => i).reduce((a, b) => a + b, 0) };',
        awaitResults: true,
      });
      return;
    }
    if (mode === "subagent" && !yieldIssued && body.includes('"function_call_output"')) {
      yieldIssued = true;
      writeTool(response, "sessions_yield", {});
      return;
    }
    if (mode === "subagent" && !body.includes('"function_call_output"')) {
      await delay(1500);
    }
    if (mode === "abort" || mode === "queue" || mode === "restart") {
      held.add(response);
      response.once("close", () => held.delete(response));
      return;
    }
    if (mode === "failure") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "Synthetic provider failure", type: "invalid_request_error" },
        }),
      );
      return;
    }
    writeOpenAiResponsesText(response, {
      text: `Synthetic completed turn. ${replyMarker}`,
      messageId: randomUUID(),
      responseId: randomUUID(),
    });
  })().catch((error: unknown) =>
    response.destroy(error instanceof Error ? error : new Error(String(error))),
  );
});
await new Promise<void>((resolve) => {
  providerServer.listen(0, "127.0.0.1", resolve);
});
const address = providerServer.address();
assert(address && typeof address !== "string");
const provider = buildMockOpenAiResponsesProvider(
  `http://127.0.0.1:${address.port}/v1`,
  "synthetic-model",
);
assert(!values["reuse-state-fixture"] || values["state-fixture"], "reuse requires --state-fixture");
const stateDir = values["reuse-state-fixture"]
  ? path.resolve(values["state-fixture"]!)
  : path.join(output, "state");
const configPath = path.join(stateDir, "openclaw.json");
const fixture = values["state-fixture"] && path.resolve(values["state-fixture"]);
if (fixture) {
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(fixture, "team-shape-summary.json"), "utf8"),
  );
  assert(
    isRecord(manifest) && manifest.format === "openclaw-team-shape-v1",
    "Expected an offline synthetic fixture",
  );
  if (values["reuse-state-fixture"]) {
    assert.equal(stateDir, fixture);
  } else if (process.platform === "darwin") {
    // Node can fall back to a full copy here; native cp preserves APFS clones.
    execFileSync("/bin/cp", ["-cR", fixture, stateDir], { stdio: "pipe" });
  } else {
    cpSync(fixture, stateDir, {
      recursive: true,
      errorOnExist: true,
      force: false,
      mode: constants.COPYFILE_FICLONE,
    });
  }
}
const { summary, env } = fixture
  ? {
      summary: JSON.parse(
        readFileSync(path.join(stateDir, "team-shape-summary.json"), "utf8"),
      ) as unknown,
      env: createGatewayBenchEnv(path.join(stateDir, "home"), configPath, {
        startupTrace: false,
        caseEnv: {
          OPENCLAW_STATE_DIR: stateDir,
          TMPDIR: path.join(stateDir, "tmp"),
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_PROFILE: `listener-${port}`,
          OPENCLAW_LAUNCHD_LABEL: `ai.openclaw.listener-${port}`,
          OPENCLAW_SYSTEMD_UNIT: `openclaw-gateway-listener-${port}`,
          OPENCLAW_WINDOWS_TASK_NAME: `OpenClaw Listener ${port}`,
        },
      }),
    }
  : await generateTeamShapeFixture(
      parseTeamShapeOptions([
        "--state-dir",
        path.join(output, "state"),
        "--port",
        String(port),
        "--now",
        String(Date.now()),
        "--sessions",
        values.sessions!,
        "--transcript-mib",
        values["transcript-mib"]!,
        "--runs",
        "0",
        "--approvals",
        "0",
        "--cron",
        "0",
        "--projects",
        "0",
      ]),
    );
const config: OpenClawConfig = JSON.parse(readFileSync(configPath, "utf8"));
config.agents!.defaults = {
  ...config.agents!.defaults,
  skipBootstrap: true,
  model: { primary: provider.modelRef },
  modelPolicy: { allow: [provider.modelRef] },
  models: {
    [provider.modelRef]: { agentRuntime: { id: "openclaw" }, params: { transport: "sse" } },
  },
  thinkingDefault: "off",
  timeoutSeconds: 30,
  ...(scenario === "surge" ? { maxConcurrent: activeCount, timeoutSeconds: 600 } : {}),
};
config.models = { providers: { [provider.providerId]: provider.config } };
config.tools = { allow: [], codeMode: { enabled: false }, toolSearch: false };
if (scenario !== "lifecycle" && scenario !== "surge") {
  config.tools = { profile: "coding", codeMode: { enabled: true }, toolSearch: false };
  config.plugins = {
    enabled: true,
    slots: { memory: "none" },
    entries: { browser: { enabled: false }, "skill-workshop": { enabled: false } },
  };
  config.cron = { enabled: true };
  config.agents!.defaults!.compaction = { keepRecentTokens: 128 };
  config.meta = {
    ...config.meta,
    migrations: { ...config.meta?.migrations, skillWorkshopPlugin: true },
  };
}
config.skills = { load: { watch: false } };
if (scenario === "surge") {
  config.diagnostics = { enabled: true };
  config.session = {
    ...config.session,
    maintenance: { ...config.session?.maintenance, maxEntries: 30_000 },
  };
}
config.logging = { ...config.logging, file: path.join(stateDir, "gateway.log") };

if (
  fixture &&
  isRecord(summary) &&
  typeof summary.worktreeFiles === "number" &&
  summary.worktreeFiles > 0
) {
  config.agents!.entries!.main!.workspace = path.join(
    stateDir,
    "fixture-worktrees",
    "team-shape-project-0",
  );
  execFileSync(
    "git",
    [
      "-C",
      path.join(stateDir, "fixture-projects", "team-shape-project-0"),
      "worktree",
      "repair",
      config.agents!.entries!.main!.workspace,
    ],
    { env, stdio: "pipe" },
  );
}
writeFileSync(configPath, JSON.stringify(config, null, 2));
function startGateway() {
  const log = openSync(path.join(output, "gateway.log"), "a");
  const stopPreload = new URL("../lib/gateway-bench-stop-preload.mjs", import.meta.url);
  stopPreload.searchParams.set("parentPid", String(process.pid));
  stopPreload.searchParams.set("entry", path.resolve("scripts/perf/transcript-listener-entry.ts"));
  const child = spawn(
    process.execPath,
    buildGatewayBenchChildArgs("scripts/perf/transcript-listener-entry.ts", port, [
      "--expose-gc",
      "--import",
      "./scripts/tsx.mjs",
      ...(scenario === "surge" ? ["--import", stopPreload.href] : []),
    ]),
    {
      env: {
        ...env,
        OPENCLAW_LISTENER_BASELINE: values["baseline-dir"]
          ? path.resolve(values["baseline-dir"])
          : "",
        OPENCLAW_LISTENER_BASELINE_REVISION: values["baseline-revision"] ?? "",
        OPENCLAW_LISTENER_FAIL_EVERY: values["cleanup-fail-every"],
        OPENCLAW_LISTENER_ALLOCATIONS: values.allocations ? "1" : "0",
        OPENCLAW_LISTENER_SURGE: scenario === "surge" ? "1" : "0",
        OPENCLAW_LISTENER_PROFILE: values.profile ? path.join(output, "surge.cpuprofile") : "",
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", log, log, "ipc"],
    },
  );
  closeSync(log);
  return child;
}
async function until<T>(message: string, check: () => Promise<T | undefined>) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const result = await check();
    if (result !== undefined) {
      return result;
    }
    assert(Date.now() < deadline, message);
    await delay(100);
  }
}
let gateway = startGateway();
let client: ReturnType<typeof createGatewayWsClient> | undefined;
const surgeClients: ReturnType<typeof createGatewayWsClient>[] = [];
let surgeResult: unknown;
const captures: Array<{
  completed: number;
  pid: number | undefined;
  listeners: number;
  managers: number;
  sessions: number;
  agents: number;
  registries: number;
  factoryResources: number;
  heapUsed: number;
}> = [];
const turns: unknown[] = [];
const hostLoad = loadavg();
let failure: Error | undefined;
async function capture(completed: number) {
  const id = randomUUID();
  const captured = await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      gateway.off("message", receive);
      reject(new Error("Heap capture timed out"));
    }, 120_000);
    const receive = (message: unknown) => {
      if (isRecord(message) && message.id === id) {
        clearTimeout(timer);
        gateway.off("message", receive);
        resolve(message);
      }
    };
    gateway.on("message", receive);
    gateway.send({
      id,
      ...(values.snapshot
        ? { snapshot: path.join(output, `settled-${completed}.heapsnapshot`) }
        : {}),
    });
  });
  assert(isRecord(captured) && !captured.error, JSON.stringify(captured));
  assert(
    typeof captured.listeners === "number" &&
      typeof captured.managers === "number" &&
      typeof captured.sessions === "number" &&
      typeof captured.agents === "number" &&
      typeof captured.registries === "number" &&
      typeof captured.factoryResources === "number" &&
      typeof captured.heapUsed === "number",
  );
  captures.push({
    completed,
    pid: gateway.pid,
    ...captured,
    listeners: captured.listeners,
    managers: captured.managers,
    sessions: captured.sessions,
    agents: captured.agents,
    registries: captured.registries,
    factoryResources: captured.factoryResources,
    heapUsed: captured.heapUsed,
  });
  console.log(JSON.stringify({ completed, pid: gateway.pid, ...captured }));
}
async function measureSurge(
  rpc: (method: string, params: unknown) => Promise<Record<string, unknown>>,
  terminal: (runId: unknown) => Promise<Record<string, unknown>>,
) {
  const sample = (action: "sample" | "start" | "stop") =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = randomUUID();
      const timeout = setTimeout(() => {
        gateway.off("message", receive);
        reject(new Error("Surge IPC timed out"));
      }, 120_000);
      function receive(message: unknown) {
        if (isRecord(message) && message.channel === "listener-surge" && message.id === id) {
          clearTimeout(timeout);
          gateway.off("message", receive);
          if (message.error) {
            reject(new Error(JSON.stringify(message.error)));
          } else {
            resolve(message);
          }
        }
      }
      gateway.on("message", receive);
      gateway.send({ channel: "listener-surge", id, action });
    });
  let measuring = false;
  const receipts = createTeamStressFanoutReceipts(clientCount, []);
  const sequences = new Map<number, number>();
  let sequenceError: string | undefined;
  const latency: number[] = [];
  const listLatencies: Record<"all" | "active", number[]> = { all: [], active: [] };
  const distribution = (samples: number[]) => {
    const sorted = samples.toSorted((left, right) => left - right);
    return {
      count: sorted.length,
      p50Ms: sorted[Math.floor(sorted.length * 0.5)],
      p95Ms: sorted[Math.floor(sorted.length * 0.95)],
      p99Ms: sorted[Math.floor(sorted.length * 0.99)],
      maxMs: sorted.at(-1),
    };
  };
  const delivered = Array.from({ length: clientCount }, () => ({
    changed: 0,
    message: 0,
    chat: 0,
  }));
  const audiences = [
    ["operator.admin", "operator.read", "operator.write"],
    ["operator.read", "operator.write"],
    ["operator.read"],
  ];
  for (let index = 0; index < clientCount; index++) {
    const scopes = audiences[index % audiences.length]!;
    const observer = createGatewayWsClient({
      url: `ws://127.0.0.1:${port}`,
      onEvent(event) {
        receipts.observe(index, event.event, isRecord(event.payload) ? event.payload : undefined);
        if (typeof event.seq === "number") {
          const previous = sequences.get(index);
          if (previous !== undefined && event.seq !== previous + 1) {
            sequenceError ??= `Client ${index} event sequence ${previous} -> ${event.seq}`;
          }
          sequences.set(index, event.seq);
        }
        if (!measuring) {
          return;
        }
        const count = delivered[index]!;
        if (event.event === "sessions.changed") {
          count.changed++;
        } else if (event.event === "session.message") {
          count.message++;
        } else if (event.event === "chat") {
          count.chat++;
        } else {
          return;
        }
        if (
          (event.event === "sessions.changed" || event.event === "session.message") &&
          isRecord(event.payload) &&
          typeof event.payload.ts === "number"
        ) {
          latency.push(Math.max(0, Date.now() - event.payload.ts));
        }
      },
    });
    surgeClients.push(observer);
    await observer.waitOpen();
    const connected = await observer.request("connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        version: "1.0.0",
        platform: process.platform,
        mode: "backend",
      },
      role: "operator",
      scopes,
      caps: ["session-scoped-events", "session-row-deltas", "session-event-field-refs"],
    });
    assert(connected.ok, JSON.stringify(connected.error));
    assert(isRecord(connected.payload) && isRecord(connected.payload.auth));
    assert.deepEqual(
      connected.payload.auth.scopes,
      scopes,
      "Viewer scopes changed at authentication",
    );
    const subscribed = await observer.request(
      "sessions.subscribe",
      {
        limit: 100,
        rowMode: "sidebar",
        source: "sidebar",
        includeMessageBodies: true,
      },
      120_000,
    );
    assert(subscribed.ok, JSON.stringify(subscribed.error));
  }
  const nonce = randomUUID();
  const beforeCount = (
    await rpc("sessions.list", { limit: 1, includeGlobal: true, includeUnknown: true })
  ).totalCount;
  assert.equal(typeof beforeCount, "number");
  const keys = Array.from(
    { length: activeCount },
    (_, index) => `agent:main:surge-${nonce}-${index}`,
  );
  receipts.trackForeground(keys);
  for (const key of keys) {
    await rpc("sessions.create", { key, agentId: "main" });
  }
  mode = "surge";
  const issuedRuns = await Promise.all(
    keys.map(async (sessionKey) =>
      rpc("chat.send", {
        sessionKey,
        message: "Stream the synthetic fixture reply.",
        deliver: false,
        idempotencyKey: randomUUID(),
      }),
    ),
  );
  await until("All surge sessions must reach the streaming provider", async () =>
    streams.size === activeCount ? true : undefined,
  );
  await until("Gateway work metrics must report the streaming sessions as running", async () => {
    const { work } = await sample("sample");
    return isRecord(work) && isRecord(work.sessions) && work.sessions.running === activeCount
      ? true
      : undefined;
  });
  // Retain streams through warmup and every measured row publication.
  await delay(5000);
  const beforeChunks = providerChunks;
  const samples: unknown[] = [];
  const started = performance.now();
  await sample("start");
  measuring = true;
  let rounds = 0;
  let minimumStreams = streams.size;
  while (performance.now() - started < durationMs) {
    const roundStarted = performance.now();
    minimumStreams = Math.min(minimumStreams, streams.size);
    assert.equal(streams.size, activeCount, "A provider stream ended during measurement");
    // Real metadata commits exercise the session-row publisher at a fixed offered rate.
    await Promise.all(
      keys.map((key, index) =>
        rpc("sessions.patch", { key, label: `Synthetic surge ${index}/${rounds}` }),
      ),
    );
    const activeOnly = rounds % 2 === 0;
    const listStarted = performance.now();
    await rpc("sessions.list", { limit: 100, activeOnly });
    listLatencies[activeOnly ? "active" : "all"].push(performance.now() - listStarted);
    samples.push(await sample("sample"));
    rounds++;
    await delay(Math.max(0, publicationMs - (performance.now() - roundStarted)));
  }
  const measured = await sample("stop");
  measuring = false;
  assert.equal(typeof measured.elapsedMs, "number");
  const seconds = Number(measured.elapsedMs) / 1000;
  const result = {
    ...measured,
    activeCount,
    clientCount,
    chunkMs,
    publicationMs,
    rounds,
    publications: rounds * keys.length,
    providerChunks: providerChunks - beforeChunks,
    mainCpuMsPerSecond: Number(measured.mainCpuMs) / seconds,
    publicationsPerSecond: (rounds * keys.length) / seconds,
    providerChunksPerSecond: (providerChunks - beforeChunks) / seconds,
    listCallsPerSecond: rounds / seconds,
    peakStreams,
    minimumStreams,
    audiences,
    delivered,
    workSamples: samples,
    eventToDelivery: distribution(latency),
    sessionsList: {
      all: distribution(listLatencies.all),
      active: distribution(listLatencies.active),
    },
  };
  surgeResult = result;
  console.log(JSON.stringify(result));
  assert.equal(
    measured.minimumRunning,
    activeCount,
    "Gateway running sessions fell during measurement",
  );
  assert(
    latency.length > 0 && delivered.every((count) => count.changed > 0),
    "No row publications reached clients",
  );
  finishStreams = true;
  for (const run of issuedRuns) {
    assert.equal((await terminal(run.runId)).status, "ok");
  }
  await until("Surge session publications did not drain", async () =>
    receipts.isDrained() ? true : undefined,
  );
  receipts.assertComplete();
  assert.equal(sequenceError, undefined, "A recipient missed or duplicated an event");
  Object.assign(result, {
    fanout: "exact recipient/session/event identities; contiguous client sequences",
  });
  for (const key of keys) {
    assert.equal(
      (await rpc("sessions.delete", { key, agentId: "main", deleteTranscript: true })).deleted,
      true,
    );
  }
  const afterCount = (
    await rpc("sessions.list", { limit: 1, includeGlobal: true, includeUnknown: true })
  ).totalCount;
  assert.equal(afterCount, beforeCount, "Owned surge sessions were not completely removed");
  Object.assign(result, { beforeCount, afterCount });
  return result;
}
try {
  const connect = async () => {
    const ready = await waitForInitialProbe({
      port,
      path: "/readyz",
      startAt: performance.now(),
      deadlineAt: performance.now() + 180_000,
      isDone: () => gateway.exitCode !== null || gateway.signalCode !== null,
    });
    assert.equal(ready.status, 200, "Gateway readiness failed; inspect gateway.log");
    client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
    await client.waitOpen();
    await rpc("connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        version: "1.0.0",
        platform: process.platform,
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      caps: [],
    });
  };
  const rpc = async (method: string, params: unknown) => {
    const result = await client!.request(method, params, 120_000);
    assert(result.ok, `${method}: ${JSON.stringify(result.error)}`);
    assert(isRecord(result.payload), `${method} returned no object`);
    return result.payload;
  };
  const terminal = (runId: unknown) =>
    until(`Run did not settle: ${String(runId)}`, async () => {
      const result = await rpc("agent.wait", { runId, timeoutMs: 60000 });
      return result.status === "pending" || result.status === "timeout" ? undefined : result;
    });
  const patchToolDeny = async (deny: string[]) => {
    const snapshot = await rpc("config.get", {});
    await rpc("config.patch", {
      baseHash: snapshot.hash,
      replacePaths: ["tools.deny"],
      raw: JSON.stringify({ tools: { deny } }),
    });
  };
  const historyMessages = async (sessionKey: string) => {
    const history = await rpc("chat.history", { sessionKey, limit: 100 });
    assert(Array.isArray(history.messages));
    return history.messages.filter(isRecord);
  };
  const isCurrentReply = (message: Record<string, unknown>) =>
    message.role === "assistant" &&
    message.stopReason === "stop" &&
    JSON.stringify(message.content).includes(replyMarker);
  await connect();
  if (scenario === "surge") {
    await measureSurge(rpc, terminal);
  } else {
    await capture(-4);
  }
  const lifecycleRuns = scenario === "surge" ? -4 : runs;
  for (let index = -4; index < lifecycleRuns; index++) {
    mode =
      scenario === "lifecycle"
        ? ["success", "abort", "failure", "success"][(index + 4) % 4]!
        : index < 0
          ? "success"
          : scenario === "all"
            ? [
                "success",
                "code",
                "abort",
                "degenerate",
                "failure",
                "compact",
                "cron",
                "subagent",
                "queue",
              ][index % 9]!
            : scenario;
    toolIssued = false;
    yieldIssued = false;
    replyMarker = `SYNTHETIC_DONE_${randomUUID()}`;
    const turnMode = mode;
    const key = `agent:main:listener-soak-${(index + 4) % 13}`;
    const beforeRequests = providerProgress.requests;
    const startedAt = performance.now();
    if (mode === "cron") {
      const job = await rpc("cron.add", {
        name: "Synthetic retention",
        agentId: "main",
        enabled: false,
        schedule: { kind: "every", everyMs: 86400000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Synthetic cron retention probe." },
        delivery: { mode: "none" },
      });
      const result = await rpc("cron.run", { id: job.id, mode: "force", waitTimeoutMs: 60000 });
      assert(isRecord(result.run) && result.run.status === "ok", JSON.stringify(result));
      turns.push({ index, mode, result });
      await rpc("cron.remove", { id: job.id });
    } else {
      const sent = await rpc("chat.send", {
        sessionKey: key,
        message: `Synthetic lifecycle ${index}.`,
        deliver: false,
        idempotencyKey: randomUUID(),
      });
      assert.equal(typeof sent.runId, "string");
      let followupId: string | undefined;
      if (mode === "abort" || mode === "queue" || mode === "restart") {
        await until("Held run never reached provider", async () =>
          providerProgress.requests > beforeRequests ? true : undefined,
        );
        if (mode === "queue") {
          // A changed tool policy must reject injection and park this steer as a new turn.
          await patchToolDeny(["read"]);
          const logOffset = readFileSync(config.logging!.file!, "utf8").length;
          followupId = randomUUID();
          await rpc("chat.send", {
            sessionKey: key,
            message: "Synthetic queued followup.",
            deliver: false,
            idempotencyKey: followupId,
            queueMode: "steer",
          });
          const rejection = await until(
            "Steering did not reject into the follow-up queue",
            async () => {
              const history = await rpc("chat.history", { sessionKey: key, limit: 20 });
              const diagnostic = readFileSync(config.logging!.file!, "utf8")
                .slice(logOffset)
                .split("\n")
                .find(
                  (line) =>
                    line.includes("steering rejected; applying follow-up policy") &&
                    line.includes(followupId!),
                );
              const pending = history.pendingInputs;
              const queued =
                isRecord(pending) &&
                Array.isArray(pending.items) &&
                pending.items.some(
                  (item) => isRecord(item) && item.runId === followupId && item.queued === true,
                );
              return queued && diagnostic
                ? { queued: history.pendingInputs, diagnostic }
                : undefined;
            },
          );
          assert.equal(
            providerProgress.requests,
            beforeRequests + 1,
            "Queued steer executed before incumbent release",
          );
          turns.push({ index, mode, ...rejection });
          mode = "success";
          for (const response of held) {
            writeOpenAiResponsesText(response, {
              text: "Synthetic held turn completed.",
              messageId: randomUUID(),
              responseId: randomUUID(),
            });
          }
        } else if (mode === "restart") {
          const previousPid = gateway.pid;
          assert(previousPid);
          execFileSync(
            process.execPath,
            [
              "--import",
              "./scripts/tsx.mjs",
              "--input-type=module",
              "--eval",
              `const { writeGatewayRestartIntentSync } = await import("./src/infra/restart-intent.ts");
           if (!writeGatewayRestartIntentSync({ targetPid: ${previousPid}, intent: { reason: "gateway.restart", force: true, waitMs: 100 } })) process.exitCode = 1;`,
            ],
            { env, stdio: "pipe", timeout: 60000 },
          );
          client!.close();
          gateway.kill("SIGTERM");
          await until("Owned Gateway did not exit for restart", async () =>
            gateway.exitCode !== null || gateway.signalCode !== null ? true : undefined,
          );
          assert.equal(gateway.exitCode, 0, "Restart shutdown was not clean");
          await stopChild(gateway);
          for (const response of held) {
            response.destroy();
          }
          mode = "success";
          gateway = startGateway();
          await connect();
          const resumed = await until(
            "Restart did not automatically resume the interrupted turn",
            async () => (await historyMessages(key)).find(isCurrentReply),
          );
          assert(
            providerProgress.requests > beforeRequests + 1,
            "Restart did not resume model work",
          );
          turns.push({ index, mode: turnMode, previousPid, pid: gateway.pid, resumed });
        } else {
          await rpc("chat.abort", { sessionKey: key, runId: sent.runId });
          for (const response of held) {
            response.destroy();
          }
        }
      }
      const settled = turnMode === "restart" ? { status: "resumed" } : await terminal(sent.runId);
      const expectedStatus =
        turnMode === "restart"
          ? "resumed"
          : ["abort", "failure"].includes(turnMode)
            ? "error"
            : "ok";
      assert.equal(settled.status, expectedStatus, JSON.stringify(settled));
      if (turnMode === "degenerate") {
        assert(toolIssued, "Degenerate arguments never reached the runtime");
      }
      if (followupId) {
        const followup = await terminal(followupId);
        assert.equal(followup.status, "ok", JSON.stringify(followup));
        const reply = (await historyMessages(key)).find(
          (message) =>
            isCurrentReply(message) &&
            isRecord(message["__openclaw"]) &&
            message["__openclaw"].runId === followupId,
        );
        assert(reply, "Queued steer produced no final reply for its run");
        turns.push({ index, mode: "queue", followup, reply });
        await patchToolDeny([]);
      }
      if (mode === "code" || mode === "subagent") {
        const currentMessages = (await historyMessages(key)).filter(
          (message) =>
            isRecord(message["__openclaw"]) && message["__openclaw"].runId === sent.runId,
        );
        const toolResult = currentMessages.findLast(
          (message) => message.role === "toolResult" && message.toolName === "exec",
        );
        assert(toolResult && toolResult.isError === false, "Current exec did not succeed");
        turns.push({ index, mode, toolResult });
        if (mode === "code") {
          assert(JSON.stringify(toolResult.content).includes("SYNTHETIC_CODE_DONE"));
        }
        if (mode === "subagent") {
          assert(Array.isArray(toolResult.content));
          const receipt = toolResult.content.find(
            (content) => isRecord(content) && content.type === "text",
          );
          assert(isRecord(receipt) && typeof receipt.text === "string");
          const child = JSON.parse(receipt.text).value;
          assert(
            isRecord(child) &&
              child.status === "accepted" &&
              typeof child.childSessionKey === "string" &&
              typeof child.runId === "string",
            "Current run has no accepted child",
          );
          const yieldMessage = currentMessages.findLast(
            (message) =>
              isRecord(message) &&
              message.role === "toolResult" &&
              message.toolName === "sessions_yield" &&
              JSON.stringify(message.content).includes("yielded"),
          );
          assert(
            isRecord(yieldMessage) && isRecord(yieldMessage["__openclaw"]),
            "Current run never yielded",
          );
          const yieldId = yieldMessage["__openclaw"].id;
          const childEnd = await terminal(child.runId);
          assert.equal(childEnd.status, "ok", JSON.stringify(childEnd));
          const resumed = await until(
            "Yielded parent never resumed to a new final reply",
            async () => {
              const messages = await historyMessages(key);
              const yieldedAt = messages.findIndex(
                (message) =>
                  isRecord(message["__openclaw"]) && message["__openclaw"].id === yieldId,
              );
              return yieldedAt < 0 ? undefined : messages.slice(yieldedAt + 1).find(isCurrentReply);
            },
          );
          turns.push({ index, mode, childEnd, yieldId, resumed });
        }
      }
      const turnResult = {
        index,
        mode: turnMode,
        terminal: settled.status,
        elapsedMs: performance.now() - startedAt,
      };
      turns.push(turnResult);
      console.log(JSON.stringify(turnResult));
      if (mode === "compact") {
        await rpc("chat.inject", {
          sessionKey: key,
          message: "Synthetic compaction history. ".repeat(1000),
        });
        const compaction = await rpc("sessions.compact", { key, agentId: "main" });
        assert.equal(
          compaction.compacted,
          true,
          `Compaction was a no-op: ${JSON.stringify(compaction)}`,
        );
        turns.push({ index, mode, compaction });
      }
    }
    if (index === -1 || (index + 1) % Number(values["capture-every"]) === 0 || index + 1 === runs) {
      await delay(settleMs);
      await capture(index + 1);
    }
  }
  if (values["expect-released"]) {
    const warm = captures[0]!;
    for (const sample of captures.slice(1)) {
      assert.equal(
        sample.listeners,
        warm.listeners,
        "Transcript listeners did not return to baseline",
      );
      assert.equal(sample.managers, warm.managers, "SessionManagers did not return to baseline");
      assert.equal(sample.sessions, warm.sessions, "AgentSessions did not return to baseline");
      assert.equal(sample.agents, warm.agents, "Agents did not return to baseline");
      assert.equal(
        sample.registries,
        warm.registries,
        "ModelRegistries did not return to baseline",
      );
      assert.equal(
        sample.factoryResources,
        warm.factoryResources,
        "ContextEngineFactoryResources did not return to baseline",
      );
    }
    // Mixed paths lazily load different subsystems; their cold-to-warm heap is not a slope.
    if (scenario === "lifecycle") {
      const firstActive = captures[1]!;
      assert(
        captures.at(-1)!.heapUsed <= firstActive.heapUsed * 1.1,
        "Post-warmup heap grew more than 10%",
      );
    }
  }
} catch (error) {
  failure = error instanceof Error ? error : new Error("Synthetic soak failed", { cause: error });
} finally {
  client?.close();
  for (const observer of surgeClients) {
    observer.close();
  }
  finishStreams = true;
  for (const response of held) {
    response.destroy();
  }
  if (scenario === "surge") {
    try {
      const shutdown = await stopGatewayGracefully(gateway, 90_000);
      if (isRecord(surgeResult)) {
        surgeResult.shutdown = shutdown;
      }
    } catch (error) {
      failure ??=
        error instanceof Error ? error : new Error("Surge shutdown failed", { cause: error });
    }
  }
  await stopChild(gateway);
  providerServer.closeAllConnections();
  await new Promise<void>((resolve) => {
    providerServer.close(() => resolve());
  });
  writeFileSync(
    path.join(output, "results.json"),
    JSON.stringify(
      {
        summary,
        hostLoad,
        hostLoadEnd: loadavg(),
        runs,
        scenario,
        baseline: values["baseline-dir"],
        cleanupFailEvery: values["cleanup-fail-every"],
        allocations: values.allocations,
        settleMs,
        captures,
        turns,
        surge: surgeResult,
        failure: failure?.message,
      },
      null,
      2,
    ),
  );
}
if (failure) {
  throw failure;
}
