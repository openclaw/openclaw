// Native Node entrypoint. Requires a completed build; never reads operator state or credentials.
// Example: node scripts/bench-plugin-capture.ts --output /srv/scratch/capture-small \
//   --plugins 1 --files 20 --bytes 1024 --samples 1
// Compare >=5 baseline/candidate runs serially, interleaved, with identical options.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "../gateway-shutdown-budget.mjs";
import { PROTOCOL_VERSION } from "../packages/gateway-protocol/src/version.ts";
import { hasErrnoCode } from "../src/infra/errno.ts";
import { applyMockOpenAiModelConfig } from "./e2e/lib/fixtures/mock-openai-config.mjs";
import { stopChild } from "./lib/gateway-bench-child.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  gatewayBenchCpuProfileArgs,
  summarizeNumbers,
} from "./lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "./lib/gateway-ws-client.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    entry: { type: "string", default: "openclaw.mjs" },
    revision: { type: "string" },
    port: { type: "string", default: "41981" },
    "mock-port": { type: "string", default: "41982" },
    plugins: { type: "string", default: "3" },
    files: { type: "string", default: "4000" },
    bytes: { type: "string", default: "4096" },
    samples: { type: "string", default: "5" },
    "interval-ms": { type: "string", default: "100" },
    "timeout-ms": { type: "string", default: "15000" },
    "settle-ms": { type: "string", default: "500" },
    "skip-turns": { type: "boolean", default: false },
    "cpu-profile": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "node scripts/bench-plugin-capture.ts --output /srv/scratch/<run> [--entry openclaw.mjs] [--revision <built-revision>] [--plugins 3 --files 4000 --bytes 4096 --samples 5] [--port 41981 --mock-port 41982] [--interval-ms 100 --timeout-ms 15000 --settle-ms 500] [--skip-turns] [--cpu-profile]",
  );
  process.exit(0);
}
function integer(raw: string, name: string, minimum = 1) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}
const port = integer(values.port, "--port", 40000);
const mockPort = integer(values["mock-port"], "--mock-port", 40000);
if (port === mockPort || Math.max(port, mockPort) > 65535) {
  throw new Error("Gateway and mock ports must differ and be <=65535");
}
const pluginCount = integer(values.plugins, "--plugins");
const fileCount = integer(values.files, "--files");
const fileBytes = integer(values.bytes, "--bytes");
const samples = integer(values.samples, "--samples");
const intervalMs = integer(values["interval-ms"], "--interval-ms");
const timeoutMs = integer(values["timeout-ms"], "--timeout-ms");
const settleMs = integer(values["settle-ms"], "--settle-ms", 0);
const output = path.resolve(
  values.output ??
    `/srv/scratch/${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-plugin-capture`,
);
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(output, "run-"));
const state = path.join(root, "state");
const configPath = path.join(root, "openclaw.json");
const pluginsDir = path.join(root, "plugins");
await Promise.all(
  [
    state,
    pluginsDir,
    path.join(root, "home"),
    path.join(root, "tmp"),
    path.join(root, "workspace"),
  ].map((dir) => mkdir(dir, { recursive: true })),
);
const pluginIds = Array.from({ length: pluginCount }, (_, index) => `capture-bench-${index}`);
const token = "synthetic-plugin-capture-token";
const env = createGatewayBenchEnv(path.join(root, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_STATE_DIR: state,
    TMPDIR: path.join(root, "tmp"),
    OPENAI_API_KEY: "synthetic-fixture",
    OPENCLAW_GATEWAY_TOKEN: token,
  },
});
const children: ChildProcess[] = [];
const clients: ReturnType<typeof createGatewayWsClient>[] = [];
const logStreams: ReturnType<typeof createWriteStream>[] = [];
const probes: Array<{
  phase: string;
  kind: string;
  startedAt: number;
  ms: number;
  ok: boolean;
  error?: string;
}> = [];
const phases: Array<Record<string, unknown>> = [];
let activePhase = "setup";
let timer: ReturnType<typeof setInterval> | undefined;
const pending = new Set<Promise<void>>();
const buildRevision =
  values.revision ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const report = {
  revision: buildRevision,
  entry: path.resolve(values.entry),
  root,
  runtime: process.version,
  startedAt: new Date().toISOString(),
  hostLoad: loadavg(),
  workload: {
    pluginCount,
    filesPerPlugin: fileCount,
    bytesPerFile: fileBytes,
    samples,
    intervalMs,
    timeoutMs,
    cpuProfile: values["cpu-profile"],
  },
  backend:
    "repository deterministic mock OpenAI server; actual Gateway chat.send + agent.wait and instance-background agent_end completion, no real inference",
  acceptance:
    "All health probes succeed within timeoutMs (default 15000); replacement foreground maximum must materially improve; replacement revisions and SQLite queries must succeed. Config and first-turn stalls are reported separately.",
  phases,
  probes,
};

async function writeEntry(id: string, revision: number) {
  // A module-scope resource catches reuse of a disposed CommonJS export during recovery.
  await writeFile(
    path.join(pluginsDir, id, "index.cjs"),
    `
const { DatabaseSync } = require('node:sqlite');
const dependency = require('synthetic-payload');
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE marker (value INTEGER); INSERT INTO marker VALUES (${revision})');
const key = Symbol.for('openclaw.capture-bench.${id}');
const counts = globalThis[key] ??= { evaluations: 0, disposals: 0, hookStarted: 0, hookFinished: 0, hookErrors: [], maxHeartbeatMs: 0 };
counts.evaluations++;
let previous = performance.now(), maxHeartbeatMs = 0;
const heartbeat = setInterval(() => {
  const now = performance.now(); maxHeartbeatMs = Math.max(maxHeartbeatMs, now - previous);
  previous = now;
}, 10);
heartbeat.unref();
module.exports = { id: '${id}', register(api) {
  api.lifecycle.onDispose(() => { counts.maxHeartbeatMs = Math.max(counts.maxHeartbeatMs, maxHeartbeatMs, performance.now() - previous); clearInterval(heartbeat); db.close(); counts.disposals++; });
  ${
    id === pluginIds[0]
      ? `api.on('agent_end', async () => {
    counts.hookStarted++;
    try {
      // Post-turn completion needs the instance-owned background caller.
      const completion = await api.lifecycle.runInBackgroundContext(() => api.runtime.llm.complete({
        messages: [{ role: 'user', content: 'Reply CAPTURE_BENCH_OK only.' }],
        purpose: 'plugin-capture-benchmark-agent-end', signal: AbortSignal.timeout(120000) }));
      if (!completion.text.includes('CAPTURE_BENCH_OK')) throw new Error('Wrong synthetic completion text');
      counts.hookFinished++;
    } catch (error) { counts.hookErrors.push(String(error) + (error?.cause ? '; cause=' + String(error.cause) : '')); }
  });`
      : ""
  }
  api.registerGatewayMethod('${id}.probe', ({respond}) => {
    const gap = performance.now() - previous;
    const result = { revision: ${revision}, marker: api.pluginConfig.marker,
      dependency, sqlite: db.prepare('SELECT value FROM marker').get().value,
      evaluations: counts.evaluations, disposals: counts.disposals,
      hookStarted: counts.hookStarted, hookFinished: counts.hookFinished, hookErrors: counts.hookErrors,
      maxHeartbeatMs: Math.max(counts.maxHeartbeatMs, maxHeartbeatMs, gap), source: __filename };
    maxHeartbeatMs = 0; counts.maxHeartbeatMs = 0; respond(true, result);
  });
} };
`,
  );
}
async function seed() {
  const payload = Buffer.alloc(fileBytes, 120);
  for (const id of pluginIds) {
    const dir = path.join(pluginsDir, id);
    await mkdir(path.join(dir, "node_modules", "synthetic-payload"), { recursive: true });
    await mkdir(path.join(dir, "payload"));
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: id,
        version: "1.0.0",
        main: "index.cjs",
        dependencies: { "synthetic-payload": "1.0.0" },
        openclaw: { extensions: ["./index.cjs"] },
      }),
    );
    await writeFile(
      path.join(dir, "openclaw.plugin.json"),
      JSON.stringify({
        id,
        activation: { onStartup: true },
        configSchema: {
          type: "object",
          properties: { marker: { type: "integer" } },
          additionalProperties: false,
        },
      }),
    );
    await writeFile(
      path.join(dir, "node_modules", "synthetic-payload", "package.json"),
      JSON.stringify({ name: "synthetic-payload", version: "1.0.0", main: "index.cjs" }),
    );
    await writeFile(
      path.join(dir, "node_modules", "synthetic-payload", "index.cjs"),
      "module.exports = 'synthetic dependency';\n",
    );
    await writeEntry(id, 1);
    // Half the bytes live in node_modules so recovery must traverse dependencies too.
    for (let start = 0; start < fileCount; start += 100) {
      await Promise.all(
        Array.from({ length: Math.min(100, fileCount - start) }, (_, offset) => {
          const index = start + offset;
          return writeFile(
            path.join(
              dir,
              index % 2 ? "payload" : "node_modules/synthetic-payload",
              `${index}.txt`,
            ),
            payload,
          );
        }),
      );
    }
  }
  const cfg = {
    ...BASE_GATEWAY_BENCH_CONFIG,
    gateway: {
      ...BASE_GATEWAY_BENCH_CONFIG.gateway,
      auth: { mode: "token", token },
    },
    agents: {
      defaults: {
        workspace: path.join(root, "workspace"),
        skipBootstrap: true,
        modelPolicy: {},
      },
      entries: { main: { workspace: path.join(root, "workspace") } },
    },
    plugins: {
      enabled: true,
      allow: [...pluginIds, "openai"],
      slots: { memory: "none" },
      load: { paths: [pluginsDir] },
      entries: Object.fromEntries(
        pluginIds.map((id) => [
          id,
          {
            enabled: true,
            hooks: { allowConversationAccess: id === pluginIds[0] },
            config: { marker: 0 },
          },
        ]),
      ),
    },
    memory: { search: { enabled: false } },
  };
  applyMockOpenAiModelConfig(cfg, { mockPort, modelRef: "openai/gpt-4.1" });
  await writeFile(configPath, JSON.stringify(cfg, null, 2));
}
function launch(name: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const log = createWriteStream(path.join(root, `${name}.log`));
  logStreams.push(log);
  const child = spawn(process.execPath, args, {
    env: { ...env, ...extraEnv },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  children.push(child);
  return child;
}
async function ready(endpoint: string, child: ChildProcess) {
  const until = Date.now() + 120000;
  while (Date.now() < until) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Child exited before ready; inspect ${root}/*.log`);
    }
    if (
      await fetch(endpoint, { signal: AbortSignal.timeout(1000) }).then(
        (res) => res.ok,
        () => false,
      )
    ) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Readiness timeout; inspect ${root}/*.log`);
}
async function connect() {
  const client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
  clients.push(client);
  await client.waitOpen();
  await rpc(client, "connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: { id: "gateway-client", version: "1.0.0", platform: process.platform, mode: "backend" },
    role: "operator",
    scopes: ["operator.admin", "operator.read", "operator.write"],
    auth: { token },
    caps: [],
  });
  return client;
}
async function rpc(
  client: ReturnType<typeof createGatewayWsClient>,
  method: string,
  params: unknown,
): Promise<unknown> {
  const res = await client.request(method, params, 180000);
  if (!res.ok) {
    throw new Error(`${method}: ${JSON.stringify(res.error)}`);
  }
  return res.payload;
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected response object");
  }
  return value as Record<string, unknown>;
}
async function probe(kind: string, run: () => Promise<unknown>) {
  const measuredPhase = activePhase;
  const start = performance.now();
  try {
    await run();
    probes.push({
      phase: measuredPhase,
      kind,
      startedAt: performance.timeOrigin + start,
      ms: performance.now() - start,
      ok: true,
    });
  } catch (error) {
    probes.push({
      phase: measuredPhase,
      kind,
      startedAt: performance.timeOrigin + start,
      ms: performance.now() - start,
      ok: false,
      error: String(error),
    });
  }
}
function enqueueProbe(kind: string, run: () => Promise<unknown>) {
  const work = probe(kind, run);
  pending.add(work);
  void work.finally(() => pending.delete(work));
}
async function captureCensus() {
  let directories = 0,
    files = 0,
    bytes = 0;
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
      if (hasErrnoCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    });
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        directories++;
        await walk(target);
      } else if (entry.isFile()) {
        const info = await stat(target).catch((error: unknown) => {
          if (hasErrnoCode(error, "ENOENT")) {
            return undefined;
          }
          throw error;
        });
        if (info) {
          files++;
          bytes += info.size;
        }
      }
    }
  }
  await walk(path.join(state, "tmp", "plugin-captures"));
  return { directories, files, bytes };
}
async function phase(name: string, run: () => Promise<unknown>) {
  activePhase = name;
  const startedAt = Date.now(),
    start = performance.now();
  const result = await run();
  const elapsedMs = performance.now() - start;
  await delay(settleMs);
  await Promise.all(pending);
  const measured = probes.filter((item) => item.phase === name);
  const stats = Object.fromEntries(
    ["http", "ws"].map((kind) => {
      const rows = measured.filter((item) => item.kind === kind);
      return [
        kind,
        {
          ...summarizeNumbers(rows.map((item) => item.ms)),
          count: rows.length,
          misses: rows.filter((item) => !item.ok).length,
          timeouts: rows.filter((item) => item.error && /timeout/iu.test(item.error)).length,
        },
      ];
    }),
  );
  activePhase = "between-phases";
  const summary = {
    name,
    startedAt,
    elapsedMs,
    probes: stats,
    result,
    captures: await captureCensus(),
  };
  phases.push(summary);
  console.log(JSON.stringify({ name, elapsedMs, probes: stats, captures: summary.captures }));
  await writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2));
}
try {
  await seed();
  const mock = launch("model", ["scripts/e2e/mock-openai-server.mjs"], {
    MOCK_PORT: String(mockPort),
    SUCCESS_MARKER: "CAPTURE_BENCH_OK",
  });
  await ready(`http://127.0.0.1:${mockPort}/health`, mock);
  const gateway = launch(
    "gateway",
    buildGatewayBenchChildArgs(
      path.resolve(values.entry),
      port,
      values["cpu-profile"] ? gatewayBenchCpuProfileArgs(path.join(root, "profiles")) : [],
      "token",
    ),
  );
  await ready(`http://127.0.0.1:${port}/readyz`, gateway);
  // Startup metadata maintenance also owns the plugin mutation lease. Observe its
  // completion before measuring replacement, rather than racing an unrelated owner.
  const maintenanceDeadline = Date.now() + 120000;
  while (
    !/startup (?:phase|trace): post-ready\.startup-maintenance [0-9.]+ms/u.test(
      await readFile(path.join(root, "gateway.log"), "utf8"),
    )
  ) {
    if (gateway.exitCode !== null || Date.now() > maintenanceDeadline) {
      throw new Error("Startup maintenance did not settle; inspect gateway.log");
    }
    await delay(100);
  }
  const driver = await connect();
  const observer = await connect();
  const samplePluginState = async (
    pluginRevision: number,
    marker: number,
  ): Promise<Array<Record<string, unknown>>> =>
    Promise.all(
      pluginIds.map(async (id) => {
        const result = record(await rpc(driver, `${id}.probe`, {}));
        if (
          result.revision !== pluginRevision ||
          result.sqlite !== pluginRevision ||
          result.marker !== marker
        ) {
          throw new Error(`Wrong live owner for ${id}: ${JSON.stringify(result)}`);
        }
        return { id, ...result };
      }),
    );
  await samplePluginState(1, 0);
  // Probes run in this process, independently of the Gateway event loop and mutation RPC.
  // Fixed cadence admits overlapping probes, so one blocked response cannot hide later misses.
  timer = setInterval(() => {
    enqueueProbe("http", async () => {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      await response.arrayBuffer();
    });
    enqueueProbe("ws", async () => {
      const result = await observer.request("health", {}, timeoutMs);
      if (!result.ok) {
        throw new Error(JSON.stringify(result.error));
      }
    });
  }, intervalMs);
  const turn = async (name: string) => {
    const before = record(await rpc(driver, `${pluginIds[0]}.probe`, {}));
    const sessionKey = `agent:main:capture-${name}`;
    await rpc(driver, "sessions.create", {
      key: sessionKey,
      visibility: "shared",
      model: "openai/gpt-4.1",
    });
    const sent = record(
      await rpc(driver, "chat.send", {
        sessionKey,
        message: "Reply CAPTURE_BENCH_OK only.",
        deliver: false,
        idempotencyKey: crypto.randomUUID(),
      }),
    );
    if (typeof sent.runId !== "string") {
      throw new Error("Turn returned no runId");
    }
    const terminal = record(
      await rpc(driver, "agent.wait", { runId: sent.runId, timeoutMs: 120000 }),
    );
    if (terminal.status !== "ok") {
      throw new Error(`Turn failed: ${JSON.stringify(terminal)}`);
    }
    const until = Date.now() + 120000;
    let maxHeartbeatMs = 0;
    while (Date.now() < until) {
      const hook = record(await rpc(driver, `${pluginIds[0]}.probe`, {}));
      maxHeartbeatMs = Math.max(maxHeartbeatMs, Number(hook.maxHeartbeatMs));
      if (Array.isArray(hook.hookErrors) && hook.hookErrors.length) {
        throw new Error(`agent_end completion failed: ${JSON.stringify(hook.hookErrors)}`);
      }
      if (Number(hook.hookFinished) > Number(before.hookFinished)) {
        return { runId: sent.runId, terminal, hook: { ...hook, maxHeartbeatMs } };
      }
      await delay(50);
    }
    throw new Error("agent_end completion did not settle");
  };
  if (!values["skip-turns"]) {
    await phase("startup-first-turn", () => turn("startup"));
  }
  for (let index = 1; index <= samples; index++) {
    await phase(`config-${index}`, async () => {
      const before = await samplePluginState(index, 0);
      const config = record(await rpc(driver, "config.get", {}));
      const applied = record(
        await rpc(driver, "config.patch", {
          baseHash: config.hash,
          raw: JSON.stringify({
            agents: {
              defaults: {
                modelPolicy: {
                  allow: index % 2 ? ["openai/gpt-4.1", "openai/gpt-4.1-mini"] : ["openai/gpt-4.1"],
                },
              },
            },
          }),
        }),
      );
      const appliedDeadline = Date.now() + 120000;
      let configApplication: Record<string, unknown>;
      while (true) {
        configApplication = record(await rpc(driver, "config.get", {}));
        if (
          configApplication.hash === applied.hash &&
          configApplication.appliedConfigHash &&
          configApplication.appliedConfigHash === configApplication.configRevisionHash
        ) {
          break;
        }
        if (Date.now() > appliedDeadline) {
          throw new Error("Config owner did not publish the acknowledged revision");
        }
        await delay(50);
      }
      const owners = await samplePluginState(index, 0);
      if (
        owners.some(
          (owner, position) =>
            owner.evaluations !== before[position]?.evaluations ||
            owner.source !== before[position]?.source,
        )
      ) {
        throw new Error("Unrelated config reload re-evaluated plugin modules");
      }
      return { applied, configApplication, owners };
    });
    if (!values["skip-turns"]) {
      await phase(`config-first-turn-${index}`, () => turn(`config-${index}`));
    }
    for (const id of pluginIds) {
      await writeEntry(id, index + 1);
    }
    await phase(`replacement-${index}`, async () => {
      const applied = record(
        await rpc(driver, "plugins.reload", {
          plugins: pluginIds.map((pluginId) => ({ pluginId })),
          waitForDrain: true,
        }),
      );
      if (applied.restartRequired !== false) {
        throw new Error(`Replacement requires restart: ${JSON.stringify(applied)}`);
      }
      return { applied, owners: await samplePluginState(index + 1, 0) };
    });
    if (!values["skip-turns"]) {
      await phase(`replacement-first-turn-${index}`, () => turn(`replacement-${index}`));
    }
  }
} catch (error) {
  Object.assign(report, { error: String(error) });
  process.exitCode = 1;
  console.error(String(error));
} finally {
  if (timer) {
    clearInterval(timer);
  }
  await Promise.all(pending);
  const probeMisses = probes.filter((item) => !item.ok || item.ms > timeoutMs);
  Object.assign(report, {
    probeMisses: probeMisses.length,
    healthMisses: probeMisses.filter((item) => item.kind === "http").length,
    wsMisses: probeMisses.filter((item) => item.kind === "ws").length,
  });
  if (probeMisses.length) {
    process.exitCode = 1;
  }
  for (const client of clients) {
    client.close();
  }
  const shutdown = await Promise.all(
    children.map(async (child, index) => {
      let forced = false;
      const result = await stopChild(child, {
        // Large captures must receive the same cleanup budget as a supervised Gateway.
        teardownGraceMs: GATEWAY_SERVICE_STOP_TIMEOUT_MS,
        onForceKill: () => {
          forced = true;
        },
      });
      if (forced || (index === 1 && (result.exitCode !== 0 || result.signal !== null))) {
        process.exitCode = 1;
      }
      return Object.assign(result, { forced });
    }),
  );
  Object.assign(report, { shutdown, capturesAfterShutdown: await captureCensus() });
  for (const stream of logStreams) {
    stream.end();
  }
  Object.assign(report, { finishedAt: new Date().toISOString(), hostLoadAfter: loadavg() });
  await writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(`REPORT ${path.join(root, "report.json")}`);
}
