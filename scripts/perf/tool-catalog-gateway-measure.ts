/**
 * Real Gateway dispatch with a deterministic loopback model; no live-provider claim.
 * node --import ./scripts/tsx.mjs scripts/perf/tool-catalog-gateway-measure.ts
 *   --state-dir <new-owned-directory> --output <report.json> [--full] [--reuse]
 * --source-dir selects the six frozen catalog owner modules for paired baseline runs.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { transformSync } from "esbuild";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { applyMockOpenAiModelConfig } from "../e2e/lib/fixtures/mock-openai-config.mjs";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { buildGatewayBenchChildArgs, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { generateTeamShapeFixture, parseTeamShapeOptions } from "./team-shape-fixture.ts";

if (process.env.OPENCLAW_BENCH_CATALOG_OBSERVER === "1") {
  const sourceDir = process.env.OPENCLAW_BENCH_CATALOG_SOURCE;
  if (sourceDir) {
    const sources = new Map<string, string>();
    for (const file of [
      "tool-search-catalog.ts",
      "tool-search-directory.ts",
      "tool-search-runtime.ts",
      "code-mode.ts",
      "code-mode-execution.ts",
      "code-mode-headless.ts",
    ]) {
      sources.set(
        new URL(`../../src/agents/${file}`, import.meta.url).href,
        readFileSync(path.join(sourceDir, file), "utf8"),
      );
    }
    registerHooks({
      load(url, context, next) {
        const source = sources.get(url);
        return source === undefined
          ? next(url, context)
          : {
              format: "module",
              source: transformSync(source, { loader: "ts", format: "esm" }).code,
              shortCircuit: true,
            };
      },
    });
  }
  const preparedUrl = new URL("../../src/agents/tool-search-prepared-catalog.ts", import.meta.url)
    .href;
  const preparedSource = readFileSync(new URL(preparedUrl), "utf8")
    .replace(
      "const preparedCatalogs =",
      "let previousProbeInput: unknown[] = [];\nconst preparedCatalogs =",
    )
    .replace(
      "const cached = key === undefined",
      `console.log("CATALOG_INPUT " + JSON.stringify({ tools: entries.length, shareable, schemaChars, keyChars: key?.length, hit: key !== undefined && preparedCatalogs.has(key), changed: encoded.flatMap((row, i) => JSON.stringify(row) === JSON.stringify(previousProbeInput[i]) ? [] : [{ id: row.descriptor[0], fields: Object.keys(row).filter(k => JSON.stringify(Reflect.get(row, k)) !== JSON.stringify(Reflect.get(previousProbeInput[i] ?? {}, k))) }]) })); previousProbeInput = encoded;\n  const cached = key === undefined`,
    );
  registerHooks({
    load(url, context, next) {
      return url === preparedUrl
        ? {
            format: "module",
            source: transformSync(preparedSource, { loader: "ts", format: "esm" }).code,
            shortCircuit: true,
          }
        : next(url, context);
    },
  });
  const attemptUrl = new URL(
    "../../src/agents/embedded-agent-runner/run/attempt-tool-catalog.ts",
    import.meta.url,
  ).href;
  const attemptSource = readFileSync(new URL(attemptUrl), "utf8").replace(
    "  let pinToolListing:",
    `  console.log("CATALOG_PROBE " + JSON.stringify({ type: "run.attempt", runId: input.attempt.runId, sessionKey: input.attempt.sessionKey, model: input.attempt.modelId }));\n  let pinToolListing:`,
  );
  registerHooks({
    load(url, context, next) {
      return url === attemptUrl
        ? {
            format: "module",
            source: transformSync(attemptSource, { loader: "ts", format: "esm" }).code,
            shortCircuit: true,
          }
        : next(url, context);
    },
  });
  const { onTrustedInternalDiagnosticEvent } = await import("../../src/infra/diagnostic-events.ts");
  onTrustedInternalDiagnosticEvent(
    (event) => {
      // The workload is synthetic. Only lifecycle/count metadata leaves the child.
      if (
        ["tool.catalog", "run.attempt", "session.turn.created", "model.failover"].includes(
          event.type,
        )
      ) {
        console.log(`CATALOG_PROBE ${JSON.stringify(event)}`);
      }
    },
    { include: ["tool.catalog", "run.attempt", "session.turn.created", "model.failover"] },
  );
} else {
  await main();
}

async function main() {
  const { values } = parseArgs({
    options: {
      "state-dir": { type: "string" },
      output: { type: "string" },
      full: { type: "boolean" },
      reuse: { type: "boolean" },
      "source-dir": { type: "string" },
      port: { type: "string", default: "43845" },
    },
  });
  assert(values["state-dir"] && values.output);
  const root = path.resolve(values["state-dir"]);
  const output = path.resolve(values.output);
  const port = Number(values.port);
  assert(Number.isInteger(port) && port >= 40000 && port < 65534);
  const configPath = path.join(root, "openclaw.json");
  const marker = path.join(root, "catalog-fixture.json");
  let env: NodeJS.ProcessEnv;
  let fixture: Awaited<ReturnType<typeof generateTeamShapeFixture>>["summary"];
  if (values.reuse) {
    assert(existsSync(marker), "Reuse only this harness's fixture");
    fixture = JSON.parse(readFileSync(marker, "utf8"));
    env = {
      ...createGatewayBenchEnv(path.join(root, "home"), configPath, { startupTrace: false }),
      OPENCLAW_STATE_DIR: root,
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
    env = generated.env;
    fixture = generated.summary;
    writeFileSync(marker, JSON.stringify(fixture));
  }
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const workspace = fixture.projectWorktrees[0]?.path;
  if (workspace) {
    config.agents.entries.main.workspace = workspace;
  }
  applyMockOpenAiModelConfig(config, { mockPort: port + 1, modelRef: "openai/catalog-primary" });
  config.models.providers.openai.api = "openai-completions";
  const model = config.models.providers.openai.models[0];
  model.api = "openai-completions";
  config.models.providers.openai.models.push({
    ...model,
    id: "catalog-secondary",
    name: "Synthetic fallback",
  });
  config.agents.defaults.model = {
    primary: "openai/catalog-primary",
    fallbacks: ["openai/catalog-secondary"],
  };
  config.agents.defaults.models = { "openai/catalog-primary": {}, "openai/catalog-secondary": {} };
  config.agents.entries.main.model = config.agents.defaults.model;
  config.agents.entries.main.models["openai/catalog-secondary"] =
    config.agents.entries.main.models["openai/catalog-primary"];
  config.plugins = { enabled: true, allow: ["openai"] };
  config.tools = { codeMode: { enabled: true, executor: "node" } };
  config.session = { ...config.session, maintenance: { maxEntries: 20000 } };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  const campaign = `CATALOG_${randomUUID()}`;
  const requests: Array<{ scenario: string; model: string; tools: number }> = [];
  const issued = new Set<string>();
  const provider = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const text = body.messages
        .filter((m: { role: string }) => m.role === "user")
        .map((m: { content: unknown }) => JSON.stringify(m.content))
        .join("\n");
      const requestMarker = [
        ...text.matchAll(
          new RegExp(`${campaign}_(interactive|spawn|child|cron|fallback)_([a-f0-9-]+)`, "g"),
        ),
      ].at(-1);
      const scenario = requestMarker?.[1] ?? "utility";
      const token = requestMarker?.[0] ?? "utility";
      requests.push({ scenario, model: body.model, tools: body.tools?.length ?? 0 });
      if (scenario === "fallback" && body.model === "catalog-primary") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "The model catalog-primary is not available",
              type: "invalid_request_error",
              code: "model_not_found",
            },
          }),
        );
        return;
      }
      const hasExec = body.tools?.some(
        (t: { function?: { name?: string } }) => t.function?.name === "exec",
      );
      const call = hasExec && scenario !== "utility" && !issued.has(token);
      issued.add(token);
      const code =
        scenario === "spawn"
          ? `return await sessions_spawn(${JSON.stringify({ task: `${campaign}_child_${randomUUID()}`, agentId: "main", runtime: "subagent", mode: "run", context: "isolated", cleanup: "keep", completionTarget: "parent", runTimeoutSeconds: 120 })});`
          : 'return (await catalog.search("read", { limit: 1 })).length;';
      const delta = call
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${randomUUID()}`,
                type: "function",
                function: {
                  name: "exec",
                  arguments: JSON.stringify({
                    code,
                    title: "Synthetic catalog proof",
                    awaitResults: true,
                  }),
                },
              },
            ],
          }
        : { role: "assistant", content: "CATALOG_DONE" };
      const id = `chatcmpl-${randomUUID()}`;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const choice of [
        { index: 0, delta, finish_reason: null },
        { index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" },
      ]) {
        res.write(
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: body.model, choices: [choice] })}\n\n`,
        );
      }
      res.end("data: [DONE]\n\n");
    })().catch((error: unknown) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => {
    provider.listen(port + 1, "127.0.0.1", resolve);
  });
  const log = createWriteStream(output + ".gateway.log");
  const gateway = spawn(
    process.execPath,
    [
      "--import",
      new URL("../tsx.mjs", import.meta.url).href,
      "--import",
      import.meta.url,
      ...buildGatewayBenchChildArgs(path.resolve("src/entry.ts"), port),
    ],
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...env,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENAI_API_KEY: "synthetic-loopback-only",
        OPENCLAW_BENCH_CATALOG_OBSERVER: "1",
        ...(values["source-dir"]
          ? { OPENCLAW_BENCH_CATALOG_SOURCE: path.resolve(values["source-dir"]) }
          : {}),
      },
    },
  );
  let text = "";
  gateway.stdout!.on("data", (data: Buffer) => {
    text += data.toString();
  });
  gateway.stdout!.pipe(log, { end: false });
  gateway.stderr!.pipe(log, { end: false });
  let client: ReturnType<typeof createGatewayWsClient> | undefined;
  const records: unknown[] = [];
  async function rpc(method: string, params: unknown): Promise<unknown> {
    const response = await client!.request(method, params, 120000, { retryStartup: true });
    assert(response.ok, `${method}: ${JSON.stringify(response.error)}`);
    return response.payload;
  }
  try {
    const deadline = Date.now() + 300000;
    while (true) {
      assert(gateway.exitCode === null, "Gateway exited before ready");
      if (
        await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(500) }).then(
          (r) => r.ok,
          () => false,
        )
      ) {
        break;
      }
      assert(Date.now() < deadline, "Gateway readiness timed out");
      await delay(250);
    }
    client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
    await client.waitOpen();
    await rpc("connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        version: "1.0.0",
        platform: process.platform,
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
      caps: [],
    });
    for (const scenario of ["interactive", "interactive", "spawn", "fallback"] as const) {
      const runId = randomUUID();
      const sessionKey = `agent:main:dashboard:${randomUUID()}`;
      const before = text.length;
      const started = performance.now();
      await rpc("chat.send", {
        sessionKey,
        message: `${campaign}_${scenario}_${randomUUID()}`,
        idempotencyKey: runId,
      });
      const result = await rpc("agent.wait", { runId, timeoutMs: 110000 });
      assert(isRecord(result) && result.status === "ok", `${scenario}: ${JSON.stringify(result)}`);
      if (scenario === "fallback") {
        assert(isRecord(result.terminalReceipt) && result.terminalReceipt.rerouted === true);
      }
      await delay(100);
      records.push({
        scenario,
        runId,
        result,
        elapsedMs: performance.now() - started,
        events: parseEvents(text.slice(before)),
      });
      console.log(JSON.stringify(records.at(-1)));
    }
    const before = text.length;
    const job = await rpc("cron.add", {
      name: "Synthetic catalog cron",
      enabled: false,
      schedule: { kind: "every", everyMs: 3600000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: `${campaign}_cron_${randomUUID()}` },
      delivery: { mode: "none" },
    });
    assert(isRecord(job) && typeof job.id === "string");
    const result = await rpc("cron.run", { id: job.id, mode: "force" });
    const cronDeadline = Date.now() + 120000;
    let history;
    do {
      history = await rpc("cron.runs", { id: job.id, limit: 1 });
      if (isRecord(history) && Array.isArray(history.entries) && history.entries.length) {
        break;
      }
      await delay(500);
    } while (Date.now() < cronDeadline);
    assert(
      isRecord(history) && Array.isArray(history.entries) && history.entries.length > 0,
      "Cron did not finish",
    );
    assert(
      isRecord(history.entries[0]) && history.entries[0].status === "ok",
      `Cron failed: ${JSON.stringify(history)}`,
    );
    assert(
      requests.some((request) => request.scenario === "child"),
      "Spawn did not reach the child model",
    );
    records.push({ scenario: "cron", result, history, events: parseEvents(text.slice(before)) });
    writeFileSync(
      output,
      JSON.stringify({ fixture, records, requests, events: parseEvents(text) }, null, 2),
    );
  } finally {
    client?.close();
    await stopChild(gateway, { teardownGraceMs: 10000 });
    provider.closeAllConnections();
    await new Promise<void>((resolve) => {
      provider.close(() => resolve());
    });
    log.end();
  }
}
function parseEvents(text: string) {
  return text
    .split("\n")
    .filter((line) => line.includes("CATALOG_PROBE "))
    .map((line) =>
      JSON.parse(line.slice(line.indexOf("CATALOG_PROBE ") + "CATALOG_PROBE ".length)),
    );
}
