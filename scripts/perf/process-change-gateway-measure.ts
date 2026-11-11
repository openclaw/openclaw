/**
 * Focused built-Gateway process publication proof, not a ten-minute stress campaign.
 * Run base and candidate sequentially with fresh output directories:
 * node --import ./scripts/tsx.mjs scripts/perf/process-change-gateway-measure.ts
 *   --entry /built/revision/dist/entry.js --output "$PWD/.local/process-change-base"
 * Seeds 10,800 sessions / 40 configured plugins, connects 70 clients, and runs
 * 21 mock-provider agent turns that start real background execs through burst, quiet,
 * resume, and exit. --sessions 100 selects setup smoke; full evidence uses 10,800.
 * The output directory needs trusted ancestors for the runtime's temp workspace.
 * Use matching source/build artifacts; this seeds current state, not an upgrade.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { loadavg } from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Value } from "typebox/value";
import { SessionsProcessesListResultSchema } from "../../packages/gateway-protocol/src/schema/session-processes.ts";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { applyMockOpenAiModelConfig } from "../e2e/lib/fixtures/mock-openai-config.mjs";
import { readBody, writeJson, writeSse } from "../e2e/lib/mock-openai-http.mjs";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { getFreePort, requestProbeStatus } from "../lib/gateway-bench-probes.ts";
import {
  measureGatewayCpuUsage,
  readGatewayResources,
  startGatewayDiagnostics,
} from "../lib/gateway-bench-profile.ts";
import { buildGatewayBenchChildArgs } from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";
import {
  generateTeamShapeStressFixture,
  TEAM_STRESS_PLUGIN_IDS,
} from "./team-shape-stress-fixture.ts";

const { values } = parseArgs({
  options: {
    entry: { type: "string", default: "dist/entry.js" },
    output: { type: "string" },
    sessions: { type: "string", default: "10800" },
  },
});
assert(values.output, "--output must name a new synthetic directory");
const output = path.resolve(values.output);
const entry = realpathSync(values.entry);
let port = await getFreePort();
while (port < 40000) {
  port = await getFreePort();
}
let mockPort = await getFreePort();
while (mockPort < 40000 || mockPort === port) {
  mockPort = await getFreePort();
}
const { summary, env } = await generateTeamShapeStressFixture({
  stateDir: output,
  port,
  seed: 650,
  now: 1_793_448_000_000,
  transcriptMiB: 1,
  sessions: parseStrictIntegerOption({
    raw: values.sessions,
    label: "--sessions",
    min: 100,
    fallback: 10800,
  }),
});
const configPath = path.join(output, "openclaw.json");
const config: unknown = JSON.parse(readFileSync(configPath, "utf8"));
assert(isRecord(config));
Object.assign(config, {
  plugins: {
    enabled: true,
    allow: [...TEAM_STRESS_PLUGIN_IDS],
    entries: Object.fromEntries(TEAM_STRESS_PLUGIN_IDS.map((id) => [id, { enabled: true }])),
  },
  tools: { codeMode: false, exec: { host: "gateway", mode: "full", notifyOnExit: false } },
  memory: { search: { enabled: false } },
});
applyMockOpenAiModelConfig(config, { mockPort, modelRef: "openai/gpt-4.1" });
assert(isRecord(config.agents) && isRecord(config.agents.defaults));
Object.assign(config.agents.defaults, { maxConcurrent: 21, skipBootstrap: true });
Object.assign(env, { OPENAI_API_KEY: "synthetic-process-proof" });
writeFileSync(configPath, JSON.stringify(config));
const barrier = path.join(output, "start-writers");
const writer = path.join(output, "writer.cjs");
writeFileSync(
  writer,
  `const fs = require("node:fs");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
fs.writeFileSync(process.argv[3] + "/writer-" + process.pid + ".pid", String(process.pid));
const expiry = setTimeout(() => process.exit(2), 180000);
(async () => {
  while (!fs.existsSync(process.argv[2])) await delay(25);
  clearTimeout(expiry);
  const workExpiry = setTimeout(() => process.exit(2), 45000);
  for (const phase of ["first", "resumed"]) {
    for (let i = 0; i < 32; i++) { process.stdout.write(phase + ":" + i + "\\n"); await delay(10); }
    await delay(12000);
  }
  clearTimeout(workExpiry);
})().catch(error => { console.error(error); process.exit(1); });
`,
);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const command = [process.execPath, writer, barrier, output].map(quote).join(" ");
let providerRequests = 0;
let providerExecCalls = 0;
let failure: Error | undefined;
const mock = createServer((request, response) => {
  void (async () => {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      writeJson(response, 404, { error: "Synthetic Responses endpoint only" });
      return;
    }
    const body: unknown = JSON.parse(await readBody(request));
    assert(isRecord(body));
    providerRequests++;
    const input: unknown[] = Array.isArray(body.input) ? body.input : [];
    const tools: unknown[] = Array.isArray(body.tools) ? body.tools : [];
    const callExec =
      JSON.stringify(input).includes("PROCESS_PROOF") &&
      !input.some((item) => isRecord(item) && item.type === "function_call_output") &&
      tools.some((tool) => isRecord(tool) && tool.name === "exec");
    const id = `process_proof_${providerRequests}`;
    const item = callExec
      ? {
          type: "function_call",
          id: `fc_${id}`,
          call_id: id,
          name: "exec",
          arguments: JSON.stringify({
            command,
            background: true,
            timeoutSeconds: 240,
            workdir: path.join(output, "workspace"),
          }),
        }
      : {
          type: "message",
          id: `msg_${id}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Synthetic process started.", annotations: [] }],
        };
    if (callExec) {
      providerExecCalls++;
    }
    const result = {
      id: `resp_${id}`,
      status: "completed",
      output: [item],
      usage: { input_tokens: 11, output_tokens: 10, total_tokens: 21 },
    };
    if (body.stream === false) {
      writeJson(response, 200, result);
      return;
    }
    writeSse(response, [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: callExec
          ? { ...item, arguments: "" }
          : { ...item, status: "in_progress", content: [] },
      },
      callExec
        ? {
            type: "response.function_call_arguments.delta",
            item_id: item.id,
            output_index: 0,
            delta: item.arguments,
          }
        : {
            type: "response.output_text.delta",
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            delta: "Synthetic process started.",
          },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: result },
    ]);
  })().catch((error: unknown) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    response.destroy(failure);
  });
});
await new Promise<void>((resolve, reject) => {
  mock.once("error", reject);
  mock.listen(mockPort, "127.0.0.1", resolve);
});
const log = createWriteStream(path.join(output, "gateway-child.log"));
const gateway = spawn(
  process.execPath,
  buildGatewayBenchChildArgs(entry, port, [
    "--import",
    new URL("./team-shape-stress-loader.mjs", import.meta.url).href,
    "--import",
    new URL("../lib/gateway-bench-profile-preload.ts", import.meta.url).href,
  ]),
  { env, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] },
);
gateway.stdout?.pipe(log, { end: false });
gateway.stderr?.pipe(log, { end: false });
gateway.once("close", () => log.end());
writeFileSync(path.join(output, "gateway.pid"), String(gateway.pid));
type Client = ReturnType<typeof createGatewayWsClient>;
const clients: Client[] = [];
const receipts = Array.from({ length: 70 }, (): string[] => []);
const keys = Array.from({ length: 21 }, (_, index) => `agent:main:process-proof-${index}`);
gateway.once("error", (error) => {
  failure = error;
});
let closing = false;
let cleanupPromise: Promise<void> | undefined;
function cleanup() {
  return (cleanupPromise ??= (async () => {
    closing = true;
    for (const client of clients) {
      client.close();
    }
    await stopChild(gateway, { teardownGraceMs: 15_000, killGraceMs: 2_000 });
    await finished(log);
    mock.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      mock.close((error) => (error ? reject(error) : resolve()));
    });
  })());
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(1));
  });
}
async function rpc(client: Client, method: string, params: unknown) {
  const response = await client.request(method, params, 60_000);
  assert(response.ok, `${method}: ${JSON.stringify(response.error)}`);
  return response.payload;
}
try {
  const deadline = Date.now() + 180_000;
  while ((await requestProbeStatus(port, "/readyz")).status !== 200) {
    if (failure) {
      throw failure;
    }
    assert(
      gateway.exitCode === null && gateway.signalCode === null && Date.now() < deadline,
      "Owned Gateway failed readiness; inspect gateway-child.log",
    );
    await delay(250);
  }
  for (const received of receipts) {
    const client = createGatewayWsClient({
      url: `ws://127.0.0.1:${port}`,
      onEvent(event) {
        if (
          event.event === "sessions.processes.changed" &&
          isRecord(event.payload) &&
          typeof event.payload.sessionKey === "string" &&
          keys.includes(event.payload.sessionKey)
        ) {
          received.push(event.payload.sessionKey);
        }
      },
    });
    clients.push(client);
    client.ws.on("error", (error) => {
      failure ??= error;
    });
    client.ws.on("close", () => {
      if (!closing) {
        failure ??= new Error("Client closed early");
      }
    });
    await client.waitOpen();
    await rpc(client, "connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        displayName: "Synthetic process proof",
        version: "1",
        platform: process.platform,
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.admin", "operator.read"],
      caps: [],
    });
    await rpc(client, "sessions.subscribe", {});
  }
  const controller = clients[0]!;
  for (const key of keys) {
    await rpc(controller, "sessions.create", { key, agentId: "main" });
  }
  const admissionStartedAt = Date.now();
  const runIds = await Promise.all(
    keys.map(async (sessionKey) => {
      const runId = randomUUID();
      await rpc(controller, "chat.send", {
        sessionKey,
        message: "PROCESS_PROOF: start the synthetic writer.",
        deliver: false,
        idempotencyKey: runId,
      });
      return runId;
    }),
  );
  await Promise.all(
    runIds.map(async (runId) => {
      const result = await rpc(controller, "agent.wait", { runId, timeoutMs: 55_000 });
      assert(isRecord(result) && result.status === "ok", JSON.stringify(result));
    }),
  );
  assert.equal(providerExecCalls, keys.length, "Every mock turn must start exactly one exec");
  const publicationDeadline = Date.now() + 30_000;
  while (!receipts.every((received) => keys.every((key) => received.includes(key)))) {
    if (failure) {
      throw failure;
    }
    assert(
      Date.now() < publicationDeadline,
      "Initial process publications did not reach every client",
    );
    await delay(25);
  }
  const admissionMs = Date.now() - admissionStartedAt;
  const initialDeliveries = receipts.map((received) => received.length);
  for (const received of receipts) {
    received.length = 0;
  }
  const before = await readGatewayResources(gateway);
  const stopDiagnostics = await startGatewayDiagnostics(gateway);
  const hostLoadBefore = loadavg();
  const startedAt = Date.now();
  writeFileSync(barrier, "start");
  const snapshots = [];
  const expectedOutput = (phases: string[]) =>
    phases.flatMap((phase) => Array.from({ length: 32 }, (_, i) => `${phase}:${i}\n`)).join("");
  for (const atMs of [7_000, 11_000, 19_000, 31_000]) {
    await delay(Math.max(0, startedAt + atMs - Date.now()));
    const states = await Promise.all(
      keys.map(async (key) => {
        const result = await rpc(controller, "sessions.processes.list", { key, agentId: "main" });
        assert(Value.Check(SessionsProcessesListResultSchema, result));
        assert.equal(result.processes.length, 1);
        const process = result.processes[0]!;
        assert.equal(
          process.tail,
          expectedOutput(atMs < 12_000 ? ["first"] : ["first", "resumed"]),
        );
        assert.equal(process.status, atMs === 31_000 ? "completed" : "running");
        if (atMs === 31_000) {
          assert.equal(process.exitCode, 0);
        }
        return { key, process };
      }),
    );
    const expectedNotifications = atMs < 12_000 ? 1 : atMs === 19_000 ? 2 : 3;
    for (const received of receipts) {
      for (const key of keys) {
        assert.equal(
          received.filter((sessionKey) => sessionKey === key).length,
          expectedNotifications,
          `Missing or duplicate process publication for ${key} at ${atMs} ms`,
        );
      }
    }
    snapshots.push({
      atMs: Date.now() - startedAt,
      deliveries: receipts.map((r) => r.length),
      states,
    });
  }
  const after = await readGatewayResources(gateway);
  const diagnostics = await stopDiagnostics();
  if (failure) {
    throw failure;
  }
  const sourceReceipts = receipts[0]!;
  for (const received of receipts) {
    assert.deepEqual(received, sourceReceipts);
  }
  const durationMs = Date.now() - startedAt;
  const result = {
    entry,
    entrySha256: createHash("sha256").update(readFileSync(entry)).digest("hex"),
    summary,
    configuredPlugins: TEAM_STRESS_PLUGIN_IDS,
    clients: clients.length,
    execSessions: keys.length,
    providerRequests,
    providerExecCalls,
    admissionMs,
    initialDeliveries,
    nominalWindowMs: 31_000,
    scope:
      "Focused mock-provider turns and real exec flow; no sidebar/search churn. Not broad stress proof.",
    durationMs,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    sourceNotificationsObserved: sourceReceipts.length,
    sourceNotificationsPerMinute: (sourceReceipts.length * 60_000) / durationMs,
    deliveredFrames: receipts.reduce((sum, received) => sum + received.length, 0),
    cpu: measureGatewayCpuUsage(before, after),
    memoryBefore: before.memory,
    memoryAfter: after.memory,
    diagnostics,
    snapshots,
    receipts,
  };
  writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, snapshots: undefined, receipts: undefined }));
} finally {
  await cleanup();
}
