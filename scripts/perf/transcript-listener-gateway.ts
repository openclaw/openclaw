/**
 * Synthetic real-Gateway lifecycle soak. No credentials or operator state.
 * node --import ./scripts/tsx.mjs scripts/perf/transcript-listener-gateway.ts
 *   --output .local/listener-candidate --runs 200 [--cleanup-fail-every 5]
 * Baseline: --baseline-dir <directory containing exact baseline source files>.
 * Sampling is opt-in; compare instrumented allocations separately from timing.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  cpSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { OpenClawConfig } from "../../src/config/types.openclaw.ts";
import { buildMockOpenAiResponsesProvider } from "../../src/gateway/test-openai-responses-model.ts";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import {
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  waitForInitialProbe,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { generateTeamShapeFixture, parseTeamShapeOptions } from "./team-shape-fixture.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    runs: { type: "string", default: "200" },
    sessions: { type: "string", default: "4000" },
    "transcript-mib": { type: "string", default: "64" },
    "baseline-dir": { type: "string" },
    "state-fixture": { type: "string" },
    "cleanup-fail-every": { type: "string", default: "0" },
    allocations: { type: "boolean", default: false },
    "expect-released": { type: "boolean", default: false },
    "settle-ms": { type: "string", default: "100" },
    snapshot: { type: "boolean", default: false },
  },
});
assert(values.output, "--output must name a new task-owned directory");
const output = path.resolve(values.output);
mkdirSync(output);
const runs = Number(values.runs);
assert(Number.isSafeInteger(runs) && runs > 0);
const settleMs = Number(values["settle-ms"]);
assert(Number.isSafeInteger(settleMs) && settleMs >= 0);
const port = await getFreePort();
let mode = "success";
const providerProgress = { requests: 0 };
const held = new Set<ServerResponse>();
const providerServer = createServer((request, response) => {
  void (async () => {
    for await (const chunk of request) {
      /* Drain request before responding. */
      void chunk;
    }
    providerProgress.requests++;
    if (mode === "abort") {
      held.add(response);
      response.once("close", () => held.delete(response));
      return;
    }
    if (mode === "failure") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "Synthetic provider failure", type: "invalid_request_error" },
        }),
      );
      return;
    }
    writeOpenAiResponsesText(response, {
      text: "Synthetic completed turn.",
      messageId: randomUUID(),
      responseId: randomUUID(),
    });
  })().catch((error: unknown) =>
    response.destroy(error instanceof Error ? error : new Error(String(error))),
  );
});
await new Promise<void>((resolve) => {
  providerServer.listen(0, "127.0.0.1", resolve);
});
const address = providerServer.address();
assert(address && typeof address !== "string");
const provider = buildMockOpenAiResponsesProvider(
  `http://127.0.0.1:${address.port}/v1`,
  "synthetic-model",
);
const stateDir = path.join(output, "state");
const configPath = path.join(stateDir, "openclaw.json");
const fixture = values["state-fixture"] && path.resolve(values["state-fixture"]);
if (fixture) {
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(fixture, "team-shape-summary.json"), "utf8"),
  );
  assert(
    isRecord(manifest) && manifest.format === "openclaw-team-shape-v1",
    "Expected an offline synthetic fixture",
  );
  cpSync(fixture, stateDir, {
    recursive: true,
    errorOnExist: true,
    force: false,
    mode: constants.COPYFILE_FICLONE,
  });
}
const { summary, env } = fixture
  ? {
      summary: JSON.parse(
        readFileSync(path.join(stateDir, "team-shape-summary.json"), "utf8"),
      ) as unknown,
      env: createGatewayBenchEnv(path.join(stateDir, "home"), configPath, {
        startupTrace: false,
        caseEnv: {
          OPENCLAW_STATE_DIR: stateDir,
          TMPDIR: path.join(stateDir, "tmp"),
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_PROFILE: `listener-${port}`,
          OPENCLAW_LAUNCHD_LABEL: `ai.openclaw.listener-${port}`,
          OPENCLAW_SYSTEMD_UNIT: `openclaw-gateway-listener-${port}`,
          OPENCLAW_WINDOWS_TASK_NAME: `OpenClaw Listener ${port}`,
        },
      }),
    }
  : await generateTeamShapeFixture(
      parseTeamShapeOptions([
        "--state-dir",
        path.join(output, "state"),
        "--port",
        String(port),
        "--now",
        String(Date.now()),
        "--sessions",
        values.sessions!,
        "--transcript-mib",
        values["transcript-mib"]!,
        "--runs",
        "0",
        "--approvals",
        "0",
        "--cron",
        "0",
        "--projects",
        "0",
      ]),
    );
const config: OpenClawConfig = JSON.parse(readFileSync(configPath, "utf8"));
config.agents!.defaults = {
  ...config.agents!.defaults,
  skipBootstrap: true,
  model: { primary: provider.modelRef },
  modelPolicy: { allow: [provider.modelRef] },
  models: {
    [provider.modelRef]: { agentRuntime: { id: "openclaw" }, params: { transport: "sse" } },
  },
  thinkingDefault: "off",
  timeoutSeconds: 30,
};
config.models = { providers: { [provider.providerId]: provider.config } };
config.tools = { allow: [], codeMode: { enabled: false }, toolSearch: false };
config.skills = { load: { watch: false } };
config.logging = { ...config.logging, file: path.join(stateDir, "gateway.log") };
if (
  fixture &&
  isRecord(summary) &&
  typeof summary.worktreeFiles === "number" &&
  summary.worktreeFiles > 0
) {
  config.agents!.entries!.main!.workspace = path.join(
    stateDir,
    "fixture-worktrees",
    "team-shape-project-0",
  );
  execFileSync(
    "git",
    [
      "-C",
      path.join(stateDir, "fixture-projects", "team-shape-project-0"),
      "worktree",
      "repair",
      config.agents!.entries!.main!.workspace,
    ],
    { env, stdio: "pipe" },
  );
}
writeFileSync(configPath, JSON.stringify(config, null, 2));
const log = openSync(path.join(output, "gateway.log"), "w");
const gateway = spawn(
  process.execPath,
  buildGatewayBenchChildArgs("scripts/perf/transcript-listener-entry.ts", port, [
    "--expose-gc",
    "--import",
    "./scripts/tsx.mjs",
  ]),
  {
    env: {
      ...env,
      OPENCLAW_LISTENER_BASELINE: values["baseline-dir"]
        ? path.resolve(values["baseline-dir"])
        : "",
      OPENCLAW_LISTENER_FAIL_EVERY: values["cleanup-fail-every"],
      OPENCLAW_LISTENER_ALLOCATIONS: values.allocations ? "1" : "0",
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", log, log, "ipc"],
  },
);
closeSync(log);
let client: ReturnType<typeof createGatewayWsClient> | undefined;
const captures: Array<{
  completed: number;
  listeners: number;
  managers: number;
  sessions: number;
  heapUsed: number;
}> = [];
const turns: unknown[] = [];
const hostLoad = loadavg();
let failure: Error | undefined;
async function capture(completed: number) {
  const id = randomUUID();
  const captured = await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      gateway.off("message", receive);
      reject(new Error("Heap capture timed out"));
    }, 120_000);
    const receive = (message: unknown) => {
      if (isRecord(message) && message.id === id) {
        clearTimeout(timer);
        gateway.off("message", receive);
        resolve(message);
      }
    };
    gateway.on("message", receive);
    gateway.send({
      id,
      ...(values.snapshot && completed === runs
        ? { snapshot: path.join(output, "settled.heapsnapshot") }
        : {}),
    });
  });
  assert(isRecord(captured) && !captured.error, JSON.stringify(captured));
  assert(
    typeof captured.listeners === "number" &&
      typeof captured.managers === "number" &&
      typeof captured.sessions === "number" &&
      typeof captured.heapUsed === "number",
  );
  captures.push({
    completed,
    ...captured,
    listeners: captured.listeners,
    managers: captured.managers,
    sessions: captured.sessions,
    heapUsed: captured.heapUsed,
  });
  console.log(JSON.stringify({ completed, ...captured }));
}
try {
  const ready = await waitForInitialProbe({
    port,
    path: "/readyz",
    startAt: performance.now(),
    deadlineAt: performance.now() + 180_000,
    isDone: () => gateway.exitCode !== null || gateway.signalCode !== null,
  });
  assert.equal(ready.status, 200, "Gateway readiness failed; inspect gateway.log");
  client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
  await client.waitOpen();
  const rpc = async (method: string, params: unknown) => {
    const result = await client!.request(method, params, 120_000);
    assert(result.ok, `${method}: ${JSON.stringify(result.error)}`);
    assert(isRecord(result.payload), `${method} returned no object`);
    return result.payload;
  };
  await rpc("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: { id: "gateway-client", version: "1.0.0", platform: process.platform, mode: "backend" },
    role: "operator",
    scopes: ["operator.admin", "operator.read", "operator.write"],
    caps: [],
  });
  for (let index = -4; index < runs; index++) {
    mode = ["success", "abort", "failure", "success"][(index + 4) % 4]!;
    const key = `agent:main:listener-soak-${(index + 4) % 13}`;
    const beforeRequests = providerProgress.requests;
    const startedAt = performance.now();
    const sent = await rpc("chat.send", {
      sessionKey: key,
      message: `Synthetic lifecycle ${index}.`,
      deliver: false,
      idempotencyKey: randomUUID(),
    });
    assert.equal(typeof sent.runId, "string");
    if (mode === "abort") {
      const deadline = Date.now() + 60_000;
      while (providerProgress.requests === beforeRequests) {
        assert(Date.now() < deadline, "Abort never reached provider");
        await delay(10);
      }
      await rpc("chat.abort", { sessionKey: key, runId: sent.runId });
      for (const response of held) {
        response.destroy();
      }
    }
    const settled = await rpc("agent.wait", { runId: sent.runId, timeoutMs: 60_000 });
    assert.notEqual(settled.status, "timeout", JSON.stringify(settled));
    turns.push({ index, mode, terminal: settled.status, elapsedMs: performance.now() - startedAt });
    if (index === -1 || (index + 1) % 40 === 0 || index + 1 === runs) {
      await delay(settleMs);
      await capture(index + 1);
    }
  }
  if (values["expect-released"]) {
    const warm = captures[0]!;
    for (const sample of captures.slice(1)) {
      assert.equal(
        sample.listeners,
        warm.listeners,
        "Transcript listeners did not return to baseline",
      );
      assert.equal(sample.managers, warm.managers, "SessionManagers did not return to baseline");
      assert.equal(sample.sessions, warm.sessions, "AgentSessions did not return to baseline");
    }
    const firstActive = captures[1]!;
    assert(
      captures.at(-1)!.heapUsed <= firstActive.heapUsed * 1.1,
      "Post-warmup heap grew more than 10%",
    );
  }
} catch (error) {
  failure = error instanceof Error ? error : new Error("Synthetic soak failed", { cause: error });
} finally {
  client?.close();
  for (const response of held) {
    response.destroy();
  }
  await stopChild(gateway);
  providerServer.closeAllConnections();
  await new Promise<void>((resolve) => {
    providerServer.close(() => resolve());
  });
  writeFileSync(
    path.join(output, "results.json"),
    JSON.stringify(
      {
        summary,
        hostLoad,
        hostLoadEnd: loadavg(),
        runs,
        baseline: values["baseline-dir"],
        cleanupFailEvery: values["cleanup-fail-every"],
        allocations: values.allocations,
        settleMs,
        captures,
        turns,
        failure: failure?.message,
      },
      null,
      2,
    ),
  );
}
if (failure) {
  throw failure;
}
