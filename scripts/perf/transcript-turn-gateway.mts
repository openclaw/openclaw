// Build qaRuntime first. Synthetic localhost chat.send proof; never operator state.
// node --import ./scripts/tsx.mjs scripts/perf/transcript-turn-gateway.mts --root <new-dir>
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
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
  },
});
assert(values.root, "--root must name a new synthetic directory");
assert(values.engine === "sqlite" || values.engine === "postgres");
assert(values.engine !== "postgres" || values.connection, "PostgreSQL needs --connection");
const root = path.resolve(values.root);
mkdirSync(root);
const workspace = path.join(root, "workspace");
mkdirSync(workspace);
const port = await getFreePort();
const mockPort = await getFreePort();
const config: OpenClawConfig = {
  ...structuredClone(BASE_GATEWAY_BENCH_CONFIG),
  tools: { codeMode: false },
  agents: { defaults: { skipBootstrap: true } },
  cron: { enabled: false },
};
applyMockOpenAiModelConfig(config, { mockPort, modelRef: "openai/gpt-4.1" });
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
const env = createGatewayBenchEnv(root, configPath, {
  caseEnv: {
    OPENAI_API_KEY: "synthetic-localhost-fixture",
    ...(process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH
      ? { BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH }
      : {}),
    ...(values.connection ? { OPENCLAW_BENCH_POSTGRES_CONNECTION: values.connection } : {}),
  },
});
const validation = spawnSync(process.execPath, ["openclaw.mjs", "config", "validate", "--json"], {
  env,
  encoding: "utf8",
  timeout: 120_000,
});
writeFileSync(path.join(root, "config-validation.log"), validation.stdout + validation.stderr);
assert.equal(validation.status, 0, "Config validation failed; inspect config-validation.log");
const control = path.join(root, "responses.json");
writeFileSync(control, JSON.stringify({ text: "Synthetic answer 1." }));
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
  })());
}
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.once(signal, () => void cleanup().finally(() => process.exit(code)));
}
const turns: Array<{ turn: number; start: number; end: number; elapsedMs: number }> = [];
let history: Array<{ role: string; text: string }> = [];
try {
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
  const ready = async (targetPort: number, pathname: string) => {
    const result = await waitForInitialProbe({
      port: targetPort,
      path: pathname,
      startAt: performance.now(),
      deadlineAt: performance.now() + 120_000,
    });
    assert.equal(result.status, 200, `Readiness failed for ${pathname}; inspect child logs`);
  };
  await ready(mockPort, "/health");
  gateway = launch(
    [
      "openclaw.mjs",
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
      OPENCLAW_TURN_TRACE: trace,
      NODE_OPTIONS: `--import=${new URL("../bench-transcript-turn-preload.mjs", import.meta.url).href}`,
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
  const sessionKey = "agent:main:transcript-turn-proof";
  const expected: typeof history = [];
  for (let turn = 1; turn <= 3; turn++) {
    const message = `Synthetic prompt ${turn}.`;
    const answer = `Synthetic answer ${turn}.`;
    writeFileSync(control, JSON.stringify({ text: answer }));
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
    turns.push({ turn, start, end, elapsedMs: end - start });
    const result = await rpc("chat.history", { sessionKey, limit: 20 });
    assert(isRecord(result) && Array.isArray(result.messages));
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
    assert.deepEqual(history, expected);
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
    scope:
      "wall-window SQL from chat.send through agent.wait; history reads excluded; background work may overlap",
    engine: values.engine,
    runtime: process.version,
    load: loadavg(),
    counts,
    history,
    shutdown,
    error: failure instanceof Error ? failure.stack : failure,
  };
  writeFileSync(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
}
if (failure) {
  throw failure instanceof Error ? failure : new Error("Gateway proof failed", { cause: failure });
}
