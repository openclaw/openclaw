// Build qaRuntime first. Synthetic localhost chat.send proof; never operator state.
// node --import ./scripts/tsx.mjs scripts/perf/transcript-turn-gateway.mts --root <new-dir>
// Warm census: --entry src/entry.ts --sync-fs --turns 7 --settle-ms 30000 --steady-ms 60000 --windows 5.
// Run --timings separately: CPU and V8 allocation counters exclude census overhead.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { applyMockOpenAiModelConfig } from "../e2e/lib/fixtures/mock-openai-config.mjs";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  createGatewayBenchEnv,
  waitForInitialProbe,
  writeGatewayBenchConfig,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    engine: { type: "string", default: "sqlite" },
    connection: { type: "string" },
    prefix: { type: "string", default: "turn_gateway" },
    "sync-fs": { type: "boolean", default: false },
    "state-fixture": { type: "string" },
    turns: { type: "string", default: "3" },
    live: { type: "boolean", default: false },
    sandbox: { type: "boolean", default: false },
    "delay-ms": { type: "string", default: "0" },
    "delay-match": { type: "string", default: "readTtsPrefs" },
    timings: { type: "boolean", default: false },
    allocations: { type: "boolean", default: false },
    profile: { type: "boolean", default: false },
    entry: { type: "string", default: "openclaw.mjs" },
    "steady-ms": { type: "string", default: "0" },
    "settle-ms": { type: "string", default: "0" },
    windows: { type: "string", default: "1" },
  },
});
assert(values.root, "--root must name a new synthetic directory");
assert(values.engine === "sqlite" || values.engine === "postgres");
assert(values.engine !== "postgres" || values.connection, "PostgreSQL needs --connection");
const root = path.resolve(values.root);
mkdirSync(root);
const fixture = values["state-fixture"] && path.resolve(values["state-fixture"]);
const workspace = path.join(fixture || root, "workspace");
if (!fixture) {
  mkdirSync(workspace);
}
const turnCount = Number(values.turns);
assert(Number.isSafeInteger(turnCount) && turnCount > 0 && turnCount <= 30);
const steadyMs = Number(values["steady-ms"]);
assert(Number.isSafeInteger(steadyMs) && steadyMs >= 0);
assert(!steadyMs || (values["sync-fs"] && turnCount > 1));
const windows = Number(values.windows);
assert(Number.isSafeInteger(windows) && windows >= 1 && windows <= 10);
assert(windows === 1 || steadyMs > 0);
const steadyTurns = turnCount - 1;
const totalTurns = turnCount * windows;
const settleMs = Number(values["settle-ms"]);
assert(Number.isSafeInteger(settleMs) && settleMs >= 0);
const probeFetch = (url: string | URL) => fetch(url, { headers: { connection: "close" } });
const sourceEntry = values.entry!.endsWith(".ts");
const entryArgs = sourceEntry ? ["--import", "./scripts/tsx.mjs", values.entry!] : [values.entry!];
const delayMs = Number(values["delay-ms"]);
assert(Number.isSafeInteger(delayMs) && delayMs >= 0 && delayMs <= 1000);
const port = await getFreePort();
const mockPort = await getFreePort();
const probePort = values["sync-fs"] ? await getFreePort() : undefined;
const tracePreload = new URL(
  probePort ? "./sync-fs-turn-preload.mjs" : "../bench-transcript-turn-preload.mjs",
  import.meta.url,
).href;
const config: OpenClawConfig = {
  ...structuredClone(BASE_GATEWAY_BENCH_CONFIG),
  tools: { codeMode: false },
  agents: { defaults: { skipBootstrap: true } },
  cron: { enabled: false },
  session: { maintenance: { mode: "warn", maxDiskBytes: false } },
};
applyMockOpenAiModelConfig(config, { mockPort, modelRef: "openai/gpt-4.1" });
if (values.live) {
  assert(process.env.OPENAI_API_KEY, "Live proof requires a task-scoped OpenAI key");
  config.models!.providers!.openai!.baseUrl = "https://api.openai.com/v1";
  config.models!.providers!.openai!.request = undefined;
}
if (values.sandbox) {
  config.agents!.defaults!.sandbox = {
    mode: "all",
    scope: "session",
    workspaceAccess: "rw",
    docker: { image: "node:26.12.1-bookworm-slim", network: "none" },
  };
}
config.plugins = {
  ...config.plugins,
  entries: {
    ...config.plugins?.entries,
    "memory-core": { config: { dreaming: { enabled: false } } },
  },
};
if (values.engine === "postgres") {
  config.database = {
    engine: "postgres",
    postgres: {
      connection: { source: "env", provider: "default", id: "OPENCLAW_BENCH_POSTGRES_CONNECTION" },
      schemaPrefix: values.prefix,
    },
  };
}
const configPath = writeGatewayBenchConfig(root, config, {
  agentList: [{ id: "main", workspace }],
});
const trace = path.join(root, "statements.jsonl");
writeFileSync(trace, "");
const cacheRoot = mkdtempSync(path.join(tmpdir(), "openclaw-turn-gateway-cache-"));
const env = createGatewayBenchEnv(root, configPath, {
  caseEnv: {
    XDG_CACHE_HOME: cacheRoot,
    OPENAI_API_KEY: values.live ? process.env.OPENAI_API_KEY! : "synthetic-localhost-fixture",
    ...(fixture ? { OPENCLAW_STATE_DIR: fixture } : {}),
    ...(values.sandbox && process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
    ...(values.sandbox && process.env.DOCKER_CONFIG
      ? { DOCKER_CONFIG: process.env.DOCKER_CONFIG }
      : {}),
    ...(process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH
      ? { BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH }
      : {}),
    ...(values.connection ? { OPENCLAW_BENCH_POSTGRES_CONNECTION: values.connection } : {}),
  },
});
const control = path.join(root, "responses.json");
const children: ChildProcess[] = [];
let gateway: ChildProcess | undefined;
let client: ReturnType<typeof createGatewayWsClient> | undefined;
let cleanupPromise: Promise<unknown> | undefined;
let failure: unknown;
const shutdown: unknown[] = [];
function launch(args: string[], childEnv: NodeJS.ProcessEnv, label: string) {
  const log = openSync(path.join(root, `${label}.log`), "w");
  try {
    const child = spawn(process.execPath, args, {
      env: childEnv,
      detached: process.platform !== "win32",
      stdio: ["ignore", log, log],
    });
    children.push(child);
    return child;
  } finally {
    closeSync(log);
  }
}
function cleanup() {
  return (cleanupPromise ??= (async () => {
    client?.close();
    if (gateway && gateway.exitCode === null) {
      try {
        const result = await stopChild(gateway, { teardownGraceMs: 30_000 });
        shutdown.push(result);
        assert.equal(result.exitCode, 0, "Gateway did not shut down cleanly");
        assert.equal(result.signal, null, "Gateway needed a forced shutdown");
      } catch (error) {
        shutdown.push({ error: String(error) });
        failure ??= error;
      }
    }
    const results = await Promise.allSettled(children.map((child) => stopChild(child)));
    shutdown.push(...results);
    for (const result of results) {
      if (result.status === "rejected") {
        failure ??= result.reason;
      }
    }
    if (results.every((result) => result.status === "fulfilled")) {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  })());
}
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.once(signal, () => void cleanup().finally(() => process.exit(code)));
}
const turns: Array<{ turn: number; start: number; end: number; elapsedMs: number }> = [];
const filesystem: unknown[] = [];
let history: Array<{ role: string; text: string }> = [];
try {
  const validation = spawnSync(process.execPath, [...entryArgs, "config", "validate", "--json"], {
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  writeFileSync(path.join(root, "config-validation.log"), validation.stdout + validation.stderr);
  assert.equal(validation.status, 0, "Config validation failed; inspect config-validation.log");
  writeFileSync(control, JSON.stringify({ text: "Synthetic answer 1." }));
  if (!values.live) {
    launch(
      ["scripts/e2e/mock-openai-server.mjs"],
      {
        ...env,
        MOCK_PORT: String(mockPort),
        MOCK_RESPONSE_CONTROL: control,
        MOCK_REQUEST_LOG: path.join(root, "provider-requests.jsonl"),
      },
      "mock",
    );
  }
  const ready = async (targetPort: number, pathname: string) => {
    const result = await waitForInitialProbe({
      port: targetPort,
      path: pathname,
      startAt: performance.now(),
      deadlineAt: performance.now() + 120_000,
    });
    assert.equal(result.status, 200, `Readiness failed for ${pathname}; inspect child logs`);
  };
  if (!values.live) {
    await ready(mockPort, "/health");
  }
  gateway = launch(
    [
      ...(values.profile ? ["--cpu-prof", `--cpu-prof-dir=${root}`] : []),
      ...entryArgs.slice(0, -1),
      ...(sourceEntry ? ["--import", tracePreload] : []),
      entryArgs.at(-1)!,
      "gateway",
      "run",
      "--port",
      String(port),
      "--bind",
      "loopback",
      "--auth",
      "none",
      "--tailscale",
      "off",
    ],
    {
      ...env,
      ...(probePort
        ? {
            OPENCLAW_SYNC_FS_PROBE_PORT: String(probePort),
            OPENCLAW_SYNC_FS_PROBE_MODE: values.timings ? "timing" : "trace",
          }
        : { OPENCLAW_TURN_TRACE: trace }),
      NODE_OPTIONS: `--enable-source-maps${sourceEntry ? "" : ` --import=${tracePreload}`}`,
    },
    "gateway",
  );
  await ready(port, "/readyz");
  const connected = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
  client = connected;
  await connected.waitOpen();
  const rpc = async (method: string, params: unknown) => {
    const response = await connected.request(method, params, 120_000);
    assert(response.ok, `${method} failed: ${JSON.stringify(response.error)}`);
    return response.payload;
  };
  await rpc("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: { id: "gateway-client", version: "1.0.0", platform: process.platform, mode: "backend" },
    role: "operator",
    scopes: ["operator.read", "operator.write", "operator.admin"],
    caps: [],
  });
  const sessionKey = `agent:main:transcript-turn-proof-${path.basename(root)}`;
  if (steadyMs) {
    await rpc("sessions.create", { key: sessionKey, agentId: "main" });
  }
  const expected: typeof history = [];
  let steadyStarted = 0;
  for (let turn = 1; turn <= totalTurns; turn++) {
    const windowTurn = ((turn - 1) % turnCount) + 1;
    if (steadyMs && windowTurn === 1) {
      await rpc("sessions.reset", { key: sessionKey });
      expected.length = 0;
      expected.push({ role: "system", text: "Reset" });
      history = [];
    }
    if (windowTurn === 2 && settleMs) {
      await delay(settleMs);
    }
    const liveFile = `lane2113-payload-${windowTurn}.txt`;
    const liveContent = `SYNTHETIC_FS_TURN_OK_${windowTurn}`;
    if (values.live) {
      writeFileSync(path.join(workspace, liveFile), `${liveContent}\n`);
    }
    const message = values.live
      ? `Turn ${windowTurn}: I just created ${liveFile} in the workspace. Use the read tool to inspect this new file and reply with its exact contents.`
      : `Synthetic prompt ${windowTurn}.`;
    const answer = `Synthetic answer ${windowTurn}.`;
    writeFileSync(control, JSON.stringify({ text: answer }));
    if (probePort && (!steadyMs || windowTurn === 2)) {
      const probe = new URL(`http://127.0.0.1:${probePort}/start`);
      probe.searchParams.set("delayMs", String(turn > 1 ? delayMs : 0));
      probe.searchParams.set("match", values["delay-match"]!);
      if (values.allocations) {
        probe.searchParams.set("allocations", "1");
      }
      await probeFetch(probe);
      if (steadyMs) {
        steadyStarted = performance.now();
      }
    }
    const start = performance.timeOrigin + performance.now();
    const started = await rpc("chat.send", {
      sessionKey,
      message,
      idempotencyKey: randomUUID(),
      originatingChannel: "webchat",
      originatingTo: sessionKey,
      originatingAccountId: "default",
    });
    assert(isRecord(started) && started.status === "started" && typeof started.runId === "string");
    const settled = await rpc("agent.wait", { runId: started.runId, timeoutMs: 100_000 });
    const end = performance.timeOrigin + performance.now();
    assert(isRecord(settled) && settled.status === "ok");
    if (probePort && !steadyMs) {
      filesystem.push({
        turn,
        ...(await (await probeFetch(`http://127.0.0.1:${probePort}/stop`)).json()),
      });
    }
    turns.push({ turn, start, end, elapsedMs: end - start });
    const result = await rpc("chat.history", { sessionKey, limit: 1_000 });
    assert(isRecord(result) && Array.isArray(result.messages));
    const previousHistoryLength = history.length;
    history = result.messages.map((item: unknown) => {
      assert(isRecord(item) && typeof item.role === "string");
      const text =
        typeof item.content === "string"
          ? item.content
          : Array.isArray(item.content)
            ? item.content
                .map((part: unknown) =>
                  isRecord(part) && typeof part.text === "string" ? part.text : "",
                )
                .join("")
            : "";
      return { role: item.role, text };
    });
    expected.push({ role: "user", text: message }, { role: "assistant", text: answer });
    if (values.live) {
      assert(
        history
          .slice(previousHistoryLength)
          .some((item) => item.role === "toolResult" && item.text.trim() === liveContent),
        "Each live turn must actually read the synthetic file",
      );
      assert.equal(history.at(-1)?.role, "assistant");
      assert(history.at(-1)?.text.trim(), "The live turn must produce a final answer");
    } else {
      assert.deepEqual(history, expected);
    }
    if (probePort) {
      if (!steadyMs) {
        await probeFetch(`http://127.0.0.1:${probePort}/start`);
      }
      await rpc("sessions.list", { limit: 50, includeActivitySummary: true });
      if (!steadyMs) {
        filesystem.push({
          rowsAfterTurn: turn,
          ...(await (await probeFetch(`http://127.0.0.1:${probePort}/stop`)).json()),
        });
      }
    }
    if (steadyMs && windowTurn > 1) {
      const until = steadyStarted + ((windowTurn - 1) * steadyMs) / steadyTurns;
      await delay(Math.max(0, until - performance.now()));
      if (windowTurn === turnCount) {
        filesystem.push({
          window: Math.floor((turn - 1) / turnCount) + 1,
          steadyTurns,
          ...(await (await probeFetch(`http://127.0.0.1:${probePort}/stop`)).json()),
        });
        writeFileSync(path.join(root, "filesystem.json"), JSON.stringify(filesystem, null, 2));
      }
    }
  }
} catch (error) {
  failure = error;
} finally {
  await cleanup();
  const events = readFileSync(trace, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const event: unknown = JSON.parse(line);
      assert(isRecord(event));
      if (event.source === "native") {
        return [];
      }
      assert(
        typeof event.at === "number" &&
          typeof event.sql === "string" &&
          typeof event.engine === "string" &&
          typeof event.threadId === "number",
      );
      return [{ at: event.at, sql: event.sql, engine: event.engine, threadId: event.threadId }];
    });
  const counts = turns.map((turn) => {
    const selected = events.filter((event) => event.at >= turn.start && event.at <= turn.end);
    const sql = selected.flatMap((event) =>
      event.sql.split(";").filter((part: string) => part.trim()),
    );
    const byThread = [...new Set(selected.map((event) => event.threadId))].map((threadId) => {
      const thread = selected.filter((event) => event.threadId === threadId);
      return {
        threadId,
        statements: thread.flatMap((event) => event.sql.split(";").filter((part) => part.trim()))
          .length,
        trips: thread.filter((event) => event.engine === "postgres").length,
      };
    });
    return {
      turn: turn.turn,
      start: turn.start,
      end: turn.end,
      elapsedMs: turn.elapsedMs,
      statements: sql.length,
      trips: selected.filter((event) => event.engine === "postgres").length,
      transactions: sql.filter((statement: string) => /^\s*BEGIN\b/iu.test(statement)).length,
      byThread,
    };
  });
  const evidence = {
    scope: steadyMs
      ? "warm fixed windows: chat.send through agent.wait, history and list reads, plus background work"
      : "wall-window SQL from chat.send through agent.wait; history reads excluded; background work may overlap",
    workload: { entry: values.entry, steadyMs, windows, steadyTurns, settleMs },
    engine: values.engine,
    runtime: process.version,
    load: loadavg(),
    counts,
    filesystem,
    history,
    shutdown,
    error: failure instanceof Error ? failure.stack : failure,
  };
  writeFileSync(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(
    JSON.stringify({
      ...evidence,
      filesystem: filesystem.map((sample) => {
        assert(isRecord(sample));
        return Object.assign({}, sample, {
          records: Array.isArray(sample.records) ? sample.records.length : undefined,
        });
      }),
    }),
  );
}
if (failure) {
  throw failure instanceof Error ? failure : new Error("Gateway proof failed", { cause: failure });
}
