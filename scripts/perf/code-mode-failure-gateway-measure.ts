/**
 * Real Gateway/Code Mode failure and queued-follow-up proof using a loopback provider.
 * Build first. Run unchanged arms for A/A, then alternate baseline/candidate builds:
 * node --import ./scripts/tsx.mjs scripts/perf/code-mode-failure-gateway-measure.ts \
 *   --state-dir <owned-new-directory> --output <report.json> --entry <dist/entry.js>
 * --full seeds 5,000 sessions, 12 GiB of synthetic text plus indexes, and 62,000 files.
 * --reuse reopens only this harness's marked fixture. --allocation samples separately.
 * The mock caps baseline work at eight failing cells; candidate should stop after three.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { loadavg } from "node:os";
import path from "node:path";
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
} from "../lib/gateway-bench-profile.ts";
import { buildGatewayBenchChildArgs, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { generateTeamShapeFixture, parseTeamShapeOptions } from "./team-shape-fixture.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    output: { type: "string" },
    entry: { type: "string", default: "dist/entry.js" },
    port: { type: "string", default: "43825" },
    samples: { type: "string", default: "5" },
    "delay-ms": { type: "string", default: "500" },
    full: { type: "boolean" },
    reuse: { type: "boolean" },
    allocation: { type: "boolean" },
    "hold-ms": { type: "string", default: "0" },
    "expect-failures": { type: "string", default: "8" },
  },
});
assert(values["state-dir"] && values.output, "--state-dir and --output are required");
const root = path.resolve(values["state-dir"]);
const output = path.resolve(values.output);
const entry = path.resolve(values.entry);
assert(entry.includes(`${path.sep}dist${path.sep}`), "Use a built dist entry");
const port = Number(values.port);
const samples = Number(values.samples);
const delayMs = Number(values["delay-ms"]);
const holdMs = Number(values["hold-ms"]);
const expectedFailures = Number(values["expect-failures"]);
assert(expectedFailures === 3 || expectedFailures === 8);
assert(Number.isInteger(port) && port >= 40000 && port < 65535);
assert(Number.isInteger(samples) && samples > 0 && samples <= 20);
assert(Number.isInteger(delayMs) && delayMs >= 0 && delayMs <= 10000);
assert(Number.isInteger(holdMs) && holdMs >= 0 && holdMs <= 300000);
const markerPath = path.join(root, "code-mode-failure-fixture.json");
const configPath = path.join(root, "openclaw.json");
const providerPort = port + 1;
const model = "synthetic-code-mode-failure";
const code = 'await catalog.search("read"); throw new Error("synthetic repeated failure");';
const records: Array<Record<string, unknown>> = [];
const lifetime = new AbortController();
const requests = new Map<string, number>();
let gateway: ChildProcess | undefined;
let client: ReturnType<typeof createGatewayWsClient> | undefined;
let firstRequest: (() => void) | undefined;
let expectedKey: string | undefined;
let log: ReturnType<typeof createWriteStream> | undefined;
let fixture: unknown;
let env: NodeJS.ProcessEnv;
if (values.reuse) {
  assert(existsSync(markerPath), "--reuse requires this harness's fixture marker");
  fixture = JSON.parse(readFileSync(markerPath, "utf8"));
  env = {
    ...createGatewayBenchEnv(path.join(root, "home"), configPath, { startupTrace: false }),
    OPENCLAW_STATE_DIR: root,
    TMPDIR: path.join(root, "tmp"),
    TMP: path.join(root, "tmp"),
    TEMP: path.join(root, "tmp"),
    USERPROFILE: path.join(root, "home"),
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_PROFILE: `failure-fixture-${port}`,
  };
} else {
  const generated = await generateTeamShapeFixture(
    parseTeamShapeOptions([
      "--state-dir",
      root,
      "--port",
      String(port),
      "--sessions",
      values.full ? "5000" : "100",
      "--runs",
      "0",
      "--approvals",
      "0",
      "--cron",
      "0",
      "--projects",
      values.full ? "1" : "0",
      "--transcript-mib",
      values.full ? "12288" : "4",
      ...(values.full ? ["--worktree-files", "62000", "--worktree-file-bytes", "18432"] : []),
    ]),
  );
  fixture = generated.summary;
  env = generated.env;
  writeFileSync(markerPath, JSON.stringify(fixture, null, 2) + "\n");
}
const config = JSON.parse(readFileSync(configPath, "utf8")) as OpenClawConfig;
applyMockOpenAiModelConfig(config, { mockPort: providerPort, modelRef: `openai/${model}` });
config.models!.providers!.openai!.api = "openai-completions";
for (const item of config.models!.providers!.openai!.models) {
  item.api = "openai-completions";
}
config.plugins = { enabled: true, allow: ["openai"] };
config.tools = { codeMode: { enabled: true, executor: "node" } };
config.session = { ...config.session, maintenance: { maxEntries: 20000 } };
config.gateway!.controlUi = { enabled: true, allowedOrigins: [`http://127.0.0.1:${port}`] };
config.logging = { ...config.logging, level: "debug", consoleLevel: "info" };
writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
const provider = createServer((req, res) => {
  void (async () => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const text = messages
        .filter((message: { role?: string }) => message.role === "user")
        .map((message: { content?: unknown }) => JSON.stringify(message.content))
        .join("\n");
      const match = [...text.matchAll(/FAILURE_FIXTURE_([a-f0-9-]+)/g)].at(-1);
      const hasExec =
        Array.isArray(body.tools) &&
        body.tools.some((tool: { function?: { name?: string } }) => tool.function?.name === "exec");
      const key = hasExec ? (match?.[1] ?? "utility") : "utility";
      const followup = text.includes(`FOLLOWUP_FIXTURE_${key}`);
      const count = (requests.get(key) ?? 0) + 1;
      requests.set(key, count);
      if (key === expectedKey) {
        firstRequest?.();
        firstRequest = undefined;
      }
      const tool = key !== "utility" && !followup && count <= 8;
      await delay(delayMs + (count === 1 && key !== "utility" ? holdMs : 0), undefined, {
        signal: lifetime.signal,
      });
      const id = `chatcmpl-${randomUUID()}`;
      const delta = tool
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${randomUUID()}`,
                type: "function",
                function: {
                  name: "exec",
                  arguments: JSON.stringify({ code, title: "Synthetic failure proof" }),
                },
              },
            ],
          }
        : { role: "assistant", content: followup ? "FOLLOWUP_COMPLETED" : "BASELINE_PROVIDER_CAP" };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (choice: unknown) =>
        res.write(
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model, choices: [choice] })}\n\n`,
        );
      send({ index: 0, delta, finish_reason: null });
      send({ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" });
      res.end("data: [DONE]\n\n");
    } catch (error) {
      if (!res.destroyed) {
        res.writeHead(500);
        res.end(String(error));
      }
    }
  })();
});
await new Promise<void>((resolve, reject) => {
  provider.once("error", reject);
  provider.listen(providerPort, "127.0.0.1", resolve);
});
const events: Array<{ at: number; event: string; payload: unknown }> = [];
async function rpc(method: string, params: unknown) {
  const response = await client!.request(method, params, 120000, { retryStartup: true });
  assert(response.ok, `${method}: ${JSON.stringify(response.error)}`);
  return response.payload;
}
async function terminal(runId: string): Promise<unknown> {
  const end = performance.now() + holdMs + 120000;
  do {
    const result = await rpc("agent.wait", { runId, timeoutMs: 110000 });
    if (!isRecord(result) || (result.status !== "timeout" && result.status !== "pending")) {
      return result;
    }
    await delay(100);
  } while (performance.now() < end);
  throw new Error(`Run did not settle: ${runId}`);
}
async function waitUntil(test: () => Promise<boolean>, label: string, timeoutMs = 120000) {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    lifetime.signal.throwIfAborted();
    if (await test()) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
let cleanupPromise: Promise<void> | undefined;
function cleanup() {
  return (cleanupPromise ??= (async () => {
    lifetime.abort();
    client?.close();
    if (gateway) {
      await stopChild(gateway, { teardownGraceMs: 10000 });
    }
    provider.closeAllConnections();
    await new Promise<void>((resolve) => {
      provider.close(() => resolve());
    });
    log?.end();
  })());
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void cleanup());
}
try {
  gateway = spawn(
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
      env: { ...env, OPENAI_API_KEY: "synthetic-loopback-only", OPENCLAW_DEBUG_CODE_MODE: "1" },
    },
  );
  log = createWriteStream(output + ".gateway.log");
  gateway.stdout!.pipe(log, { end: false });
  gateway.stderr!.pipe(log, { end: false });
  await waitUntil(async () => {
    assert(gateway!.exitCode === null, "Gateway exited before ready");
    return fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(500) }).then(
      (response) => response.ok,
      () => false,
    );
  }, "Gateway readiness");
  client = createGatewayWsClient({
    url: `ws://127.0.0.1:${port}`,
    onEvent: (event) =>
      events.push({ at: performance.now(), event: event.event, payload: event.payload }),
  });
  await client.waitOpen();
  await rpc("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: { id: "gateway-client", version: "1.0.0", platform: process.platform, mode: "backend" },
    role: "operator",
    scopes: ["operator.read", "operator.write", "operator.admin"],
    caps: [],
  });
  await rpc("sessions.subscribe", {});
  console.log(`GATEWAY_READY http://127.0.0.1:${port}`);
  const profilePath = output + ".heapprofile";
  if (values.allocation) {
    await controlGatewayProfile(gateway, "heap", "start", profilePath, {
      includeCollectedObjects: true,
    });
  }
  const before = await readGatewayResources(gateway);
  const loadBefore = loadavg();
  for (let index = 0; index < samples; index++) {
    const key = randomUUID();
    expectedKey = key;
    const sessionKey = `agent:main:dashboard:${key}`;
    const runId = randomUUID();
    const followupId = randomUUID();
    const start = performance.now();
    const active = new Promise<void>((resolve) => {
      firstRequest = resolve;
    });
    await rpc("chat.send", {
      sessionKey,
      message: `FAILURE_FIXTURE_${key}`,
      idempotencyKey: runId,
    });
    await active;
    const sentAt = performance.now();
    await rpc("chat.send", {
      sessionKey,
      message: `FOLLOWUP_FIXTURE_${key}`,
      idempotencyKey: followupId,
      queueMode: "followup",
    });
    let queued: unknown;
    await waitUntil(
      async () => {
        const history = await rpc("chat.history", { sessionKey, limit: 50 });
        if (
          isRecord(history) &&
          isRecord(history.pendingInputs) &&
          Array.isArray(history.pendingInputs.items) &&
          history.pendingInputs.items.some(
            (input: unknown) =>
              isRecord(input) && input.runId === followupId && input.queued === true,
          )
        ) {
          queued = history;
          return true;
        }
        return false;
      },
      "followup queue receipt",
      10000,
    );
    const visibleAt = performance.now();
    console.log(`QUEUED ${sessionKey} ${JSON.stringify({ queueVisibleMs: visibleAt - sentAt })}`);
    const first = await terminal(runId);
    const terminalAt = performance.now();
    const second = await terminal(followupId);
    const history = await rpc("chat.history", { sessionKey, limit: 50 });
    assert(isRecord(history) && Array.isArray(history.messages), "Missing transcript");
    const toolResults = history.messages
      .filter(
        (message: unknown) =>
          isRecord(message) && message.role === "toolResult" && message.toolName === "exec",
      )
      .map((message: { content: Array<{ type: string; text?: string }> }) => {
        const text = message.content.find((part) => part.type === "text")?.text;
        try {
          return JSON.parse(text ?? "null");
        } catch {
          return { text };
        }
      });
    const failures = toolResults.filter(
      (result: unknown) =>
        isRecord(result) &&
        result.status === "failed" &&
        String(result.error).includes("synthetic repeated failure"),
    );
    assert.equal(failures.length, expectedFailures, "Actual Code Mode executions before terminal");
    assert(
      isRecord(first) &&
        isRecord(first.terminalReply) &&
        first.terminalReply.disposition === "visible",
      "Failure must have a visible recorded outcome",
    );
    if (expectedFailures === 3) {
      assert.match(String(first.terminalReply.text), /failed 3 times/);
    }
    assert(
      isRecord(second) &&
        isRecord(second.terminalReply) &&
        second.terminalReply.text === "FOLLOWUP_COMPLETED",
      "Queued followup must complete",
    );
    records.push({
      index,
      sessionKey,
      runId,
      followupId,
      modelRequests: requests.get(key),
      failureCount: failures.length,
      toolResults,
      queueVisibleMs: visibleAt - sentAt,
      terminalMs: terminalAt - start,
      followupMs: performance.now() - sentAt,
      first,
      second,
      queued,
      history,
      events: events.filter((event) => JSON.stringify(event.payload).includes(key)),
    });
  }
  const after = await readGatewayResources(gateway);
  let allocation;
  if (values.allocation) {
    await controlGatewayProfile(gateway, "heap", "stop", profilePath);
    allocation = readGatewayHeapProfile(profilePath);
  }
  writeFileSync(
    output,
    JSON.stringify(
      {
        fixture,
        entry,
        entrySha256: createHash("sha256").update(readFileSync(entry)).digest("hex"),
        platform: process.platform,
        workload: { samples, delayMs, code, maxProviderCalls: 8 },
        loadBefore,
        loadAfter: loadavg(),
        cpu: measureGatewayCpuUsage(before, after),
        memoryBefore: before.memory,
        memoryAfter: after.memory,
        allocation,
        records,
        agentDatabaseBytes: statSync(path.join(root, "agents/main/agent/openclaw-agent.sqlite"))
          .size,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`REPORT ${output}`);
} finally {
  await cleanup();
}
