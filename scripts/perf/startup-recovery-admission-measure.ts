/**
 * Isolated full-Gateway crash/restart proof; run once per already-built revision:
 * node --import ./scripts/tsx.mjs scripts/perf/startup-recovery-admission-measure.ts \
 *   --checkout /absolute/built-checkout --port 45100 --output "$PWD/.local/restart-base"
 *
 * Defaults: 10,000 retained sessions / 128 MiB transcripts in active main, five
 * configured agents with interrupted turns, five reconnecting clients, 40 empty
 * startup plugins. The mock provider holds streaming responses until SIGKILL.
 * Before restart, an owned offline writer leaves 16 MiB WAL per configured agent
 * (--wal-mib) using existing cache rows, then is killed without closing SQLite.
 * The first reconnect probes read RPCs immediately after hello, before readiness.
 * Reconnecting clients request only operator.read; negotiated scopes are recorded.
 * Reports file sizes, read latency/errors, startup phases and durable replies.
 * Add --workboard to load the bundled plugin and probe its scoped cards list.
 * Add --resources to collect three fresh diagnostic memory samples after durable
 * recovery (120s limit), with list/Workboard reads every 5s. This enables the
 * bundled Prometheus exporter; heaps are live samples, not forced-GC retention.
 * This is a restart proof, not the canonical steady-state Team stress campaign.
 * Empty plugins and streamed turns do not model plugin work or interrupted tools.
 * A small observed WAL or no deferred admission means the incident was not fully
 * reproduced; recovery correctness alone must not be presented as a latency win.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv, createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { GatewayClient, isGatewayProtocolResponseError } from "../../src/gateway/client.js";
import { buildMockOpenAiResponsesProvider } from "../../src/gateway/test-openai-responses-model.js";
import { loadOrCreateDeviceIdentity } from "../../src/infra/device-identity.js";
import { hasErrnoCode } from "../../src/infra/errno.js";
import { toErrorObject } from "../../src/infra/errors.js";
import { extractTextFromChatContent } from "../../src/shared/chat-content.js";
import { extractAssistantPhaseText } from "../../src/shared/chat-message-content.js";
import { restartEnv, restartModelConfig } from "../../test/gateway-restart.test-support.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { createGatewayBenchEnv, writePluginFixtures } from "../lib/gateway-bench-runtime.js";

const { values } = parseArgs({
  options: {
    checkout: { type: "string" },
    output: { type: "string" },
    port: { type: "string", default: "45100" },
    sessions: { type: "string", default: "10000" },
    "transcript-mib": { type: "string", default: "128" },
    agents: { type: "string", default: "5" },
    clients: { type: "string", default: "5" },
    plugins: { type: "string", default: "40" },
    workboard: { type: "boolean" },
    resources: { type: "boolean" },
    "timeout-seconds": { type: "string", default: "600" },
    "wal-mib": { type: "string", default: "16" },
    "prepare-wal-agent": { type: "string" },
  },
});
if (values["prepare-wal-agent"]) {
  assert(process.send && values.output, "WAL preparation requires the owning controller's IPC");
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  assert(
    stateDir?.startsWith(`${path.resolve(values.output)}${path.sep}`),
    "Writer state must be inside this proof output",
  );
  const mib = Number(values["wal-mib"]);
  assert(Number.isSafeInteger(mib) && mib > 0 && mib <= 256, "--wal-mib must be 1..256");
  const { openOpenClawAgentDatabase, runOpenClawAgentWriteTransaction } =
    await import("../../src/state/openclaw-agent-db.js");
  const options = { agentId: values["prepare-wal-agent"], env: process.env };
  const database = openOpenClawAgentDatabase(options);
  database.db.exec("PRAGMA wal_autocheckpoint=0");
  const cipher = createCipheriv(
    "aes-256-ctr",
    createHash("sha256").update(options.agentId).digest(),
    Buffer.alloc(16),
  );
  const zeros = Buffer.alloc(48 * 1024);
  // Same existing-table fixture pattern as seal-version-restart.ts; no schema or
  // admission hooks. Synchronous 2 MiB batches finish before maintenance timers.
  for (let first = 0; first < mib * 16; first += 32) {
    runOpenClawAgentWriteTransaction(({ db }) => {
      const insert = db.prepare(
        "INSERT INTO cache_entries(scope,key,value_json,updated_at) VALUES (?,?,?,?)",
      );
      for (let row = first; row < Math.min(first + 32, mib * 16); row++) {
        insert.run(
          "startup-recovery-proof",
          String(row),
          JSON.stringify({ value: cipher.update(zeros).toString("base64") }),
          Date.now(),
        );
      }
    }, options);
  }
  process.send({ prepared: true, agentId: options.agentId });
  // IPC keeps this child alive until its controller crashes it; never publish a
  // clean-close receipt for this intentionally unclean offline fixture.
  process.once("disconnect", () => process.exit(1));
  await new Promise<never>(() => {});
}
assert(values.checkout && values.output, "--checkout and a fresh --output directory are required");
const checkout = path.resolve(values.checkout);
const output = path.resolve(values.output);
const number = (value: string | undefined) => {
  const parsed = Number(value);
  assert(Number.isSafeInteger(parsed) && parsed > 0, "numeric options must be positive integers");
  return parsed;
};
const port = number(values.port);
assert(port >= 40000 && port <= 65532, "--port must be 40000..65532 (provider uses port + 2)");
const sessionCount = number(values.sessions);
const timeoutMs = number(values["timeout-seconds"]) * 1000;
await stat(path.join(checkout, "dist/index.js"));
await mkdir(output); // Never overwrite another run's evidence.
const previousTmpdir = process.env.TMPDIR;
process.env.TMPDIR = path.join(output, "tmp");
await mkdir(process.env.TMPDIR);
const scenarios = Array.from({ length: number(values.agents) }, (_, index) => ({
  agentId: index === 0 ? "main" : `recovery${index}`,
  key: `agent:${index === 0 ? "main" : `recovery${index}`}:main`,
  marker: `RESTART_PROOF_TASK_${index}`,
  final: `RESTART_PROOF_COMPLETE_${index}`,
  sessionId: "",
  initialCalls: 0,
  recoveryCalls: 0,
  recoveryInstructionSeen: false,
  verified: false,
}));
let recovering = false;
let providerError: Error | undefined;
let ordinal = 0;
const provider = createServer((request, response) => {
  void (async () => {
    assert.equal(request.url, "/v1/responses");
    let raw = "";
    for await (const chunk of request) {
      raw += String(chunk);
    }
    const body = JSON.parse(raw) as { input?: unknown; tools?: unknown[]; stream?: boolean };
    const input = JSON.stringify(body.input);
    const scenario = scenarios.find((entry) => input?.includes(entry.marker));
    ordinal++;
    if (!scenario || !body.tools?.length) {
      // Auxiliary title generation is unrelated to the interrupted task.
      const text = "Synthetic restart proof";
      if (body.stream === false) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: `title_${ordinal}`,
            status: "completed",
            output: [
              { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
            ],
          }),
        );
      } else {
        writeOpenAiResponsesText(response, {
          text,
          messageId: `title_${ordinal}`,
          responseId: `resp_${ordinal}`,
        });
      }
      return;
    }
    if (recovering) {
      scenario.recoveryCalls++;
      scenario.recoveryInstructionSeen ||= input.includes("interrupted by a gateway restart");
      writeOpenAiResponsesText(response, {
        text: scenario.final,
        messageId: `final_${ordinal}`,
        responseId: `resp_${ordinal}`,
      });
    } else {
      scenario.initialCalls++;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      response.write(
        `data: ${JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "message",
            id: `held_${ordinal}`,
            role: "assistant",
            status: "in_progress",
            content: [],
          },
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          type: "response.output_text.delta",
          item_id: `held_${ordinal}`,
          output_index: 0,
          content_index: 0,
          delta: `HOLDING_${scenario.marker}`,
        })}\n\n`,
      );
      // The Gateway must die while it still owns this unfinished provider stream.
    }
  })().catch((error: unknown) => {
    providerError = toErrorObject(error, "Mock provider failed");
    response.destroy();
  });
});
provider.listen(port + 2, "127.0.0.1");
await once(provider, "listening");
const instance = await createOpenClawTestInstance({
  name: "startup-recovery-admission",
  cwd: checkout,
  entrypoint: [path.join(checkout, "dist/index.js")],
  port,
  startTimeoutMs: timeoutMs,
  env: { ...restartEnv, OPENCLAW_NO_RESPAWN: "1", OPENCLAW_GATEWAY_STARTUP_TRACE: "1" },
});
const clients: GatewayClient[] = [];
const earlyReadProbes: Array<{
  method: string;
  startedAt: number;
  startedAfterLaunchMs: number;
  completedAt?: number;
  elapsedMs?: number;
  success?: boolean;
  gatewayCode?: string;
  retryable?: boolean;
  error?: string;
}> = [];
let earlyReads: Promise<void> | undefined;
let mainIntegrityFinishedAt: number | undefined;
const report: Record<string, unknown> = {
  checkout,
  port,
  sessionCount,
  transcriptMiB: number(values["transcript-mib"]),
  agentCount: scenarios.length,
  clientCount: number(values.clients),
  pluginCount: number(values.plugins) + (values.workboard ? 1 : 0) + (values.resources ? 1 : 0),
  workboard: values.workboard ?? false,
  offlineWalMiBPerAgent: number(values["wal-mib"]),
  earlyReadProbes,
  minimalGateway: false,
  limitations: [
    "Empty synthetic startup plugins",
    "Streaming interruption, no tool side effects",
    "No steady-state load metrics",
    ...(values.resources
      ? ["Resource samples follow recovery; worker heaps may lag one heartbeat"]
      : []),
    "One request per early-read method, issued by the first reconnecting client",
    ...(values.workboard ? [] : ["Workboard is not loaded by the empty plugin fixture"]),
    "WAL pressure is produced by an offline cache writer after Gateway death",
    "Child spawn is observed by 5ms polling; launch-request timing includes fixture preparation",
  ],
};
async function probeEarlyReads(client: GatewayClient, launchedAt: number): Promise<void> {
  const { agentId, key, sessionId, marker } = scenarios[0]!;
  const probes: Array<{ method: string; params: Record<string, unknown> }> = [
    { method: "sessions.list", params: { agentId } },
    { method: "sessions.resolve", params: { agentId, key } },
    { method: "sessions.describe", params: { agentId, key } },
    { method: "board.get", params: { agentId, sessionKey: key } },
    { method: "sessions.messages.subscribe", params: { agentId, key } },
    { method: "models.list", params: { agentId, preparedOnly: true } },
    { method: "chat.metadata", params: { agentId, sessionKey: key } },
    { method: "chat.history", params: { sessionKey: key, limit: 10 } },
    ...(values.workboard ? [{ method: "workboard.cards.list", params: { sessionKey: key } }] : []),
  ];
  await Promise.all(
    probes.map(async ({ method, params }) => {
      const startedAt = Date.now();
      const result: (typeof earlyReadProbes)[number] = {
        method,
        startedAt,
        startedAfterLaunchMs: startedAt - launchedAt,
      };
      earlyReadProbes.push(result);
      try {
        const payload = await client.request(method, params, { timeoutMs });
        if (method === "sessions.list") {
          assert(
            Array.isArray(payload.sessions) &&
              payload.sessions.some((row) => asRecord(row).sessionId === sessionId),
            "Early list must contain the persisted session",
          );
        } else if (method === "sessions.describe") {
          assert.equal(
            asRecord(payload.session).sessionId,
            sessionId,
            "Early description must identify the persisted session",
          );
        } else if (method === "sessions.resolve") {
          assert.equal(payload.ok, true, "Early resolution must find the persisted session");
          assert.equal(payload.key, key, "Early resolution must return the requested key");
        } else if (method === "chat.history") {
          assert(
            Array.isArray(payload.messages) &&
              payload.messages.some((message) =>
                extractTextFromChatContent(asRecord(message).content)?.includes(marker),
              ),
            "Early history must contain the persisted input",
          );
        }
        result.success = true;
      } catch (error) {
        result.success = false;
        result.error = toErrorObject(error, "Early read failed").message;
        if (isGatewayProtocolResponseError(error)) {
          result.gatewayCode = error.gatewayCode;
          result.retryable = error.retryable;
        }
      } finally {
        result.completedAt = Date.now();
        result.elapsedMs = result.completedAt - startedAt;
      }
    }),
  );
}
const until = async (check: () => boolean | Promise<boolean>, label: string) => {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      if (await check()) {
        return;
      }
    } catch (error) {
      if (
        !isGatewayProtocolResponseError(error) ||
        error.gatewayCode !== "UNAVAILABLE" ||
        !error.retryable
      ) {
        throw toErrorObject(error, `Failed: ${label}`);
      }
    }
    if (providerError) {
      throw providerError;
    }
    assert(Date.now() < deadline, `Timed out: ${label}`);
    await delay(100);
  }
};
function startClient(index: number, startedAt: number) {
  const result = {
    index,
    admittedAt: 0,
    admissionMs: 0,
    rejectedConnects: 0,
    interruptedHandshakes: 0,
    transportCloses: 0,
    errors: [] as string[],
    grantedScopes: [] as string[],
  };
  const client = new GatewayClient({
    url: instance.url,
    token: instance.gatewayToken,
    env: instance.env,
    clientName: "gateway-client",
    mode: "backend",
    scopes: recovering ? ["operator.read"] : ["operator.admin", "operator.read", "operator.write"],
    deviceIdentity: loadOrCreateDeviceIdentity({
      path: instance.state.path("device", `client-${index}`, "client", "credentials.sqlite"),
    }),
    notifyOnStartupRetry: true,
    onHelloOk: (hello) => {
      if (!result.admittedAt) {
        result.grantedScopes = hello.auth.scopes;
        result.admittedAt = Date.now();
        result.admissionMs = result.admittedAt - startedAt;
        if (recovering && !earlyReads) {
          earlyReads = probeEarlyReads(client, startedAt);
        }
      }
    },
    onConnectError: (error) => {
      if (!result.admittedAt) {
        result.errors.push(error.message);
      }
    },
    onClose: (_code, _reason, info) => {
      if (!result.admittedAt) {
        if (isGatewayProtocolResponseError(info?.connectError)) {
          result.rejectedConnects++;
        } else if (info?.connectRequestSent) {
          result.interruptedHandshakes++;
        } else {
          result.transportCloses++;
        }
      }
    },
  });
  clients.push(client);
  client.start();
  return { client, result };
}
try {
  instance.state.applyEnv();
  const model = buildMockOpenAiResponsesProvider(`http://127.0.0.1:${port + 2}/v1`);
  const modelConfig = restartModelConfig(
    model,
    instance.state.workspaceDir,
    {
      maxConcurrent: scenarios.length + 1,
      timeoutSeconds: timeoutMs / 1000,
    },
    { catalogRefresh: { enabled: false } },
  );
  const plugins = writePluginFixtures(instance.state.root, { count: number(values.plugins) });
  await instance.state.writeConfig({
    ...modelConfig,
    agents: {
      ...modelConfig.agents,
      ownership: "explicit",
      defaults: {
        ...modelConfig.agents?.defaults,
        systemAgent: { agentId: scenarios[0]!.agentId },
      },
      entries: Object.fromEntries(scenarios.map(({ agentId }) => [agentId, {}])),
    },
    update: { checkOnStart: false },
    browser: { enabled: false },
    discovery: { mdns: { mode: "off" } },
    logging: { file: path.join(output, "server.log") },
    ...(values.resources ? { diagnostics: { enabled: true } } : {}),
    session: { maintenance: { maxEntries: sessionCount * 2 } },
    plugins: {
      enabled: true,
      allow: [
        ...plugins.pluginIds,
        ...(values.workboard ? ["workboard"] : []),
        ...(values.resources ? ["diagnostics-prometheus"] : []),
      ],
      entries: {
        ...(values.workboard ? { workboard: { enabled: true } } : {}),
        ...(values.resources ? { "diagnostics-prometheus": { enabled: true } } : {}),
      },
      load: { paths: [plugins.pluginsDir] },
      slots: { memory: "none" },
    },
    tools: {
      allow: ["exec"],
      exec: { mode: "full", host: "gateway" },
      codeMode: { enabled: false },
    },
    gateway: {
      mode: "local",
      bind: "loopback",
      port,
      auth: { mode: "token", token: instance.gatewayToken },
      controlUi: { enabled: false },
    },
  });
  const { seedTeamShapeSessions } = await import("./team-shape-sessions.ts");
  await seedTeamShapeSessions({
    stateDir: instance.stateDir,
    sessions: sessionCount,
    retainedRuns: Math.floor(sessionCount * 0.4),
    seed: "startup-recovery-admission",
    now: Date.UTC(2026, 9, 27),
    transcriptBytes: number(values["transcript-mib"]) * 1024 * 1024,
    teamStress: true,
  });
  await instance.startGateway();
  const initial = startClient(0, Date.now());
  await until(() => initial.result.admittedAt > 0, "initial connection");
  for (const scenario of scenarios) {
    const created = await initial.client.request<{ sessionId: string }>("sessions.create", {
      key: scenario.key,
      agentId: scenario.agentId,
      model: model.modelRef,
      permissionMode: "full",
    });
    scenario.sessionId = created.sessionId;
    await initial.client.request(
      "agent",
      {
        agentId: scenario.agentId,
        sessionKey: scenario.key,
        message: `${scenario.marker}: finish this assignment. ${"Synthetic retained context. ".repeat(4096)}`,
        idempotencyKey: scenario.marker,
        deliver: false,
        timeout: timeoutMs / 1000,
      },
      { expectFinal: false },
    );
  }
  await until(
    () => scenarios.every((entry) => entry.initialCalls === 1),
    "all held provider streams",
  );
  await initial.client.stopAndWait();
  await instance.crashGateway();
  for (const scenario of scenarios) {
    const writer = spawn(
      process.execPath,
      [
        "--import",
        fileURLToPath(new URL("../tsx.mjs", import.meta.url)),
        fileURLToPath(import.meta.url),
        "--prepare-wal-agent",
        scenario.agentId,
        "--output",
        output,
        "--wal-mib",
        values["wal-mib"]!,
      ],
      {
        cwd: checkout,
        env: createGatewayBenchEnv(instance.state.root, instance.configPath, {
          startupTrace: false,
          caseEnv: { OPENCLAW_STATE_DIR: instance.stateDir, TMPDIR: path.join(output, "tmp") },
        }),
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let stderr = "";
    assert(writer.stderr, "WAL writer must expose its configured stderr pipe");
    writer.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${String(chunk)}`.slice(-32768);
    });
    const closed = once(writer, "close");
    // Observe spawn errors immediately, including while waiting for the ready IPC.
    void closed.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        once(writer, "message").then(([message]: unknown[]) => {
          assert(
            typeof message === "object" &&
              message !== null &&
              "prepared" in message &&
              message.prepared === true &&
              "agentId" in message &&
              message.agentId === scenario.agentId,
            "Unexpected WAL writer message",
          );
        }),
        closed.then(() => {
          throw new Error(`WAL writer exited before preparation: ${stderr}`);
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`WAL writer timed out: ${stderr}`)), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (writer.exitCode === null && writer.signalCode === null) {
        writer.kill("SIGKILL");
      }
      await closed;
      await writeFile(path.join(output, `wal-writer-${scenario.agentId}.log`), stderr);
    }
  }
  const fileSizes = await Promise.all(
    scenarios.map(async ({ agentId }) => {
      const sizes = await Promise.all(
        ["openclaw-agent.sqlite", "openclaw-agent.sqlite-wal"].map((name) =>
          stat(path.join(instance.state.agentDir(agentId), name)).then(
            (entry) => entry.size,
            (error: unknown) => {
              if (hasErrnoCode(error, "ENOENT")) {
                return 0;
              }
              throw toErrorObject(error, "Cannot inspect fixture database files");
            },
          ),
        ),
      );
      return { agentId, databaseBytes: sizes[0]!, walBytes: sizes[1]! };
    }),
  );
  report.databaseBytesAfterCrash = Object.fromEntries(
    fileSizes.map(({ agentId, databaseBytes }) => [agentId, databaseBytes]),
  );
  report.walBytesAfterCrash = Object.fromEntries(
    fileSizes.map(({ agentId, walBytes }) => [agentId, walBytes]),
  );
  recovering = true;
  const logOffset = (await readFile(path.join(output, "server.log"), "utf8")).length;
  const requestedAt = Date.now();
  const startup = instance.startGateway();
  // Start retries before readiness, including the period before the listener exists.
  const reconnects = Array.from({ length: number(values.clients) }, (_, index) =>
    startClient(index, requestedAt),
  );
  const restart: Record<string, unknown> = {
    requestedAt,
    hostLoadAtStart: os.loadavg(),
    clients: reconnects.map(({ result }) => result),
  };
  report.restart = restart;
  let observedSpawnAt: number | null = null;
  const observeSpawn = setInterval(() => {
    if (instance.child?.pid && observedSpawnAt === null) {
      observedSpawnAt = Date.now();
    }
  }, 5);
  try {
    await startup;
    restart.readyMs = Date.now() - requestedAt;
    await until(
      () => reconnects.every(({ result }) => result.admittedAt > 0),
      "all reconnects admitted",
    );
    assert(
      reconnects.every(
        ({ result }) =>
          result.grantedScopes.includes("operator.read") &&
          !result.grantedScopes.includes("operator.admin"),
      ),
      "Reconnect proof requires non-admin read scopes",
    );
  } finally {
    clearInterval(observeSpawn);
    restart.observedSpawnAt = observedSpawnAt;
  }
  restart.clients = reconnects.map(({ result }) => ({
    ...result,
    admissionFromObservedSpawnMs:
      observedSpawnAt === null ? null : result.admittedAt - observedSpawnAt,
  }));
  assert(earlyReads, "First reconnect must start the early read probes");
  await earlyReads;
  const client = reconnects[0]!.client;
  for (const scenario of scenarios) {
    await until(async () => {
      const history = await client.request<{
        messages: Array<{ role: string; content?: unknown }>;
      }>("chat.history", { sessionKey: scenario.key });
      const finals = history.messages.filter(
        (message) =>
          message.role === "assistant" && extractAssistantPhaseText(message) === scenario.final,
      );
      if (!finals.length) {
        return false;
      }
      assert.equal(finals.length, 1, "exactly one durable final reply");
      assert.equal(
        history.messages.filter(
          (message) =>
            message.role === "user" &&
            extractTextFromChatContent(message.content)?.includes(scenario.marker),
        ).length,
        1,
        "original user input is not duplicated",
      );
      const listed = await client.request<{
        sessions: Array<{
          key: string;
          sessionId: string;
          status?: string;
          hasActiveRun?: boolean;
        }>;
      }>("sessions.list", { agentId: scenario.agentId });
      const row = listed.sessions.find((entry) => entry.key === scenario.key);
      if (row?.status !== "done" || row.hasActiveRun) {
        return false;
      }
      assert.equal(row.sessionId, scenario.sessionId);
      assert(
        scenario.recoveryInstructionSeen,
        "restart recovery must own the resumed provider turn",
      );
      scenario.verified = true;
      return true;
    }, `durable resumed reply for ${scenario.key}`);
  }
  const restartLogs = (await readFile(path.join(output, "server.log"), "utf8")).slice(logOffset);
  const restartRecords = restartLogs
    .split("\n")
    .slice(0, -1)
    .map((line) => asRecord(JSON.parse(line)));
  const restartMessages = restartRecords
    .map((record) => record.message)
    .filter((message): message is string => typeof message === "string");
  report.startupMeasurements = restartRecords.flatMap((record) =>
    typeof record.message === "string" &&
    [
      "agent database integrity gate",
      "slow OpenClaw agent database open",
      "agent database reads ready while writable inspection continues",
      "agent database recovered after background inspection and preparation",
      "agent database remains degraded",
    ].includes(record.message)
      ? [{ time: record.time, message: record.message, details: asRecord(record["1"]) }]
      : [],
  );
  const mainIntegrity = restartRecords.find(
    (record) =>
      record.message === "agent database integrity gate" &&
      asRecord(record["1"]).agentId === "main",
  );
  if (typeof mainIntegrity?.time === "string") {
    mainIntegrityFinishedAt = Date.parse(mainIntegrity.time);
  }
  const recoveryDurations = restartMessages.flatMap((message) => {
    const match = /startup (?:phase|trace): sidecars\.main-session-recovery (\d+(?:\.\d+)?)ms/.exec(
      message,
    );
    return match ? [Number(match[1])] : [];
  });
  assert.equal(recoveryDurations.length, 1, "one measured restart recovery phase");
  report.mainSessionRecoveryMs = recoveryDurations[0];
  report.backgroundAdmissionRecoveries = restartMessages.filter((message) =>
    message.includes("agent database recovered after background inspection and preparation"),
  ).length;
  if (values.resources) {
    const startedAt = Date.now();
    const samples: Array<Record<string, unknown>> = [];
    report.resources = { startedAt, samples, scope: "Live post-recovery samples; no forced GC" };
    let previousCount: number | null = null;
    let scrape = 0;
    while (samples.length < 3 && Date.now() - startedAt < 120_000) {
      await client.request(
        "sessions.list",
        { agentId: scenarios[0]!.agentId },
        { timeoutMs: 5000 },
      );
      if (values.workboard) {
        await client.request(
          "workboard.cards.list",
          { sessionKey: scenarios[0]!.key },
          { timeoutMs: 5000 },
        );
      }
      const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics/prometheus`, {
        headers: { Authorization: `Bearer ${instance.gatewayToken}` },
        signal: AbortSignal.timeout(5000),
      });
      assert(response.ok, `Resource scrape failed: HTTP ${response.status}`);
      const prometheus = await response.text();
      const capturedAt = Date.now();
      const file = `resources-${scrape++}.prom`;
      await writeFile(path.join(output, file), prometheus);
      const lines = prometheus.split("\n");
      const metric = (key: string): number | null => {
        const line = lines.find((entry) => entry.startsWith(`${key} `));
        const value = Number.parseFloat(line?.slice(key.length) ?? "");
        return Number.isFinite(value) ? value : null;
      };
      const count = metric("openclaw_memory_rss_bytes_count");
      if (
        count !== null &&
        previousCount !== null &&
        count > previousCount &&
        capturedAt - startedAt <= 120_000
      ) {
        const workers = metric("openclaw_worker_count");
        const sampled = metric("openclaw_worker_heap_sampled_count");
        const sqlite = '{script="sqlite-store.worker.js"}';
        const sqliteWorkers = metric(`openclaw_worker_count${sqlite}`);
        const sqliteSampled = metric(`openclaw_worker_heap_sampled_count${sqlite}`);
        samples.push({
          capturedAt,
          elapsedMs: capturedAt - startedAt,
          file,
          hostLoad: os.loadavg(),
          memorySampleCount: count,
          rssBytes: metric('openclaw_memory_bytes{kind="rss"}'),
          mainHeapUsedBytes: metric('openclaw_memory_bytes{kind="heap_used"}'),
          workerCount: workers,
          workerHeapSampledCount: sampled,
          workerHeapUsedBytes:
            workers !== null && workers === sampled
              ? metric('openclaw_memory_bytes{kind="worker_heap_used"}')
              : null,
          sqliteWorkerCount: sqliteWorkers,
          sqliteWorkerHeapSampledCount: sqliteSampled,
          sqliteWorkerHeapUsedBytes:
            sqliteWorkers !== null && sqliteWorkers === sqliteSampled
              ? metric(`openclaw_worker_heap_used_bytes${sqlite}`)
              : null,
        });
      }
      previousCount = count;
      if (samples.length < 3) {
        await delay(Math.min(5000, Math.max(0, 120_000 - (Date.now() - startedAt))));
      }
    }
    assert.equal(samples.length, 3, "Three fresh post-recovery memory samples within 120s");
  }
  restart.hostLoadAtFinish = os.loadavg();
  report.success = true;
} catch (error) {
  report.success = false;
  report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
}
await earlyReads;
report.mainIntegrityFinishedAt = mainIntegrityFinishedAt;
report.earlyReadsSuccess =
  earlyReadProbes.length > 0 &&
  earlyReadProbes.every(
    (probe) => probe.success && (probe.completedAt ?? Infinity) < (mainIntegrityFinishedAt ?? 0),
  );
report.sessions = scenarios;
await writeFile(path.join(output, "gateway.log"), instance.logs());
await writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
const stopped = await Promise.allSettled(clients.map((client) => client.stopAndWait()));
try {
  await instance.cleanup();
  const failures = stopped.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length) {
    throw new AggregateError(failures, "Client cleanup failed");
  }
} finally {
  provider.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    provider.close((error) => (error ? reject(error) : resolve()));
  });
  if (previousTmpdir === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = previousTmpdir;
  }
}
console.log(await readFile(path.join(output, "report.json"), "utf8"));
