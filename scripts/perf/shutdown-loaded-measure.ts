// Built Gateway with streaming chats, scheduled cron, native fio pressure, and persisted restart readback.
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
    "pressure-directory": { type: "string" },
    "hold-ms": { type: "string", default: "0" },
    fixture: { type: "string" },
    allocation: { type: "boolean" },
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
assert(count <= 256 && cronCount <= 8);
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
const reservation = await reserveTestPortListener({
  offsets: [0],
  signal,
  createListener: () =>
    restartProviderServer(
      failure,
      async (request, response, body) => {
        if (request.url === "/finalize") {
          heldFinalizers++;
          await delay(holdMs, undefined, { signal });
          response.writeHead(204).end();
          return;
        }
        const text = JSON.stringify(body.input);
        const marker = /SHUTDOWN_(CHAT_\d+|CRON_\d+)/.exec(text)?.[1];
        if (body.stream === false) {
          writeRestartJsonText(response, "Synthetic shutdown session", randomUUID());
        } else if (marker && !restarting && restartToolNames(body).length > 0) {
          const id = randomUUID();
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
          });
          for (const event of [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { type: "message", id, role: "assistant", status: "in_progress", content: [] },
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
          ready.add(marker);
        } else {
          if (
            marker?.startsWith("CHAT_") &&
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
    maxConcurrent: count + cronCount + 2,
    timeoutSeconds: 180,
  },
);
const instance = await createOpenClawTestInstance({
  name: "loaded-shutdown",
  cwd: values.checkout,
  entrypoint: [
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
    tools: { allow: ["cron"], codeMode: { enabled: false } },
  },
});
let client: Awaited<ReturnType<typeof connectRestartClient>> | undefined;
const keys = Array.from({ length: count }, (_, i) => `agent:main:dashboard:shutdown-${i}`);
const result: Record<string, unknown> = { count, cronCount, holdMs, valid: false };
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
    assert(Date.now() < end, `Fixture wait exceeded ${timeoutMs}ms; ready=${[...ready].join(",")}`);
    await Promise.race([delay(50, undefined, { signal }), failure.promise]);
  }
};
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
  for (const [i, key] of keys.entries()) {
    await client.request("sessions.create", { key, agentId: "main" });
    await client.request(
      "chat.send",
      { sessionKey: key, message: `SHUTDOWN_CHAT_${i}`, idempotencyKey: randomUUID() },
      { expectFinal: false },
    );
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
  await wait(() => ready.size === count + cronCount);
  console.log(`loaded ${ready.size} model requests`);
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
  await writeFile(path.join(output, "stop.log"), instance.logs());
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
  await wait(() => resumed.size === count);
  result.resumes = resumed.size;
  let histories = 0;
  for (const [index, key] of keys.entries()) {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const history: string = JSON.stringify(
        await client.request<unknown>("chat.history", { sessionKey: key, limit: 10 }),
      );
      assert(
        history.includes(`SHUTDOWN_CHAT_${index}`),
        "Persisted user message missing after restart",
      );
      if (history.includes(`FINISHED_CHAT_${index}`)) {
        histories++;
        break;
      }
      assert(Date.now() < deadline, "Recovered reply did not persist");
      await delay(100, undefined, { signal });
    }
  }
  result.persistedRecoveredHistories = histories;
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
  result.valid =
    (holdMs === 0 || heldFinalizers === cronCount) &&
    result.markers === count &&
    resumed.size === count &&
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
  await client?.stopAndWait();
  await instance.cleanup();
  reservation.listener.closeAllConnections();
  await reservation.releaseListener();
  await reservation.claim.release();
}
