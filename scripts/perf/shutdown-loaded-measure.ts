// Built Gateway with streaming chats, foreground exec, pending WS RPCs, cron, and restart readback.
// TMPDIR=<btrfs-temp> node --import ./scripts/tsx.mjs scripts/perf/shutdown-loaded-measure.ts \
//   --output <new-dir> --fixture <shutdown-fixture-root> --pressure-directory <btrfs-writer-dir>
// Use shutdown-loaded-fixture.mjs to prepare the synthetic shape; run each built revision serially.
// A process-only 90s stop watchdog is enforced; this does not emulate systemd or a production block device.
// CPU/allocation samples cover the Gateway main thread/heap, not its child processes.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { zstdDecompressSync } from "node:zlib";
import { buildMockOpenAiResponsesProvider } from "../../src/gateway/test-openai-responses-model.js";
import { registerSealedRuntimeProcessEntrypoints } from "../../src/infra/runtime-process-url.js";
import { createDeferredCore } from "../../src/shared/deferred.js";
import { reserveTestPortListener } from "../../src/test-utils/port-claims.js";
import {
  connectRestartClient,
  readRestartSession,
  restartEnv,
  restartModelConfig,
  restartProviderServer,
  restartToolNames,
  writeRestartPlugin,
  writeRestartJsonText,
  writeRestartToolCall,
} from "../../test/gateway-restart.test-support.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { prepareGatewayMatrixProcessOwner } from "../lib/code-mode-matrix-process-owner.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    checkout: { type: "string", default: process.cwd() },
    sessions: { type: "string", default: "16" },
    crons: { type: "string", default: "4" },
    tools: { type: "string", default: "2" },
    clients: { type: "string", default: "4" },
    "ignore-term": { type: "boolean" },
    "yield-tools": { type: "boolean" },
    "pressure-directory": { type: "string" },
    "hold-ms": { type: "string", default: "0" },
    fixture: { type: "string" },
    allocation: { type: "boolean" },
    "cpu-profile": { type: "boolean" },
    "seeded-history": { type: "boolean" },
  },
});
assert(values.output);
const count = parseStrictIntegerOption({
  raw: values.sessions,
  label: "--sessions",
  min: 1,
  fallback: 16,
});
const holdMs = parseStrictIntegerOption({
  raw: values["hold-ms"],
  label: "--hold-ms",
  min: 0,
  fallback: 0,
});
const cronCount = parseStrictIntegerOption({
  raw: values.crons,
  label: "--crons",
  min: 1,
  fallback: 4,
});
const toolCount = parseStrictIntegerOption({
  raw: values.tools,
  label: "--tools",
  min: 0,
  fallback: 2,
});
const clientCount = parseStrictIntegerOption({
  raw: values.clients,
  label: "--clients",
  min: 1,
  fallback: 4,
});
assert(
  count <= 256 &&
    cronCount <= 8 &&
    toolCount <= 16 &&
    clientCount <= 16 &&
    clientCount <= count + toolCount,
);
const turnCount = count + toolCount;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
const output = path.resolve(values.output);
await mkdir(output);
// Linux child custody requires a built owner without compiler-loader children.
registerSealedRuntimeProcessEntrypoints(
  "serviceChildRelay",
  await prepareGatewayMatrixProcessOwner(path.resolve(values.checkout), output),
);
const signal = AbortSignal.timeout(600_000);
const failure = createDeferredCore<never>();
void failure.promise.catch(() => {});
const ready = new Set<string>();
const resumed = new Set<string>();
let restarting = false;
let heldFinalizers = 0;
const issuedTools = new Set<string>();
const yieldedTools = new Set<string>();
const toolPids = new Set<number>();
const reservation = await reserveTestPortListener({
  offsets: [0],
  signal,
  createListener: () =>
    restartProviderServer(
      failure,
      async (request, response, body) => {
        if (request.url?.startsWith("/tool/")) {
          ready.add(request.url.slice("/tool/".length));
          assert(typeof body.pid === "number");
          toolPids.add(body.pid);
          response.writeHead(204).end();
          return;
        }
        if (request.url === "/finalize") {
          heldFinalizers++;
          await delay(holdMs, undefined, { signal });
          response.writeHead(204).end();
          return;
        }
        const text = JSON.stringify(body.input);
        const marker =
          restartToolNames(body).length > 0
            ? /SHUTDOWN_(CHAT_\d+|TOOL_\d+|CRON_\d+)/.exec(text)?.[1]
            : undefined;
        if (body.stream === false) {
          writeRestartJsonText(response, "Synthetic shutdown session", randomUUID());
        } else if (marker?.startsWith("TOOL_") && !restarting && !issuedTools.has(marker)) {
          assert(restartToolNames(body).includes("exec"), "Exec tool was not offered");
          issuedTools.add(marker);
          const callback = `http://127.0.0.1:${reservation.claim.port}/tool/${marker}`;
          const script = `${values["ignore-term"] ? "process.on('SIGTERM',()=>{});" : ""}fetch(${JSON.stringify(callback)},{method:'POST',body:JSON.stringify({pid:process.pid})}).then(()=>setInterval(()=>{},1000))`;
          writeRestartToolCall(
            response,
            marker,
            "exec",
            {
              command: `${shellQuote(process.execPath)} -e ${shellQuote(script)}`,
              yieldMs: values["yield-tools"] ? 10 : 120_000,
              timeoutSeconds: 600,
            },
            1,
          );
        } else if (marker && !restarting && restartToolNames(body).length > 0) {
          assert(
            values["yield-tools"] || !marker.startsWith("TOOL_"),
            "Exec returned before shutdown",
          );
          if (marker.startsWith("TOOL_")) {
            yieldedTools.add(marker);
          }
          const id = randomUUID();
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
          });
          for (const event of [
            {
              type: "response.created",
              response: { id: `resp_${id}`, status: "in_progress", output: [] },
            },
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { type: "message", id, role: "assistant", status: "in_progress", content: [] },
            },
            {
              type: "response.content_part.added",
              item_id: id,
              output_index: 0,
              content_index: 0,
              part: { type: "output_text", text: "", annotations: [] },
            },
            {
              type: "response.output_text.delta",
              item_id: id,
              output_index: 0,
              content_index: 0,
              delta: `Synthetic work in progress for ${marker}.`,
            },
          ]) {
            response.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          const stream = setInterval(
            () =>
              response.write(
                `data: ${JSON.stringify({
                  type: "response.output_text.delta",
                  item_id: id,
                  output_index: 0,
                  content_index: 0,
                  delta: " Still working.",
                })}\n\n`,
              ),
            250,
          );
          response.once("close", () => clearInterval(stream));
          ready.add(marker);
        } else {
          if (
            (marker?.startsWith("CHAT_") || marker?.startsWith("TOOL_")) &&
            text.includes("The Gateway restarted while you were working.")
          ) {
            resumed.add(marker);
          }
          writeOpenAiResponsesText(response, {
            text: `FINISHED_${marker ?? "utility"}`,
            messageId: randomUUID(),
            responseId: randomUUID(),
          });
        }
      },
      { ignoreAborted: true },
    ),
});
const model = buildMockOpenAiResponsesProvider(`http://127.0.0.1:${reservation.claim.port}/v1`);
const base = restartModelConfig(
  model,
  values.fixture ? path.join(values.fixture, "workspace") : undefined,
  {
    maxConcurrent: turnCount + cronCount + 2,
    timeoutSeconds: 180,
  },
);
const instance = await createOpenClawTestInstance({
  name: "loaded-shutdown",
  cwd: values.checkout,
  entrypoint: [
    ...(values["cpu-profile"] ? ["--cpu-prof", `--cpu-prof-dir=${output}`] : []),
    "--import",
    new URL("./gateway-shutdown-sweep-preload.mjs", import.meta.url).pathname,
    "dist/entry.js",
  ],
  state: { layout: "split" },
  signal,
  startTimeoutMs: 120_000,
  gracefulShutdownTimeoutMs: 90_000,
  env: {
    ...restartEnv,
    OPENCLAW_SKIP_CRON: undefined,
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_GATEWAY_RESTART_TRACE: "1",
    OPENCLAW_SHUTDOWN_MEASURE_OUTPUT: output,
    OPENCLAW_SHUTDOWN_MEASURE_ALLOCATIONS: values.allocation ? "1" : "0",
  },
  config: {
    ...base,
    update: { checkOnStart: false },
    browser: { enabled: false },
    discovery: { mdns: { mode: "off" } },
    cron: { enabled: true },
    tools: {
      allow: values["yield-tools"] ? ["cron", "exec", "process"] : ["cron", "exec"],
      codeMode: { enabled: false },
      exec: { host: "gateway", security: "full", ask: "off" },
    },
  },
});
let client: Awaited<ReturnType<typeof connectRestartClient>> | undefined;
const markers = [
  ...Array.from({ length: count }, (_, i) => `CHAT_${i}`),
  ...Array.from({ length: toolCount }, (_, i) => `TOOL_${i}`),
];
assert(!values["seeded-history"] || (values.fixture && turnCount <= 140));
const keys = markers.map((marker, index) =>
  values["seeded-history"]
    ? `agent:main:transcript-broadcast-measure-child-${index}`
    : `agent:main:dashboard:shutdown-${marker.toLowerCase()}`,
);
const clients: Array<Awaited<ReturnType<typeof connectRestartClient>>> = [];
const waits: Promise<void>[] = [];
const runIds: string[] = [];
let settledWaits = 0;
const result: Record<string, unknown> = {
  count,
  toolCount,
  clientCount,
  cronCount,
  holdMs,
  ignoreTerm: values["ignore-term"] === true,
  yieldTools: values["yield-tools"] === true,
  seededHistory: values["seeded-history"] === true,
  valid: false,
};
let pressure: ChildProcess | undefined;
let pressureExit: Promise<unknown> | undefined;
async function stopPressure() {
  if (pressure && pressure.exitCode === null && pressure.signalCode === null) {
    pressure.kill("SIGINT");
  }
  await pressureExit;
}
const wait = async (predicate: () => boolean, timeoutMs = 60_000) => {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    assert(
      Date.now() < end,
      `Fixture wait exceeded ${timeoutMs}ms; ready=${[...ready].join(",")}; childPids=${toolPids.size}; yielded=${yieldedTools.size}`,
    );
    await Promise.race([delay(50, undefined, { signal }), failure.promise]);
  }
};
function readDurableTranscripts() {
  const database = new DatabaseSync(path.join(instance.state.agentDir(), "openclaw-agent.sqlite"), {
    readOnly: true,
  });
  try {
    const readEvents = database.prepare(
      "SELECT event_json, event_zstd FROM transcript_events WHERE session_id = ? ORDER BY seq",
    );
    return keys.map((key) => {
      const session = readRestartSession(instance.state.agentDir(), key);
      assert(typeof session?.sessionId === "string");
      return readEvents.all(session.sessionId).map((row) => {
        if (typeof row.event_json === "string") {
          return row.event_json;
        }
        assert(row.event_zstd instanceof Uint8Array, "Transcript event has no payload");
        return zstdDecompressSync(row.event_zstd).toString("utf8");
      });
    });
  } finally {
    database.close();
  }
}
try {
  if (values.fixture) {
    await mkdir(instance.state.agentDir(), { recursive: true });
    const source = path.join(values.fixture, "agents", "main", "agent");
    if (process.platform === "darwin") {
      execFileSync("/bin/cp", ["-cR", `${source}/.`, instance.state.agentDir()]);
    } else {
      await cp(source, instance.state.agentDir(), {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
      });
    }
    // A copied database needs its own verification seal before modeling a warm Gateway.
    const { openOpenClawAgentDatabase, closeOpenClawAgentDatabasesAsync } =
      await import("../../src/state/openclaw-agent-db.js");
    const { closeOpenClawStateDatabaseAsync } =
      await import("../../src/state/openclaw-state-db.js");
    const { assertSqliteIntegrity } = await import("../../src/infra/sqlite-integrity.js");
    const fixtureDatabase = openOpenClawAgentDatabase({
      agentId: "main",
      env: instance.state.env,
    });
    assert(fixtureDatabase.db instanceof DatabaseSync, "This fixture requires SQLite");
    assertSqliteIntegrity(fixtureDatabase.db, "synthetic shutdown fixture", { check: "full" });
    await closeOpenClawAgentDatabasesAsync(instance.state.env.OPENCLAW_STATE_DIR);
    await closeOpenClawStateDatabaseAsync();
  }
  const pluginDir = instance.state.path("slow-cron-finalizer");
  await writeRestartPlugin(
    pluginDir,
    {
      id: "slow-cron-finalizer",
      activation: { onStartup: true },
      configSchema: { type: "object", properties: {} },
    },
    `export default { id: "slow-cron-finalizer", register(api) {
      api.on("agent_end", async (event, ctx) => {
        if (!event.success && ctx.sessionKey?.includes(":cron:"))
          await fetch("http://127.0.0.1:${reservation.claim.port}/finalize", { method: "POST", body: "{}" });
      });
    } };`,
  );
  const config = JSON.parse(await readFile(instance.configPath, "utf8"));
  config.plugins = {
    enabled: true,
    allow: ["openai", "slow-cron-finalizer"],
    slots: { memory: "none" },
    load: { paths: [pluginDir] },
    entries: { "slow-cron-finalizer": { enabled: true, hooks: { allowConversationAccess: true } } },
  };
  await instance.state.writeConfig(config);
  await instance.startGateway();
  console.log("gateway ready");
  client = await connectRestartClient(
    instance,
    { deviceAuthScope: instance.url, sharedStateMode: "read-only" },
    signal,
  );
  for (let index = 0; index < clientCount; index++) {
    clients.push(
      await connectRestartClient(
        instance,
        { deviceAuthScope: instance.url, sharedStateMode: "read-only" },
        signal,
      ),
    );
  }
  for (const [i, key] of keys.entries()) {
    if (!values["seeded-history"]) {
      await client.request("sessions.create", { key, agentId: "main" });
    }
    const run = await client.request<{ runId: string }>(
      "chat.send",
      { sessionKey: key, message: `SHUTDOWN_${markers[i]}`, idempotencyKey: randomUUID() },
      { expectFinal: false },
    );
    runIds.push(run.runId);
  }
  const jobs: Array<{ id: string }> = [];
  for (let index = 0; index < cronCount; index++) {
    jobs.push(
      await client.request<{ id: string }>("cron.add", {
        name: "Synthetic shutdown cron",
        agentId: "main",
        enabled: true,
        schedule: { kind: "at", at: new Date(Date.now() + 2000).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: `SHUTDOWN_CRON_${index}`, timeoutSeconds: 180 },
        delivery: { mode: "none" },
      }),
    );
  }
  await wait(
    () =>
      ready.size === turnCount + cronCount &&
      toolPids.size === toolCount &&
      (!values["yield-tools"] || yieldedTools.size === toolCount),
  );
  console.log(`loaded ${ready.size} model requests`);
  for (const [index, connection] of clients.entries()) {
    waits.push(
      connection
        .request("agent.wait", { runId: runIds[index], timeoutMs: 120_000 }, { timeoutMs: 180_000 })
        .then(
          () => {
            settledWaits++;
          },
          () => {
            settledWaits++;
          },
        ),
    );
  }
  await delay(1000, undefined, { signal });
  if (values["pressure-directory"]) {
    await mkdir(values["pressure-directory"], { recursive: true });
    pressure = spawn(
      "fio",
      [
        "--name=shutdown-pressure",
        `--directory=${values["pressure-directory"]}`,
        "--rw=randwrite",
        "--bs=4k",
        "--ioengine=psync",
        "--fsync=1",
        "--size=256m",
        "--numjobs=4",
        "--randseed=2279",
        "--time_based=1",
        "--runtime=180",
        "--group_reporting",
        "--output-format=json",
        `--output=${path.join(output, "pressure.json")}`,
      ],
      { stdio: "ignore" },
    );
    pressureExit = once(pressure, "exit");
    await once(pressure, "spawn");
    await delay(3000, undefined, { signal });
    assert(
      pressure.exitCode === null && pressure.signalCode === null,
      "Pressure writer exited before shutdown",
    );
  }
  result.pendingRpcs = waits.length - settledWaits;
  assert(result.pendingRpcs === clientCount, "RPC waits settled before shutdown");
  assert(toolPids.size === toolCount, "Foreground tools did not start");
  for (const pid of toolPids) {
    process.kill(pid, 0);
  }
  const child = instance.child;
  assert(child);
  const exited = once(child, "exit");
  const start = performance.now();
  assert(child.kill("SIGTERM"));
  const [code, exitSignal] = await exited;
  result.shutdownMs = performance.now() - start;
  result.exitCode = code;
  result.exitSignal = exitSignal;
  await stopPressure();
  result.survivingToolPids = [...toolPids].filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  assert((result.survivingToolPids as number[]).length === 0, "Exec child survived shutdown");
  await Promise.all(clients.map((connection) => connection.stopAndWait()));
  await Promise.all(waits);
  if (pressure) {
    // fio writes a signal notice before its JSON when we stop the bounded workload.
    const raw = await readFile(path.join(output, "pressure.json"), "utf8");
    const { jobs: writers }: { jobs: Array<{ error: number; sync: { total_ios: number } }> } =
      JSON.parse(raw.slice(raw.indexOf("{")));
    assert(
      writers.length > 0 && writers.every((job) => job.error === 0 && job.sync.total_ios > 0),
      "Sync writer failed or performed no fsyncs",
    );
    result.pressureFsyncs = writers.reduce((total, job) => total + job.sync.total_ios, 0);
  }
  result.heldFinalizers = heldFinalizers;
  await writeFile(
    path.join(output, "transcripts-after-stop.json"),
    JSON.stringify(readDurableTranscripts()),
  );
  result.markers = keys.filter(
    (key) => readRestartSession(instance.state.agentDir(), key)?.resumeAfterRestart,
  ).length;
  if (values.fixture) {
    const databasePath = path.join(instance.state.agentDir(), "openclaw-agent.sqlite");
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      result.storedSessionRows = database
        .prepare("SELECT count(*) AS count FROM session_nodes")
        .get()?.count;
      assert(
        Number(result.storedSessionRows) >= 5000,
        "Production-shaped session fixture was pruned",
      );
    } finally {
      database.close();
    }
    result.agentDatabaseBytes = (await stat(databasePath)).size;
  }
  const stopLog = instance.logs();
  result.shutdownSteps = Object.fromEntries(
    [...stopLog.matchAll(/restart trace: ((?:restart\.close|shutdown)\.[\w.-]+) ([\d.]+)ms/g)]
      .filter((match) => !match[1]!.endsWith(".begin"))
      .map((match) => [match[1], Number(match[2])]),
  );
  await writeFile(path.join(output, "stop.log"), stopLog);
  if (values.fixture) {
    result.cleanCloseReceipt = [
      ...stopLog.matchAll(/agent database clean-close receipt: ([\w-]+); agent=main\b/g),
    ].at(-1)?.[1];
    assert.equal(result.cleanCloseReceipt, "written", "Final agent database seal was not written");
  }
  console.log(JSON.stringify(result));
  await client.stopAndWait();
  client = undefined;
  restarting = true;
  await instance.startGateway();
  client = await connectRestartClient(
    instance,
    { deviceAuthScope: instance.url, sharedStateMode: "read-only" },
    signal,
  );
  await wait(() => resumed.size === turnCount);
  result.resumes = resumed.size;
  let histories = 0;
  const transcriptProof: Record<string, { partialStream: boolean; toolReceipt: boolean }> = {};
  result.transcriptProof = transcriptProof;
  for (const [index, key] of keys.entries()) {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const { messages }: { messages: unknown[] } = await client.request<{ messages: unknown[] }>(
        "chat.history",
        {
          sessionKey: key,
          limit: 100,
        },
      );
      const history: string = JSON.stringify(messages);
      assert(
        history.includes(`SHUTDOWN_${markers[index]}`),
        "Persisted user message missing after restart",
      );
      if (history.includes(`FINISHED_${markers[index]}`)) {
        await writeFile(
          path.join(output, `history-${markers[index]}.json`),
          JSON.stringify(messages),
        );
        const proof = {
          partialStream: history.includes(`Synthetic work in progress for ${markers[index]}.`),
          toolReceipt: messages.some((message) =>
            JSON.stringify(message).includes('"role":"toolResult"'),
          ),
        };
        transcriptProof[markers[index]!] = proof;
        histories++;
        break;
      }
      assert(Date.now() < deadline, "Recovered reply did not persist");
      await delay(100, undefined, { signal });
    }
  }
  result.persistedRecoveredHistories = histories;
  const recoveredTranscripts = readDurableTranscripts();
  await writeFile(
    path.join(output, "transcripts-after-recovery.json"),
    JSON.stringify(recoveredTranscripts),
  );
  const restartInputs = recoveredTranscripts.map(
    (events) =>
      events.filter((event) => event.includes("The Gateway restarted while you were working."))
        .length,
  );
  result.persistedRestartInputs = restartInputs;
  const cron = await Promise.all(
    jobs.map((job) =>
      client!.request<{ entries: unknown[] }>("cron.runs", { id: job.id, limit: 2 }),
    ),
  );
  assert(
    cron.every((run) => run.entries.length > 0),
    "Persisted cron outcome missing after restart",
  );
  result.cron = cron;
  assert(
    restartInputs.every((inputCount) => inputCount === 1),
    "Recovery input must persist exactly once",
  );
  for (const [index, events] of recoveredTranscripts.entries()) {
    const persisted = events.join("\n");
    if (markers[index]!.startsWith("CHAT_")) {
      assert(
        persisted.includes(`Synthetic work in progress for ${markers[index]}.`),
        "Partial streamed assistant text missing from durable transcript",
      );
    } else {
      assert(
        persisted.includes('"role":"toolResult"'),
        "Interrupted exec result missing from durable transcript",
      );
    }
  }
  result.valid =
    (holdMs === 0 || heldFinalizers === cronCount) &&
    result.markers === turnCount &&
    resumed.size === turnCount &&
    code === 0 &&
    exitSignal === null;
  assert(result.valid, "Shutdown or recovery acceptance failed");
} catch (error) {
  result.error = String(error);
  process.exitCode = 1;
} finally {
  await stopPressure();
  await writeFile(path.join(output, "gateway.log"), instance.logs());
  await writeFile(path.join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  await Promise.all(clients.map((connection) => connection.stopAndWait()));
  await client?.stopAndWait();
  await instance.cleanup();
  reservation.listener.closeAllConnections();
  await reservation.releaseListener();
  await reservation.claim.release();
}
