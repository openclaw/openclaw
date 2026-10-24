// Synthetic Responses continuation workload. Run only on an approved benchmark host.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { constants, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { Context, Model, StreamFn } from "../../packages/ai/src/types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    "immutable-owner": { type: "string" },
    gateway: { type: "boolean", default: false },
    "state-dir": { type: "string" },
    sessions: { type: "string", default: "16" },
    turns: { type: "string", default: "16" },
    history: { type: "string", default: "128" },
    "message-bytes": { type: "string", default: "1024" },
    port: { type: "string", default: "41668" },
    "start-at": { type: "string", default: "0" },
    counts: { type: "boolean", default: false },
    unicode: { type: "boolean", default: false },
    output: { type: "string" },
  },
});
function integer(value: string | undefined, minimum: number) {
  const parsed = Number(value);
  assert(Number.isSafeInteger(parsed) && parsed >= minimum);
  return parsed;
}
const sessions = integer(values.sessions, 1);
const turns = integer(values.turns, 2);
const history = integer(values.history, 1);
const messageBytes = integer(values["message-bytes"], 1);
const port = integer(values.port, 40000);
assert(port <= 65535);
const startAt = integer(values["start-at"], 0);
if (values.gateway) {
  assert(values["state-dir"], "--gateway requires a new --state-dir");
  const root = path.resolve(values["state-dir"]);
  fs.mkdirSync(root);
  for (const directory of ["home", "tmp", "workspace"]) {
    fs.mkdirSync(path.join(root, directory));
  }
  const { BASE_GATEWAY_BENCH_CONFIG, createGatewayBenchEnv } =
    await import("../lib/gateway-bench-runtime.js");
  const { applyMockOpenAiModelConfig } = await import("../e2e/lib/fixtures/mock-openai-config.mjs");
  const config: OpenClawConfig = {
    ...BASE_GATEWAY_BENCH_CONFIG,
    agents: {
      defaults: {},
      entries: { main: { workspace: path.join(root, "workspace") } },
    },
    cron: { enabled: false },
    plugins: { ...BASE_GATEWAY_BENCH_CONFIG.plugins, slots: { memory: "none" } },
  };
  applyMockOpenAiModelConfig(config, { mockPort: port, modelRef: "openai/synthetic-model" });
  const provider = config.models?.providers?.openai;
  assert(provider?.models?.[0]);
  provider.models[0].compat = { supportsResponsesContinuation: true };
  const params = config.agents?.defaults?.models?.["openai/synthetic-model"]?.params;
  assert(params);
  params.store = true;
  const configPath = path.join(root, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  process.env = createGatewayBenchEnv(path.join(root, "home"), configPath, {
    startupTrace: false,
    caseEnv: {
      OPENCLAW_STATE_DIR: root,
      TMPDIR: path.join(root, "tmp"),
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENAI_API_KEY: "synthetic-fixture",
    },
  });
}
const ownerURL = new URL("../../src/agents/embedded-agent-runner/session-fork.ts", import.meta.url)
  .href;
const ownerSource = fs.readFileSync(values.owner ?? new URL(ownerURL), "utf8");
const immutableURL = new URL("../../src/shared/immutable-data.ts", import.meta.url).href;
const immutableSource = fs.readFileSync(values["immutable-owner"] ?? new URL(immutableURL), "utf8");
const probe = {
  snapshotsSaved: 0,
  snapshotsRead: 0,
  stringifyCalls: 0,
  stringifyBytes: 0,
  serializedBytes: 0,
  stringify(value: unknown) {
    const result = JSON.stringify(value);
    if (counting && result) {
      probe.stringifyCalls++;
      probe.stringifyBytes += Buffer.byteLength(result);
    }
    return result;
  },
};
const probeKey = Symbol.for("openclaw.perf.forkCapture");
Reflect.set(globalThis, probeKey, probe);
const probeExpression = 'globalThis[Symbol.for("openclaw.perf.forkCapture")]';
let ownerLoaded = false;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url === immutableURL) {
      return {
        format: "module",
        source: stripTypeScriptTypes(immutableSource),
        shortCircuit: true,
      };
    }
    if (url !== ownerURL) {
      return nextLoad(url, context);
    }
    ownerLoaded = true;
    let source = ownerSource;
    if (values.counts) {
      assert(source.includes("JSON.stringify("), "capture owner contains JSON encoding sites");
      source = source.replaceAll("JSON.stringify(", `${probeExpression}.stringify(`);
      const saveAnchor = "snapshots.set(identity.sessionId, snapshot);";
      const readAnchor = "const snapshot = snapshots.get(params.sessionId);";
      assert.equal(source.split(saveAnchor).length, 2, "one snapshot publication owner");
      assert.equal(source.split(readAnchor).length, 2, "one fork snapshot read owner");
      source = source.replace(saveAnchor, `${saveAnchor}\n${probeExpression}.snapshotsSaved++;`);
      source = source.replace(readAnchor, `${readAnchor}\n${probeExpression}.snapshotsRead++;`);
      if (source.includes("return serialize(value);")) {
        source = source.replace(
          "return serialize(value);",
          `const encoded = serialize(value); ${probeExpression}.serializedBytes += encoded.byteLength; return encoded;`,
        );
      }
    }
    return { format: "module", source: stripTypeScriptTypes(source), shortCircuit: true };
  },
});
// Retain this native function for fixture construction and parity checks.
const stringify = JSON.stringify;
let counting = false;
let requests = 0;
let continuations = 0;
let wireBytes = 0;
let forkExpected: Record<string, unknown> | undefined;
let forkChecks = 0;
const completion = (id: string) => ({
  type: "response.completed",
  response: {
    id,
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        id: `msg_${id}`,
        status: "completed",
        content: [{ type: "output_text", text: "Synthetic answer", annotations: [] }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  },
});
const server = createServer((request, response) => {
  void (async () => {
    try {
      assert.equal(request.url, "/v1/responses", "only synthetic Responses traffic is expected");
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = JSON.parse(raw) as Record<string, unknown>;
      if (forkExpected) {
        assert.equal(body.previous_response_id, undefined);
        const input = body.input as unknown[];
        assert.equal(stringify(input.slice(0, -1)), stringify(forkExpected.input));
        assert.equal(stringify({ ...body, input: forkExpected.input }), stringify(forkExpected));
        forkChecks++;
      } else {
        requests++;
        continuations += Number(Boolean(body.previous_response_id));
        wireBytes += Buffer.byteLength(raw);
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${stringify(completion(`synthetic_${requests}_${forkChecks}`))}\n\n`);
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  })();
});
await new Promise<void>((resolve) => {
  server.listen(port, "127.0.0.1", resolve);
});
const { createAiTransportHost, runWithAiTransportHost } =
  await import("../../packages/ai/src/host.js");
const { cleanupSessionResources } = await import("../../packages/ai/src/session-resources.js");
const { createOpenAIResponsesTransportStreamFn } =
  await import("../../packages/ai/src/transports/openai-responses-client.js");
const { wrapStreamFnWithSessionFork, runEmbeddedSessionFork } =
  await import("../../src/agents/embedded-agent-runner/session-fork.js");
assert(ownerLoaded);
const host = createAiTransportHost({ runInDetachedAsyncContext: AsyncLocalStorage.snapshot() });
const model: Model = {
  api: "openai-responses",
  provider: "openai",
  id: "synthetic-model",
  name: "Synthetic model",
  baseUrl: `http://127.0.0.1:${port}/v1`,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 1024,
  compat: { supportsResponsesContinuation: true },
};
if (values.gateway) {
  const { startGatewayServer } = await import("../../src/gateway/server.js");
  const { GatewayClient } = await import("../../src/gateway/client.js");
  const gatewayPort = port + 1;
  assert(gatewayPort <= 65535);
  const gateway = await startGatewayServer(gatewayPort, {
    bind: "loopback",
    controlUiEnabled: false,
  });
  const ready = Promise.withResolvers<void>();
  const peer = new GatewayClient({
    url: `ws://127.0.0.1:${gatewayPort}`,
    origin: `http://127.0.0.1:${gatewayPort}`,
    clientName: "openclaw-control-ui",
    mode: "webchat",
    platform: "web",
    instanceId: "synthetic-fork-capture",
    scopes: ["operator.admin"],
    requestTimeoutMs: 120000,
    onHelloOk: () => ready.resolve(),
    onConnectError: (error) => ready.reject(error),
  });
  try {
    peer.start();
    await ready.promise;
    counting = true;
    const before = process.cpuUsage();
    for (let turn = 0; turn < turns; turn++) {
      const runId = `synthetic-fork-${turn}`;
      const sent = await peer.request<{ runId: string }>("chat.send", {
        sessionKey: "agent:main:fork-capture",
        message: `Synthetic parent ${turn} ${"x".repeat(messageBytes)}`,
        idempotencyKey: runId,
      });
      assert.equal(sent.runId, runId);
      const completed = await peer.request<{ status: string }>("agent.wait", {
        runId,
        timeoutMs: 120000,
      });
      assert.equal(completed.status, "ok", stringify(completed));
    }
    const cpu = process.cpuUsage(before);
    counting = false;
    const result = {
      protocol: "session-fork-capture-gateway-v1",
      turns,
      requests,
      continuations,
      wireBytes,
      captures: probe,
      cpuUsPerTurn: (cpu.user + cpu.system) / turns,
      scope:
        "isolated Gateway chat.send and real Responses transport to synthetic loopback HTTP; counting-only, no timing comparison",
    };
    if (values.output) {
      fs.writeFileSync(path.resolve(values.output), `${stringify(result, null, 2)}\n`);
    }
    console.log(stringify(result));
  } finally {
    peer.stop();
    await gateway.close();
    hooks.deregister();
    server.closeAllConnections();
    server.close();
  }
  process.exit(0);
}
const transport = createOpenAIResponsesTransportStreamFn();
let prepared: Record<string, unknown> | undefined;
const observedTransport: StreamFn = (requestModel, context, options) =>
  transport(requestModel, context, options);
const inputFixture: Context["messages"] = Array.from({ length: history }, (_, index) => ({
  role: "user",
  content: `Synthetic history ${index} ${values.unicode ? "🦞" : ""}${"x".repeat(messageBytes)}`,
  timestamp: index,
}));
async function populate(count: number, verify: boolean) {
  for (let session = 0; session < count; session++) {
    const identity = { agentId: "synthetic", sessionId: `synthetic-${session}`, runId: "run" };
    const parent = wrapStreamFnWithSessionFork(observedTransport, identity);
    const messages = [...inputFixture];
    for (let turn = 0; turn < turns; turn++) {
      messages.push({
        role: "user",
        content: `Synthetic parent ${session}:${turn}`,
        timestamp: history + turn,
      });
      const result = await (
        await parent(
          model,
          { messages },
          {
            apiKey: "synthetic-key",
            sessionId: identity.sessionId,
            transport: "sse",
            onPayload(payload) {
              assert(payload && typeof payload === "object");
              const final = { ...payload, store: true };
              if (verify) {
                prepared = JSON.parse(stringify(final));
              }
              return final;
            },
          },
        )
      ).result();
      assert.equal(result.stopReason, "stop", result.errorMessage ?? "Synthetic request failed");
      messages.push(result);
    }
    if (verify) {
      assert(prepared);
      forkExpected = prepared;
      assert.equal(
        await runEmbeddedSessionFork({
          ...identity,
          model,
          apiKey: "synthetic-key",
          question: "Synthetic fork question",
          assertCurrent() {},
        }),
        "Synthetic answer",
      );
      forkExpected = undefined;
    }
  }
}
function distribution(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    samples: sorted.length,
    totalMs: sorted.reduce((a, b) => a + b, 0),
    maxMs: sorted.at(-1) ?? 0,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null,
  };
}
const collections: Array<{ kind: number; ms: number }> = [];
let begin = Infinity;
let end = Infinity;
const observer = new PerformanceObserver((entries) => {
  for (const entry of entries.getEntries()) {
    if (entry.startTime >= begin && entry.startTime < end) {
      collections.push({
        kind: (entry.toJSON().detail as { kind: number }).kind,
        ms: entry.duration,
      });
    }
  }
});
observer.observe({ entryTypes: ["gc"] });
const loop = monitorEventLoopDelay({ resolution: 10 });
try {
  await runWithAiTransportHost(host, () => populate(2, true));
  cleanupSessionResources(undefined, host);
  requests = continuations = wireBytes = forkChecks = 0;
  Object.assign(probe, {
    snapshotsSaved: 0,
    snapshotsRead: 0,
    stringifyCalls: 0,
    stringifyBytes: 0,
    serializedBytes: 0,
  });
  console.log(`READY ${process.pid}`);
  if (startAt) {
    assert(Date.now() < startAt, "missed common start deadline");
    await delay(startAt - Date.now());
  }
  loop.enable();
  const beforeCpu = process.cpuUsage();
  const beforeThreadCpu = process.threadCpuUsage();
  begin = performance.now();
  counting = true;
  await runWithAiTransportHost(host, () => populate(sessions, false));
  counting = false;
  end = performance.now();
  const cpu = process.cpuUsage(beforeCpu);
  const threadCpu = process.threadCpuUsage(beforeThreadCpu);
  loop.disable();
  await nextTurn();
  const captureCounts = { ...probe };
  const measuredRequests = requests;
  const measuredContinuations = continuations;
  const measuredWireBytes = wireBytes;
  assert.equal(measuredRequests, sessions * turns);
  assert.equal(measuredContinuations, sessions * (turns - 1));
  // Replay verification uses fresh captures after timing, outside all measured intervals.
  await runWithAiTransportHost(host, () => populate(1, true));
  const operations = sessions * turns;
  const result = {
    protocol: "session-fork-capture-v1",
    node: process.version,
    ownerSha256: createHash("sha256").update(ownerSource).digest("hex"),
    immutableDataSha256: createHash("sha256").update(immutableSource).digest("hex"),
    counts: values.counts,
    sessions,
    turns,
    history,
    messageBytes,
    unicode: values.unicode,
    operations,
    captures: values.counts ? captureCounts : undefined,
    requests: measuredRequests,
    continuations: measuredContinuations,
    wireBytes: measuredWireBytes,
    wireBytesPerTurn: measuredWireBytes / operations,
    captureJsonBytesPerTurn: values.counts ? captureCounts.stringifyBytes / operations : undefined,
    captureV8BytesPerTurn: values.counts ? captureCounts.serializedBytes / operations : undefined,
    durationMs: end - begin,
    cpuUsPerTurn: (cpu.user + cpu.system) / operations,
    threadCpuUsPerTurn: (threadCpu.user + threadCpu.system) / operations,
    gc: distribution(collections.map((row) => row.ms)),
    gcMsPerTurn: collections.reduce((sum, row) => sum + row.ms, 0) / operations,
    minorGc: distribution(
      collections
        .filter((row) => row.kind === constants.NODE_PERFORMANCE_GC_MINOR)
        .map((row) => row.ms),
    ),
    majorGc: distribution(
      collections
        .filter((row) => row.kind === constants.NODE_PERFORMANCE_GC_MAJOR)
        .map((row) => row.ms),
    ),
    loop: {
      samples: loop.count,
      p95Ms: loop.percentile(95) / 1e6,
      p99Ms: loop.percentile(99) / 1e6,
      maxMs: loop.max / 1e6,
    },
    forkChecks,
    scope:
      "real fork and Responses transport owners with loopback HTTP; no Gateway or live provider",
  };
  if (values.output) {
    fs.writeFileSync(path.resolve(values.output), `${stringify(result, null, 2)}\n`);
  }
  console.log(stringify(result));
} finally {
  cleanupSessionResources(undefined, host);
  observer.disconnect();
  hooks.deregister();
  Reflect.deleteProperty(globalThis, probeKey);
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server.closeAllConnections();
  await closed;
}
