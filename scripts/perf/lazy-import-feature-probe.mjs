import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";

// Run each mode in a fresh process; traced counts and untraced latency need separate runs.
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: "string" },
    iterations: { type: "string", default: "20" },
    "barrier-dir": { type: "string" },
    side: { type: "string" },
    help: { type: "boolean" },
    "expect-single-load": { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "Usage: node --import ./scripts/tsx.mjs scripts/perf/lazy-import-feature-probe.mjs <mcp|config|public|parser> [--output result.json] [--iterations N] [--barrier-dir DIR --side a|b] [--expect-single-load]\nFor import counts, also load scripts/perf/lazy-import-trace-preload.mjs with OPENCLAW_LAZY_IMPORT_TRACE_DIR set. Each path defaults to 20 operations. --expect-single-load requires tracing and rejects repeated imports/evaluations after first use.",
  );
  process.exit(0);
}
const [mode] = positionals;
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations >= 2, "--iterations must be an integer >= 2");
if (values.side !== undefined) {
  assert(values.side === "a" || values.side === "b", "--side must be a or b");
}
const barrierDir = values["barrier-dir"] ? path.resolve(values["barrier-dir"]) : undefined;
if (barrierDir) {
  assert(values.side, "--side is required with --barrier-dir");
  await fs.mkdir(barrierDir, { recursive: true });
}
assert(
  ["mcp", "config", "public", "parser"].includes(mode),
  "mode: mcp | config | public | parser",
);
const trace = globalThis[Symbol.for("openclaw.lazy-import-trace")];
if (values["expect-single-load"]) {
  assert(trace, "--expect-single-load requires the trace preload");
}
const output = path.resolve(values.output ?? `.local/lazy-import-feature-${mode}.json`);
await fs.mkdir(path.dirname(output), { recursive: true });
const stateRoot = await fs.mkdtemp(path.join(path.dirname(output), ".lazy-import-feature-state-"));
for (const [key, value] of Object.entries({
  HOME: path.join(stateRoot, "home"),
  USERPROFILE: path.join(stateRoot, "home"),
  OPENCLAW_HOME: path.join(stateRoot, "home"),
  OPENCLAW_STATE_DIR: path.join(stateRoot, "state"),
  OPENCLAW_CONFIG_PATH: path.join(stateRoot, "openclaw.json"),
  OPENCLAW_AGENT_DIR: path.join(stateRoot, "state/agents/main/agent"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  TMPDIR: stateRoot,
  HTTP_PROXY: "",
  HTTPS_PROXY: "",
  ALL_PROXY: "",
  http_proxy: "",
  https_proxy: "",
  all_proxy: "",
})) {
  process.env[key] = value;
}
await fs.mkdir(process.env.HOME, { recursive: true });
await fs.mkdir(process.env.OPENCLAW_STATE_DIR, { recursive: true });
await fs.writeFile(
  process.env.OPENCLAW_CONFIG_PATH,
  JSON.stringify({ plugins: { enabled: false } }),
);
const phase = (value) => {
  if (trace) {
    trace.phase = value;
  }
};
phase(`${mode}-setup`);
const operations = [];
async function waitForSteadyStart(name, directory) {
  const deadline = performance.now() + 120_000;
  await fs.writeFile(path.join(directory, `${name}-${values.side}.ready`), "", { flag: "wx" });
  let start;
  while (start === undefined) {
    assert(performance.now() < deadline, `${name} barrier timed out`);
    try {
      start = Number(await fs.readFile(path.join(directory, `${name}.start`), "utf8"));
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
      await delay(25);
    }
  }
  assert(
    Number.isSafeInteger(start) && start > Date.now(),
    `${name} start must be a future epoch ms`,
  );
  while (Date.now() < start) {
    assert(performance.now() < deadline, `${name} barrier timed out`);
    await delay(Math.min(25, start - Date.now()));
  }
}
async function measure(name, iteration, run) {
  if (barrierDir && iteration === 2) {
    await waitForSteadyStart(name, barrierDir);
  }
  phase(`${name}-${iteration}`);
  const before = trace?.events.length ?? 0;
  const started = performance.now();
  const evidence = await run();
  const ms = performance.now() - started;
  const events = trace?.events.slice(before) ?? [];
  operations.push({
    name,
    iteration,
    ms,
    evidence,
    imports: events.filter((e) => e.kind === "import").length,
    evaluations: events.filter((e) => e.kind === "evaluate").length,
  });
  if (values["expect-single-load"] && iteration > 1) {
    assert.equal(events.length, 0, `${name}-${iteration} repeated a lazy import or evaluation`);
  }
}
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await promisify(server.close.bind(server))();
}
async function runMcp() {
  const { createSessionMcpRuntime } = await import("../../src/agents/agent-bundle-mcp-runtime.ts");
  const counts = {};
  const server = http.createServer(
    (request, response) =>
      void (async () => {
        if (request.method !== "POST") {
          response.writeHead(405).end();
          return;
        }
        const chunks = [];
        for await (const chunk of request) {
          chunks.push(chunk);
        }
        const message = JSON.parse(Buffer.concat(chunks).toString());
        counts[message.method] = (counts[message.method] ?? 0) + 1;
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "synthetic-feature-probe", version: "1" },
              }
            : message.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "echo",
                      inputSchema: { type: "object", properties: { value: { type: "string" } } },
                    },
                  ],
                }
              : { content: [{ type: "text", text: message.params.arguments.value }] };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      })().catch(
        /** @param {unknown} error */ (error) => {
          console.error(error);
          response.destroy();
        },
      ),
  );
  const origin = await listen(server);
  const runtimeOptions = {
    workspaceDir: stateRoot,
    cfg: {
      plugins: { enabled: false },
      mcp: { servers: { probe: { transport: "streamable-http", url: `${origin}/mcp` } } },
    },
    manifestRegistry: { plugins: [] },
  };
  const runtime = createSessionMcpRuntime({
    ...runtimeOptions,
    sessionId: "synthetic-feature-probe",
  });
  try {
    for (let i = 1; i <= iterations; i++) {
      await measure("mcp-catalog", i, async () => {
        const catalog = await runtime.getCatalog();
        assert.deepEqual(
          catalog.tools.map((tool) => tool.toolName),
          ["echo"],
          JSON.stringify(catalog.diagnostics),
        );
        return { tools: catalog.tools.length };
      });
    }
    for (let i = 1; i <= iterations; i++) {
      await measure("mcp-call", i, async () => {
        const value = `synthetic-${i}`;
        const result = await runtime.callTool("probe", "echo", { value });
        assert.deepEqual(result.content, [{ type: "text", text: value }]);
        return { echoed: true };
      });
    }
    for (let i = 1; i <= iterations; i++) {
      await measure("mcp-fresh-session", i, async () => {
        const freshRuntime = createSessionMcpRuntime({
          ...runtimeOptions,
          sessionId: `synthetic-feature-probe-fresh-${i}`,
        });
        try {
          const catalog = await freshRuntime.getCatalog();
          assert.deepEqual(
            catalog.tools.map((tool) => tool.toolName),
            ["echo"],
            JSON.stringify(catalog.diagnostics),
          );
          return { tools: catalog.tools.length };
        } finally {
          await freshRuntime.dispose();
          await freshRuntime.joinCleanup?.();
        }
      });
    }
    assert.equal(counts.initialize, iterations + 1);
    assert.equal(counts["tools/list"], iterations + 1);
    assert.equal(counts["tools/call"], iterations);
    return { transport: "real loopback HTTP; production guarded transport", wireRequests: counts };
  } finally {
    phase("mcp-cleanup");
    await runtime.dispose();
    await runtime.joinCleanup?.();
    await close(server);
  }
}
async function runConfig() {
  const { createConfigIoContext } = await import("../../src/config/io.context.ts");
  const { readConfigFileSnapshotFromContext } = await import("../../src/config/io.snapshot.ts");
  const config = {
    plugins: { enabled: false },
    nodeHost: { browserProxy: { enabled: "invalid" } },
  };
  await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
  const context = createConfigIoContext({
    configPath: process.env.OPENCLAW_CONFIG_PATH,
    env: { ...process.env },
    homedir: () => process.env.HOME,
    observe: false,
    pluginValidation: "full",
    shellEnvFallback: "defer",
  });
  let expected;
  for (let i = 1; i <= iterations; i++) {
    await measure("config-invalid-snapshot", i, async () => {
      const snapshot = await readConfigFileSnapshotFromContext(context);
      assert.equal(snapshot.valid, false);
      assert(
        snapshot.issues.some((issue) => issue.path === "nodeHost.browserProxy.enabled"),
        JSON.stringify(snapshot.issues),
      );
      const evidence = {
        issues: snapshot.issues.map(({ path: issuePath, message }) => ({
          path: issuePath,
          message,
        })),
        legacyIssues: snapshot.legacyIssues,
      };
      if (expected) {
        assert.deepEqual(evidence, expected);
      } else {
        expected = evidence;
      }
      return evidence;
    });
  }
  return { validation: "full, invalid nonlegacy property, plugins disabled, observe false" };
}
async function runPublic() {
  const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.ts");
  const { upsertSessionEntryCore } = await import("../../src/config/sessions/session-accessor.ts");
  const { replaceTranscriptEvents } =
    await import("../../src/config/sessions/session-accessor.sqlite-transcript-write.test-support.ts");
  const { createSessionRowProjection } =
    await import("../../src/gateway/session-row-projection.ts");
  const { bindSessionRowProjection } =
    await import("../../src/gateway/session-row-projection-access.ts");
  const { loadPublicSessionShareTokenCodec } =
    await import("../../src/gateway/control-ui-public-session-token.ts");
  const { createControlUiSessionRoutes } =
    await import("../../src/gateway/control-ui-session-routes.ts");
  const { prepareGatewayIngressAttribution } =
    await import("../../src/gateway/ingress-attribution.ts");
  const cfg = { plugins: { enabled: false }, agents: { entries: { main: {} } } };
  setRuntimeConfigSnapshot(cfg);
  const locator = {
    agentId: "main",
    sessionKey: "agent:main:synthetic-feature-probe",
    sessionId: "synthetic-feature-probe-generation",
    shareId: "a".repeat(48),
  };
  await upsertSessionEntryCore(locator, {
    sessionId: locator.sessionId,
    updatedAt: 1,
    label: "Synthetic public probe",
    publicShare: { id: locator.shareId, sessionId: locator.sessionId, createdAt: 1 },
  });
  await replaceTranscriptEvents(locator, [
    { type: "session", version: 3, id: locator.sessionId },
    {
      type: "message",
      id: "question",
      parentId: null,
      message: { role: "user", content: "Synthetic question" },
    },
    {
      type: "message",
      id: "answer",
      parentId: "question",
      message: { role: "assistant", content: "Synthetic published answer" },
    },
  ]);
  const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
  await projection.ensureMaterialized();
  const context = bindSessionRowProjection({}, () => projection);
  const routes = createControlUiSessionRoutes({
    controlUiBasePath: "",
    getGatewayRequestContext: () => context,
  });
  const token = (await loadPublicSessionShareTokenCodec()).mint(locator);
  const route = `/share/session?token=${encodeURIComponent(token)}`;
  const server = http.createServer(
    (req, res) =>
      void (async () => {
        assert(routes.matches(new URL(req.url, "http://localhost").pathname, req.url));
        const ingress = prepareGatewayIngressAttribution({ req, trustedProxies: [] });
        assert.equal(ingress.kind, "direct-local");
        await routes.serve({
          req,
          res,
          config: cfg,
          ingress,
          auth: { mode: "token", token: "synthetic-probe-auth", allowTailscale: false },
          getRuntimeConfig: () => cfg,
        });
      })().catch(
        /** @param {unknown} error */ (error) => {
          console.error(error);
          res.destroy();
        },
      ),
  );
  const origin = await listen(server);
  let expectedBody, expectedEtag;
  try {
    for (let i = 1; i <= iterations; i++) {
      await measure("public-session-get", i, async () => {
        const response = await fetch(`${origin}${route}`);
        const body = await response.text();
        assert.equal(response.status, 200, body);
        assert(body.includes("Synthetic published answer"));
        const etag = response.headers.get("etag");
        assert(etag);
        if (expectedBody) {
          assert.equal(body, expectedBody);
          assert.equal(etag, expectedEtag);
        } else {
          expectedBody = body;
          expectedEtag = etag;
        }
        return { status: response.status, bytes: Buffer.byteLength(body), stableEtag: true };
      });
    }
    await measure("public-session-conditional", 1, async () => {
      const response = await fetch(`${origin}${route}`, {
        headers: { "If-None-Match": expectedEtag },
      });
      assert.equal(response.status, 304);
      assert.equal(await response.text(), "");
      return { status: 304 };
    });
    return {
      transport:
        "real loopback HTTP; production public route, token, projection, read, render and cache owners",
    };
  } finally {
    phase("public-cleanup");
    routes.dispose();
    await close(server);
    projection.dispose();
  }
}
async function runParser() {
  const { processCompletionsStream } =
    await import("../../packages/ai/src/transports/openai-completions-stream.ts");
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const model = {
    id: "synthetic-probe",
    name: "Synthetic",
    api: "openai-completions",
    provider: "openai",
    baseUrl: "http://127.0.0.1:44999/v1",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 1024,
    cost,
  };
  for (let i = 1; i <= iterations; i++) {
    await measure("parser-stream", i, async () => {
      const assistantOutput = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { ...cost, totalTokens: 0, cost: { ...cost, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      async function* chunks() {
        for (const content of ["<thi", "nk>hidden</think>", "visible", undefined]) {
          yield {
            id: "synthetic",
            object: "chat.completion.chunk",
            created: 1,
            model: model.id,
            choices: [
              {
                index: 0,
                delta: content ? { content } : {},
                finish_reason: content ? null : "stop",
              },
            ],
          };
        }
      }
      await processCompletionsStream(
        chunks(),
        assistantOutput,
        model,
        { push() {} },
        { emitReasoning: false },
      );
      assert.equal(
        assistantOutput.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join(""),
        "visible",
      );
      assert(!JSON.stringify(assistantOutput.content).includes("hidden"));
      return { text: "visible", hiddenReasoningRemoved: true };
    });
  }
  return {
    stream:
      "deterministic in-process chunks through production completion-stream parsing; no provider request",
  };
}
let result;
try {
  const evidence = await { mcp: runMcp, config: runConfig, public: runPublic, parser: runParser }[
    mode
  ]();
  if (values["expect-single-load"]) {
    assert(
      operations.some((operation) => operation.imports > 0),
      "No first-use lazy import was observed; instrumentation did not exercise the boundary",
    );
  }
  result = {
    mode,
    instrumented: Boolean(trace),
    pid: process.pid,
    node: process.version,
    iterations,
    evidence,
    operations,
    traceEvents: trace?.events ?? [],
  };
} finally {
  phase(`${mode}-cleanup`);
  if (mode !== "parser") {
    const { cleanupSessionStateForTest } =
      await import("../../src/test-utils/session-state-cleanup.ts");
    await cleanupSessionStateForTest({
      stateDir: process.env.OPENCLAW_STATE_DIR,
      rootPath: stateRoot,
    });
  }
  await fs.rm(stateRoot, { recursive: true, force: true });
}
await fs.writeFile(output, JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({ output, mode, operations: operations.length, firstMs: operations[0]?.ms }),
);
