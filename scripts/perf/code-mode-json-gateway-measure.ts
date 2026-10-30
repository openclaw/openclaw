/**
 * Team-shaped Code Mode load against an owned, built Gateway (never a live service).
 * Build the pinned revision first. Run baseline/candidate with separate new state dirs:
 * node --import ./scripts/tsx.mjs scripts/perf/code-mode-json-gateway-measure.ts \
 *   --state-dir .local/json-fit/base --port 42715 --revision <sha> --duration-ms 600000
 * Repeat with --allocations in a fresh directory for sampled allocation rates;
 * only the untraced run supplies latency/GC gates. --smoke uses 100 sessions,
 * 80 runs and 4 MiB transcripts for a short setup check, never stress evidence.
 * Defaults: 10,000 finished sessions (8,000 children), 40 plugins, 64 sockets.
 * Protocol v2: eight concurrent mock turns, 16 staggered sidebar/list/search
 * pollers every five seconds, and 40 idle subscribers. Admission lasts the full
 * window; in-flight work drains afterward and its duration is reported.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  createReadStream,
  createWriteStream,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { OpenClawConfig } from "../../src/config/types.openclaw.ts";
import { applyMockOpenAiModelConfig } from "../e2e/lib/fixtures/mock-openai-config.mjs";
import { stopChild } from "../lib/gateway-bench-child.ts";
import {
  controlGatewayProfile,
  measureGatewayCpuUsage,
  readGatewayHeapProfile,
  readGatewayResources,
  startGatewayDiagnostics,
} from "../lib/gateway-bench-profile.ts";
import {
  buildGatewayBenchChildArgs,
  summarizeNumbers,
  writeGatewayBenchConfig,
  writePluginFixtures,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";
import { generateTeamShapeFixture, parseTeamShapeOptions } from "./team-shape-fixture.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    port: { type: "string", default: "42715" },
    revision: { type: "string" },
    entry: { type: "string", default: "dist/entry.js" },
    "duration-ms": { type: "string", default: "600000" },
    "start-at": { type: "string" },
    allocations: { type: "boolean", default: false },
    smoke: { type: "boolean", default: false },
  },
});
if (!values["state-dir"] || !values.revision) {
  throw new Error("--state-dir (new, owned directory) and --revision are required");
}
const root = path.resolve(values["state-dir"]);
const entry = path.resolve(values.entry);
if (!entry.includes(`${path.sep}dist${path.sep}`)) {
  throw new Error("--entry must select a built dist Gateway");
}
const integer = (raw: string, label: string, min: number) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
const port = integer(values.port, "--port", 40_000);
if (port >= 65_535) {
  throw new Error("--port must leave room for the mock provider at port + 1");
}
const durationMs = integer(values["duration-ms"], "--duration-ms", values.smoke ? 1 : 600_000);
const mockPort = port + 1;
const sessionCount = values.smoke ? 100 : 10000;
const clientCount = 64;
const turnSenders = 8;
const listPollers = 16;
const listIntervalMs = 5000;
const marker = "CODE_MODE_JSON_LOAD_OK";
const variants = [
  { name: "small", code: 'json({ok:true}); return {text:"small",items:[1,2,3]};' },
  {
    name: "large",
    code: 'text("a".repeat(90000)); return {text:"b".repeat(90000),items:[1,2,3]};',
  },
  {
    name: "error",
    code: 'text("a".repeat(90000)); throw new Error("synthetic error ".repeat(6000));',
  },
  {
    name: "unicode",
    code: 'json({text:"é中🌍\\n\\\"".repeat(12000)}); return "中🌍".repeat(16000);',
  },
  {
    name: "network",
    code: 'await fixture_json_network({}); text("network".repeat(12000)); return "中🌍".repeat(8000);',
  },
];
const clients: ReturnType<typeof createGatewayWsClient>[] = [];
const children: ChildProcess[] = [];
const logs: ReturnType<typeof createWriteStream>[] = [];
let fixtureCreated = false;
let stopped = false;
const failures: string[] = [];
let completedTurns = 0;
let startedTurns = 0;
const completedByVariant = Object.fromEntries(variants.map(({ name }) => [name, 0]));
const listLatencies: number[] = [];
const report: Record<string, unknown> = {
  revision: values.revision,
  entry,
  mode: values.allocations ? "sampled-allocation" : "untraced",
  requestedDurationMs: durationMs,
  smoke: values.smoke,
  workload: {
    protocol: "code-mode-json-v2",
    subscribedClients: clientCount,
    turnSenders,
    listPollers,
    listIntervalMs,
    staggered: true,
    idleSubscribers: clientCount - turnSenders - listPollers,
  },
  sourceHashesAtLaunch: Object.fromEntries(
    [
      "../../src/agents/code-mode-json.ts",
      "../../src/agents/code-mode-json-fit.ts",
      "./code-mode-json-gateway-measure.ts",
    ].map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(new URL(file, import.meta.url)))
        .digest("hex"),
    ]),
  ),
  entrySha256: createHash("sha256").update(readFileSync(entry)).digest("hex"),
  builtOwnerHashes: Object.fromEntries(
    readdirSync(path.dirname(entry))
      .filter((name) => /^code-mode-json-.*\.mjs$/.test(name))
      .map((name) => [
        name,
        createHash("sha256")
          .update(readFileSync(path.join(path.dirname(entry), name)))
          .digest("hex"),
      ]),
  ),
};
let cleanupPromise: Promise<void> | undefined;
function cleanup() {
  return (cleanupPromise ??= (async () => {
    stopped = true;
    for (const client of clients) {
      client.close();
    }
    for (const child of children.toReversed()) {
      await stopChild(child, { teardownGraceMs: 10_000 });
    }
    for (const log of logs) {
      log.end();
    }
  })());
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}
async function rpc(client: (typeof clients)[number], method: string, params: unknown) {
  const response = await client.request(method, params, 120_000);
  if (!response.ok) {
    throw new Error(`${method}: ${JSON.stringify(response.error)}`);
  }
  return response.payload;
}
function observeListening(child: ChildProcess, markerText: string) {
  let output = "";
  let listening = false;
  const observe = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-2048);
    listening ||= output.includes(markerText);
  };
  child.stdout!.on("data", observe);
  child.stderr!.on("data", observe);
  return () => listening;
}
async function healthy(url: string, child: ChildProcess, listening: () => boolean) {
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    if (stopped) {
      break;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Child exited before ${url} became healthy`);
    }
    if (
      listening() &&
      (await fetch(url, { signal: AbortSignal.timeout(1000) }).then(
        (response) => response.ok,
        () => false,
      ))
    ) {
      return;
    }
    await delay(250);
  }
  throw new Error(`Readiness deadline: ${url}`);
}
async function turn(client: (typeof clients)[number], index: number, warmup = false) {
  const variant = variants[index % variants.length]!;
  const runId = randomUUID();
  // Fresh conversations keep history growth from changing the workload over time.
  const sessionKey = `agent:main:json-fit-${warmup ? "warmup" : "load"}-${index}`;
  startedTurns++;
  const accepted = await rpc(client, "agent", {
    sessionKey,
    model: `openai/json-fit-${variant.name}`,
    message: `Run the synthetic Code Mode JSON ${variant.name} measurement ${index}.`,
    deliver: false,
    idempotencyKey: runId,
  });
  if (!isRecord(accepted) || accepted.runId !== runId) {
    throw new Error("Agent admission mismatch");
  }
  const result = await rpc(client, "agent.wait", { runId, timeoutMs: 110_000 });
  if (!isRecord(result) || result.status !== "ok" || result.runId !== runId) {
    throw new Error(`Agent failed: ${JSON.stringify(result)}`);
  }
  const receipt = result.terminalReceipt;
  if (
    !isRecord(receipt) ||
    !Array.isArray(receipt.successfulToolNames) ||
    (variant.name !== "error" && !receipt.successfulToolNames.includes("exec")) ||
    !isRecord(result.terminalReply) ||
    result.terminalReply.text !== marker
  ) {
    throw new Error(`Missing Code Mode terminal proof: ${JSON.stringify(result)}`);
  }
  completedTurns++;
  completedByVariant[variant.name] = (completedByVariant[variant.name] ?? 0) + 1;
}

async function checkPorts() {
  for (const listenPort of [port, mockPort]) {
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(listenPort, "127.0.0.1", () =>
        probe.close((error) => (error ? reject(error) : resolve())),
      );
    });
  }
}
try {
  await checkPorts();
  const fixture = await generateTeamShapeFixture(
    parseTeamShapeOptions([
      "--state-dir",
      root,
      "--port",
      String(port),
      "--sessions",
      String(sessionCount),
      "--runs",
      values.smoke ? "80" : "8000",
      "--settled-runs",
      "--transcript-mib",
      values.smoke ? "4" : "64",
      "--approvals",
      "200",
      "--cron",
      "100",
      "--projects",
      "0",
      "--now",
      "1792800000000",
    ]),
  );
  fixtureCreated = true;
  report.fixture = fixture.summary;
  const configPath = path.join(root, "openclaw.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as OpenClawConfig;
  applyMockOpenAiModelConfig(config, { mockPort, modelRef: "openai/json-fit-small" });
  const provider = config.models!.providers!.openai!;
  const modelTemplate = provider.models[0]!;
  provider.api = "openai-completions";
  provider.models = variants.map(({ name }) => ({
    ...modelTemplate,
    id: `json-fit-${name}`,
    name: `json-fit-${name}`,
    api: "openai-completions",
  }));
  config.agents!.defaults!.models = Object.fromEntries(
    variants.map(({ name }) => [
      `openai/json-fit-${name}`,
      { agentRuntime: { id: "openclaw" }, params: { transport: "sse" } },
    ]),
  );
  config.agents!.defaults!.maxConcurrent = turnSenders;
  config.tools = { codeMode: { enabled: true, executor: "node", maxOutputBytes: 65536 } };
  config.plugins = { ...config.plugins, allow: ["openai"] };
  const plugins = writePluginFixtures(root, { count: 40 });
  const networkManifestPath = path.join(
    plugins.pluginsDir,
    plugins.pluginIds[0]!,
    "openclaw.plugin.json",
  );
  const networkManifest: Record<string, unknown> = JSON.parse(
    readFileSync(networkManifestPath, "utf8"),
  );
  networkManifest.contracts = { tools: ["fixture_json_network"] };
  writeFileSync(networkManifestPath, JSON.stringify(networkManifest, null, 2) + "\n");
  // A real network-classified plugin tool exercises the ordinary untrusted wrapper.
  writeFileSync(
    path.join(plugins.pluginsDir, plugins.pluginIds[0]!, "index.cjs"),
    `module.exports = { id: ${JSON.stringify(plugins.pluginIds[0])}, register(api) {
      api.registerTool({ name: "fixture_json_network", label: "Synthetic network result",
        description: "Return synthetic network-classified text.", resultContentSource: "network",
        parameters: {type:"object",properties:{},additionalProperties:false},
        execute: async () => ({content:[{type:"text",text:"synthetic network"}],details:{ok:true}})
      });
    }};\n`,
  );
  writeGatewayBenchConfig(root, config, { pluginFixtures: plugins });
  const control = path.join(root, "mock-responses.json");
  const requestLog = path.join(root, "mock-requests.jsonl");
  writeFileSync(
    control,
    JSON.stringify({
      models: Object.fromEntries(
        variants.map(({ name, code }) => [
          `json-fit-${name}`,
          {
            text: marker,
            toolCall: {
              name: "exec",
              arguments: { title: "Measure JSON output", code, awaitResults: true },
            },
          },
        ]),
      ),
    }),
  );
  // Fixture generation can take minutes; another lane may claim a port meanwhile.
  await checkPorts();
  const mock = spawn(process.execPath, ["scripts/e2e/mock-openai-server.mjs"], {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      MOCK_PORT: String(mockPort),
      MOCK_RESPONSE_CONTROL: control,
      MOCK_REQUEST_LOG: requestLog,
      MOCK_BIND_HOST: "127.0.0.1",
    },
  });
  children.push(mock);
  const mockListening = observeListening(mock, `mock-openai listening on ${mockPort}`);
  const mockLog = createWriteStream(path.join(root, "mock.log"));
  logs.push(mockLog);
  mock.stdout!.pipe(mockLog, { end: false });
  mock.stderr!.pipe(mockLog, { end: false });
  await once(mock, "spawn");
  await healthy(`http://127.0.0.1:${mockPort}/health`, mock, mockListening);
  const gateway = spawn(
    process.execPath,
    [
      "--import",
      new URL("../tsx.mjs", import.meta.url).href,
      "--import",
      new URL("../lib/gateway-bench-profile-preload.ts", import.meta.url).href,
      ...buildGatewayBenchChildArgs(entry, port),
    ],
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...fixture.env, OPENAI_API_KEY: "synthetic-loopback-only" },
    },
  );
  children.push(gateway);
  const gatewayListening = observeListening(gateway, "http server listening (");
  const gatewayLog = createWriteStream(path.join(root, "gateway-stdio.log"));
  logs.push(gatewayLog);
  gateway.stdout!.pipe(gatewayLog, { end: false });
  gateway.stderr!.pipe(gatewayLog, { end: false });
  await once(gateway, "spawn");
  await healthy(`http://127.0.0.1:${port}/readyz`, gateway, gatewayListening);
  for (let index = 0; index < clientCount; index++) {
    const client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
    clients.push(client);
    await client.waitOpen();
    await rpc(client, "connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        version: "1.0.0",
        platform: process.platform,
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
      caps: [],
    });
    await rpc(client, "sessions.subscribe", {});
  }
  for (let index = 0; index < variants.length; index++) {
    await turn(clients[index]!, index, true);
  }
  const inventory = await rpc(clients[0]!, "plugins.list", {});
  if (!isRecord(inventory) || !Array.isArray(inventory.plugins)) {
    throw new Error("plugins.list did not return an inventory");
  }
  const loadedFixturePlugins = inventory.plugins.filter(
    (plugin: unknown) =>
      isRecord(plugin) &&
      typeof plugin.id === "string" &&
      plugins.pluginIds.includes(plugin.id) &&
      isRecord(plugin.runtime) &&
      plugin.runtime.state === "active",
  );
  if (loadedFixturePlugins.length !== 40) {
    throw new Error(`Only ${loadedFixturePlugins.length}/40 fixture plugins are active`);
  }
  report.activePluginIds = loadedFixturePlugins.map((plugin: unknown) =>
    isRecord(plugin) ? plugin.id : undefined,
  );
  const sessions = await rpc(clients[0]!, "sessions.list", { limit: 1, archived: "all" });
  if (
    !isRecord(sessions) ||
    typeof sessions.totalCount !== "number" ||
    sessions.totalCount < sessionCount
  ) {
    throw new Error(`Gateway did not expose the ${sessionCount}-session fixture`);
  }
  report.initialSessionCount = sessions.totalCount;
  if (clients.filter((client) => client.ws.readyState === client.ws.OPEN).length !== clientCount) {
    throw new Error("Not all 64 subscribed WebSockets remained open before load");
  }
  startedTurns = 0;
  completedTurns = 0;
  for (const variant of variants) {
    completedByVariant[variant.name] = 0;
  }
  if (values["start-at"]) {
    const startAt = integer(values["start-at"], "--start-at", 1);
    if (Date.now() > startAt) {
      throw new Error("Synchronized start already passed during setup");
    }
    await delay(startAt - Date.now());
  }
  const heapPath = path.join(root, "load.heapprofile");
  if (values.allocations) {
    await controlGatewayProfile(gateway, "heap", "start", heapPath, {
      includeCollectedObjects: true,
    });
  }
  const stopDiagnostics = await startGatewayDiagnostics(gateway, "json-fit-load");
  const before = await readGatewayResources(gateway);
  report.hostLoadBefore = loadavg();
  const startedAt = performance.now();
  const deadline = startedAt + durationMs;
  let nextTurn = 0;
  const jobs = clients
    .map(async (client, index) => {
      if (index >= turnSenders + listPollers) {
        return;
      }
      if (index >= turnSenders) {
        await delay(((index - turnSenders) * listIntervalMs) / listPollers);
      }
      let iteration = 0;
      while (performance.now() < deadline) {
        if (stopped) {
          break;
        }
        if (index < turnSenders) {
          await turn(client, nextTurn++);
          await delay(2000);
        } else {
          const start = performance.now();
          const mode = (index + iteration++) % 3;
          await rpc(client, "sessions.list", {
            limit: 100,
            archived: "all",
            ...(mode === 0
              ? { rowMode: "sidebar", source: "sidebar" }
              : mode === 1
                ? { source: "sessions-page" }
                : { source: "sessions-page", search: "Synthetic review" }),
          });
          listLatencies.push(performance.now() - start);
          await delay(listIntervalMs);
        }
      }
    })
    .map((job) =>
      job.catch((error: unknown) => {
        stopped = true;
        failures.push(String(error));
      }),
    );
  const joined = Promise.all(jobs);
  await Promise.race([delay(durationMs, undefined, { ref: false }), joined]);
  const admissionEndedAt = performance.now();
  await joined;
  const drainedAt = performance.now();
  const after = await readGatewayResources(gateway);
  report.hostLoadAfter = loadavg();
  report.openClientsAfterLoad = clients.filter(
    (client) => client.ws.readyState === client.ws.OPEN,
  ).length;
  if (report.openClientsAfterLoad !== clientCount) {
    failures.push("A subscribed WebSocket closed during load");
  }
  const diagnostics = await stopDiagnostics();
  const cpu = measureGatewayCpuUsage(before, after);
  let allocation: ReturnType<typeof readGatewayHeapProfile> | undefined;
  if (values.allocations) {
    await controlGatewayProfile(gateway, "heap", "stop", heapPath);
    allocation = readGatewayHeapProfile(heapPath);
  }
  Object.assign(report, {
    actualAdmissionMs: admissionEndedAt - startedAt,
    drainMs: drainedAt - admissionEndedAt,
    measuredMs: cpu.wallMs,
    clients: clientCount,
    plugins: 40,
    startedTurns,
    completedTurns,
    completedByVariant,
    cpu,
    mainThreadCpuPercent: (cpu.mainThread.totalMs / cpu.wallMs) * 100,
    memory: { before: before.memory, after: after.memory },
    diagnostics,
    gcSecondsPerMinute: ((diagnostics.gc.durationMs?.total ?? 0) / diagnostics.durationMs) * 60,
    sessionsList: {
      ...summarizeNumbers(listLatencies),
      count: listLatencies.length,
      p99:
        listLatencies.toSorted((a, b) => a - b)[Math.ceil(listLatencies.length * 0.99) - 1] ?? null,
    },
    allocation,
    sampledAllocatedBytesPerSecond: allocation
      ? allocation.sampledAllocatedBytes / (cpu.wallMs / 1000)
      : null,
  });
  // Provider records prove real model-visible control results, not helper-only calls.
  const outputs: Record<
    string,
    { count: number; truncated: number; errorTruncated: number; wrapped: number; first: string }
  > = {};
  for await (const line of createInterface({
    input: createReadStream(requestLog),
    crlfDelay: Infinity,
  })) {
    const record: unknown = JSON.parse(line);
    if (!isRecord(record) || typeof record.body !== "string") {
      continue;
    }
    const body: unknown = JSON.parse(record.body);
    if (!isRecord(body) || typeof body.model !== "string" || !Array.isArray(body.messages)) {
      continue;
    }
    const tool = body.messages.findLast(
      (message: unknown) => isRecord(message) && message.role === "tool",
    );
    if (!isRecord(tool) || typeof tool.content !== "string") {
      continue;
    }
    const result = (outputs[body.model] ??= {
      count: 0,
      truncated: 0,
      errorTruncated: 0,
      wrapped: 0,
      first: tool.content,
    });
    result.count++;
    result.truncated += Number(tool.content.includes('"truncated":true'));
    result.errorTruncated += Number(tool.content.includes(" [error truncated]"));
    result.wrapped += Number(tool.content.includes("EXTERNAL_UNTRUSTED_CONTENT"));
    const expectedStatus = body.model === "json-fit-error" ? "failed" : "completed";
    if (!tool.content.includes(`"status":"${expectedStatus}"`)) {
      failures.push(`Unexpected Code Mode status for ${body.model}`);
    }
  }
  report.modelVisibleOutputs = outputs;
  if (!outputs["json-fit-network"]?.wrapped) {
    failures.push("Network result wrapper was not observed");
  }
  for (const variant of variants) {
    if (!outputs[`json-fit-${variant.name}`]?.count) {
      failures.push(`No model-visible ${variant.name} output`);
    }
    if (
      variant.name === "error"
        ? !outputs["json-fit-error"]?.errorTruncated
        : variant.name !== "small" && !outputs[`json-fit-${variant.name}`]?.truncated
    ) {
      failures.push(`Oversized ${variant.name} result did not truncate`);
    }
  }
  if (completedTurns !== startedTurns) {
    failures.push("Not every admitted turn completed");
  }
  report.failures = failures;
  if (failures.length) {
    throw new Error(failures.join("\n"));
  }
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  await cleanup();
  if (fixtureCreated) {
    writeFileSync(path.join(root, "measurement.json"), JSON.stringify(report, null, 2) + "\n");
  }
  console.log(
    JSON.stringify(
      {
        report: fixtureCreated ? path.join(root, "measurement.json") : undefined,
        error: report.error,
        failures: report.failures,
        completedTurns,
        mainThreadCpuPercent: report.mainThreadCpuPercent,
        gcSecondsPerMinute: report.gcSecondsPerMinute,
        sessionsList: report.sessionsList,
        sampledAllocatedBytesPerSecond: report.sampledAllocatedBytesPerSecond,
      },
      null,
      2,
    ),
  );
}
