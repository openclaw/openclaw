// Focused sessions.create RPC/phase measurement against an already-built, isolated Gateway.
// node --import ./scripts/tsx.mjs scripts/perf/session-create-measure.ts \
//   --output .local/create-base --revision <sha> --samples 25
// Repeat with a fresh output directory after building the candidate. Both arms use
// 10,800 synthetic sessions and 40 enabled bundled plugins. --allocations is a
// separate diagnostic pass: do not use its timing/GC numbers as performance gates.
// Reports p50/p95 with counts; p95 below 200 samples is context, not a tail gate.
// --state-dir can consume a fresh offline team-shape fixture prepared during a build.
// CPU distinguishes main OS-thread from whole-process usage across create/readback
// cycles (and completed initial turns). Git launch counts cover each create interval,
// including any unrelated background work; they are not causal attribution.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createPortProbe } from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { applyMockOpenAiModelConfig } from "../e2e/lib/fixtures/mock-openai-config.mjs";
import { readBody, writeSse } from "../e2e/lib/mock-openai-http.mjs";
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
  createGatewayBenchEnv,
  summarizeNumbers,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";
import {
  generateTeamShapeStressFixture,
  TEAM_STRESS_PLUGIN_IDS,
} from "./team-shape-stress-fixture.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "state-dir": { type: "string" },
    entry: { type: "string", default: "dist/entry.js" },
    revision: { type: "string" },
    samples: { type: "string", default: "25" },
    sessions: { type: "string", default: "10800" },
    now: { type: "string", default: String(Date.now()) },
    kinds: { type: "string", default: "plain,worktree,initial" },
    allocations: { type: "boolean", default: false },
  },
});
if (!values.output || !values.revision) {
  throw new Error("--output and --revision are required");
}
const output = path.resolve(values.output);
const entry = path.resolve(values.entry);
if (!entry.endsWith(`${path.sep}dist${path.sep}entry.js`)) {
  throw new Error("Use a built dist/entry.js");
}
const integer = (raw: string, label: string, min: number) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
const samples = integer(values.samples, "--samples", 1);
const sessions = integer(values.sessions, "--sessions", 100);
const now = integer(values.now, "--now", 1);
const kinds = values.kinds.split(",");
if (kinds.some((kind) => !["plain", "worktree", "initial"].includes(kind))) {
  throw new Error("--kinds must contain plain,worktree,initial");
}
mkdirSync(output);
const stateDir = values["state-dir"]
  ? path.resolve(values["state-dir"])
  : path.join(output, "state");
const invocationId = randomUUID();
async function freePort(excluded?: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const probe = createPortProbe();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    const address = probe.address();
    await new Promise<void>((resolve) => {
      probe.close(() => resolve());
    });
    if (
      address &&
      typeof address !== "string" &&
      address.port >= 40000 &&
      address.port !== excluded
    ) {
      return address.port;
    }
  }
  throw new Error("No free loopback port >=40000 found");
}
const port = await freePort();
const summarize = (numbers: number[]) => ({ count: numbers.length, ...summarizeNumbers(numbers) });

type PhaseSnapshot = {
  totalMs: number;
  stages: Array<{ name: string; durationMs: number }>;
  gitSpawns: Record<string, number>;
};
const phases: PhaseSnapshot[] = [];
let gateway: ChildProcess | undefined;
let client: ReturnType<typeof createGatewayWsClient> | undefined;
let mockRequests = 0;
const mock = createServer((req, res) => {
  void (async () => {
    await readBody(req);
    mockRequests++;
    await delay(150);
    const text = "Synthetic session-create measurement complete.";
    const item = {
      type: "message",
      id: `msg_${mockRequests}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    writeSse(res, [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      },
      {
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: text,
      },
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
          id: `resp_${mockRequests}`,
          status: "completed",
          output: [item],
          usage: { input_tokens: 11, output_tokens: 8, total_tokens: 19 },
        },
      },
    ]);
  })().catch((error: unknown) => {
    res.writeHead(500);
    res.end(String(error));
  });
});
let cleanupPromise: Promise<void> | undefined;
const cleanup = () =>
  (cleanupPromise ??= (async () => {
    client?.close();
    if (gateway) {
      await stopChild(gateway, { teardownGraceMs: 10_000 });
    }
    mock.closeAllConnections();
    await new Promise<void>((resolve) => {
      mock.close(() => resolve());
    });
  })());
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}
async function rpc(method: string, params: unknown) {
  const response = await client!.request(method, params, 180_000);
  if (!response.ok) {
    throw new Error(`${method}: ${JSON.stringify(response.error)}`);
  }
  return response.payload;
}
try {
  console.log(`Preparing ${sessions} synthetic sessions in ${stateDir}`);
  const fixture = values["state-dir"]
    ? { summary: JSON.parse(readFileSync(path.join(stateDir, "team-shape-summary.json"), "utf8")) }
    : await generateTeamShapeStressFixture({
        stateDir,
        port,
        seed: 1826,
        now,
        sessions,
        transcriptMiB: 128,
      });
  if (
    fixture.summary.format !== "openclaw-team-shape-v1" ||
    fixture.summary.sessionCount !== sessions
  ) {
    throw new Error("--state-dir must contain the requested offline synthetic session fixture");
  }
  await new Promise<void>((resolve, reject) => {
    mock.once("error", reject);
    void freePort(port).then((mockPort) => mock.listen(mockPort, "127.0.0.1", resolve), reject);
  });
  const mockAddress = mock.address();
  if (!mockAddress || typeof mockAddress === "string") {
    throw new Error("Mock provider has no port");
  }
  const cfg = JSON.parse(readFileSync(path.join(stateDir, "openclaw.json"), "utf8"));
  applyMockOpenAiModelConfig(cfg, { mockPort: mockAddress.port, modelRef: "openai/gpt-4.1" });
  cfg.diagnostics = { ...cfg.diagnostics, enabled: true };
  cfg.plugins.allow = [...TEAM_STRESS_PLUGIN_IDS];
  cfg.plugins.entries = {
    ...cfg.plugins.entries,
    ...Object.fromEntries(TEAM_STRESS_PLUGIN_IDS.map((id) => [id, { enabled: true }])),
  };
  cfg.worktreeRoot = path.join(stateDir, "created-worktrees");
  const configPath = path.join(output, "openclaw.json");
  writeFileSync(configPath, JSON.stringify(cfg));
  const log = createWriteStream(path.join(output, "gateway.log"));
  gateway = spawn(
    process.execPath,
    buildGatewayBenchChildArgs(entry, port, [
      "--import",
      new URL("./team-shape-stress-loader.mjs", import.meta.url).pathname,
      "--import",
      new URL("./session-create-measure-loader.mjs", import.meta.url).pathname,
      "--import",
      new URL("../lib/gateway-bench-profile-preload.ts", import.meta.url).pathname,
    ]),
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: createGatewayBenchEnv(path.join(stateDir, "home"), configPath, {
        startupTrace: false,
        caseEnv: {
          OPENCLAW_STATE_DIR: stateDir,
          TMPDIR: path.join(stateDir, "tmp"),
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENAI_API_KEY: "synthetic-local-only",
          OPENCLAW_PROFILE: `create-measure-${port}`,
        },
      }),
    },
  );
  gateway.stdout?.pipe(log);
  gateway.stderr?.pipe(log);
  let startup = "";
  let listening = false;
  const observeStartup = (chunk: Buffer) => {
    startup = (startup + chunk.toString()).slice(-4096);
    listening ||= startup.includes("http server listening (");
  };
  gateway.stdout?.on("data", observeStartup);
  gateway.stderr?.on("data", observeStartup);
  gateway.on("message", (message: unknown) => {
    if (
      isRecord(message) &&
      message.channel === "session-create-measure" &&
      isRecord(message.snapshot)
    ) {
      phases.push(message.snapshot as PhaseSnapshot);
    }
  });
  const readyDeadline = Date.now() + 240_000;
  for (;;) {
    if (
      listening &&
      (await fetch(`http://127.0.0.1:${port}/readyz`).then(
        (r) => r.ok,
        () => false,
      ))
    ) {
      break;
    }
    if (gateway.exitCode !== null || gateway.signalCode !== null || Date.now() > readyDeadline) {
      throw new Error(`Gateway failed readiness; inspect ${output}/gateway.log`);
    }
    await delay(250);
  }
  client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
  await client.waitOpen();
  await rpc("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: "gateway-client",
      displayName: "synthetic-create-measure",
      version: "1.0.0",
      platform: process.platform,
      mode: "backend",
    },
    role: "operator",
    scopes: ["operator.admin", "operator.read", "operator.write"],
    caps: [],
  });
  const inventory = await rpc("plugins.list", {});
  writeFileSync(path.join(output, "plugin-inventory.json"), JSON.stringify(inventory, null, 2));
  const plugins = isRecord(inventory) && Array.isArray(inventory.plugins) ? inventory.plugins : [];
  const invalid = TEAM_STRESS_PLUGIN_IDS.filter(
    (id) =>
      !plugins.some(
        (plugin: unknown) =>
          isRecord(plugin) &&
          plugin.id === id &&
          plugin.enabled === true &&
          isRecord(plugin.runtime) &&
          !plugin.runtime.error,
      ),
  );
  if (invalid.length) {
    throw new Error(`Synthetic plugin inventory failed: ${invalid.join(", ")}`);
  }
  const startupList = await rpc("sessions.list", {
    agentId: "main",
    limit: 1,
    archived: "all",
    includeGlobal: true,
    includeUnknown: true,
  });
  if (!isRecord(startupList) || typeof startupList.totalCount !== "number") {
    throw new Error("Startup session inventory did not report its retained count");
  }
  const results = [];
  for (const kind of kinds) {
    const run = async (index: number) => {
      const key = `agent:main:dashboard:create-measure-${invocationId}-${kind}-${index}`;
      const beforePhase = phases.length;
      const requestsBefore = mockRequests;
      const started = performance.now();
      const payload = await rpc("sessions.create", {
        key,
        agentId: "main",
        label: `Synthetic create ${kind} ${index} ${invocationId}`,
        ...(kind === "worktree" ? { worktree: true, projectId: "team-shape-project-0" } : {}),
        ...(kind === "initial"
          ? { message: "Reply with one short synthetic acknowledgement." }
          : {}),
      });
      const wallMs = performance.now() - started;
      if (!isRecord(payload) || !isRecord(payload.entry) || typeof payload.sessionId !== "string") {
        throw new Error(`Creation returned no committed session: ${JSON.stringify(payload)}`);
      }
      const phaseDeadline = Date.now() + 10_000;
      while (phases.length === beforePhase && Date.now() < phaseDeadline) {
        await delay(5);
      }
      if (phases.length !== beforePhase + 1) {
        throw new Error("Missing or ambiguous create phase sample");
      }
      const phase = phases[beforePhase]!;
      if (kind === "initial") {
        if (payload.runStarted !== true || typeof payload.runId !== "string") {
          throw new Error(`Initial turn failed: ${JSON.stringify(payload)}`);
        }
        const waited = await rpc("agent.wait", { runId: payload.runId, timeoutMs: 120_000 });
        if (!isRecord(waited) || waited.status !== "ok") {
          throw new Error(`Initial turn did not complete: ${JSON.stringify(waited)}`);
        }
        if (mockRequests <= requestsBefore) {
          throw new Error("Initial turn completed without consuming the mock provider");
        }
      }
      const described = await rpc("sessions.describe", { key, agentId: "main" });
      if (
        !isRecord(described) ||
        !isRecord(described.session) ||
        described.session.sessionId !== payload.sessionId
      ) {
        throw new Error("Created session was not readable under the committed identity");
      }
      return { key, sessionId: payload.sessionId, wallMs, phase, entry: payload.entry };
    };
    const rows: Awaited<ReturnType<typeof run>>[] = [];
    for (let index = -3; index < 0; index++) {
      await run(index);
    }
    const heapPath = path.join(output, `${kind}.heapprofile`);
    const before = await readGatewayResources(gateway);
    const stopDiagnostics = await startGatewayDiagnostics(gateway, kind);
    if (values.allocations) {
      await controlGatewayProfile(gateway, "heap", "start", heapPath, {
        includeCollectedObjects: true,
      });
    }
    const hostLoadBefore = os.loadavg();
    for (let index = 0; index < samples; index++) {
      rows.push(await run(index));
    }
    const hostLoadAfter = os.loadavg();
    if (values.allocations) {
      await controlGatewayProfile(gateway, "heap", "stop", heapPath);
    }
    const diagnostics = await stopDiagnostics();
    const after = await readGatewayResources(gateway);
    const phaseNames = [
      ...new Set(rows.flatMap((row) => row.phase.stages.map((stage) => stage.name))),
    ];
    const gitOperations = [...new Set(rows.flatMap((row) => Object.keys(row.phase.gitSpawns)))];
    const result = {
      kind,
      rpcWallMs: summarize(rows.map((row) => row.wallMs)),
      handlerWallMs: summarize(rows.map((row) => row.phase.totalMs)),
      phaseMs: Object.fromEntries(
        phaseNames.map((name) => [
          name,
          summarize(
            rows.map((row) =>
              row.phase.stages
                .filter((stage) => stage.name === name)
                .reduce((sum, stage) => sum + stage.durationMs, 0),
            ),
          ),
        ]),
      ),
      cpu: measureGatewayCpuUsage(before, after),
      gitSpawns: Object.fromEntries(
        gitOperations.map((operation) => [
          operation,
          summarize(rows.map((row) => row.phase.gitSpawns[operation] ?? 0)),
        ]),
      ),
      memoryBefore: before.memory,
      memoryAfter: after.memory,
      hostLoadBefore,
      hostLoadAfter,
      diagnostics,
      ...(values.allocations ? { allocation: readGatewayHeapProfile(heapPath) } : {}),
      rows,
    };
    results.push(result);
    writeFileSync(path.join(output, `${kind}.json`), JSON.stringify(result, null, 2));
    console.log(
      JSON.stringify({
        kind,
        rpcWallMs: result.rpcWallMs,
        handlerWallMs: result.handlerWallMs,
        phaseMs: result.phaseMs,
        gitSpawns: result.gitSpawns,
        cpu: result.cpu,
      }),
    );
  }
  writeFileSync(
    path.join(output, "result.json"),
    JSON.stringify(
      {
        revision: values.revision,
        invocationId,
        entry,
        now: fixture.summary.now,
        sessions,
        startupRetainedSessionCount: startupList.totalCount,
        plugins: TEAM_STRESS_PLUGIN_IDS,
        fixture: fixture.summary,
        samples,
        mockRequests,
        mode: values.allocations ? "allocation-diagnostic" : "timing",
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await cleanup();
}
