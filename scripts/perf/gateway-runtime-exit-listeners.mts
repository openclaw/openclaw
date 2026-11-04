// Real built Gateway and live tool turns; isolated synthetic state only.
// After pnpm build: node --import ./scripts/tsx.mjs scripts/perf/gateway-runtime-exit-listeners.mts
// <fresh-output-dir> 8 --worktrees --diffs --assert [--profile] [--codex] [--entry dist/entry.js]
// Reuse synthetic teamBoot --team-scale --seed-only output with --fixture-root PATH;
// --observe-ms 0 profiles only active work after a separate 120-second recurrence proof.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { defaultMaxListeners } from "node:events";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { ProjectsRegisterResult } from "../../packages/gateway-protocol/src/schema/projects.js";
import type { SessionsCreateResult } from "../../packages/gateway-protocol/src/schema/sessions.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import type { AgentRunTerminalReceipt } from "../../src/agents/agent-run-terminal-receipt.js";
import type { AgentWaitResult } from "../../src/agents/run-wait.types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { configureLiveGatewayBenchmark, LIVE_GATEWAY_MODEL } from "../lib/gateway-bench-live.ts";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  waitForInitialProbe,
  writeGatewayBenchConfig,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";

type ExitTraceEvent = {
  type: string;
  pid: number;
  threadId: number;
  count: number;
  defaultLimit: number;
  limit: number;
  name?: string;
  stack?: string;
  phase?: string;
  listeners?: Array<{ name: string; stack?: string }>;
};
type TurnResult = AgentWaitResult & { terminalReceipt?: AgentRunTerminalReceipt };
type Evidence = {
  pid?: number;
  port: number;
  turns: Array<{
    index: number;
    agentId: string;
    sessionKey: string;
    ms: number;
    status: AgentWaitResult["status"];
    successfulToolNames?: string[];
    effective?: AgentRunTerminalReceipt["effective"];
    reply?: AgentWaitResult["terminalReply"];
    error?: string;
    receipt?: AgentRunTerminalReceipt;
  }>;
  output: string;
  fixtureRoot: string;
  observeMs: number;
  startedAt: string;
  finishedAt?: string;
  shutdown?: Awaited<ReturnType<typeof stopChild>>;
  traces?: Array<{ file: string; events: ExitTraceEvent[] }>;
  error?: string;
};

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    worktrees: { type: "boolean" },
    codex: { type: "boolean" },
    diffs: { type: "boolean" },
    assert: { type: "boolean" },
    entry: { type: "string", default: "dist/entry.js" },
    profile: { type: "boolean" },
    "fixture-root": { type: "string" },
    "observe-ms": { type: "string", default: "120000" },
  },
});
const output = path.resolve(positionals[0] ?? ".local/runtime-exit-listeners");
const turns = Number(positionals[1] ?? 8);
const entry = path.resolve(values.entry);
const observeMs = Number(values["observe-ms"]);
const runKey = randomUUID();
const worktrees = values.worktrees;
const codex = values.codex;
const diffs = values.diffs;
assert(
  Number.isSafeInteger(observeMs) && observeMs >= 0,
  "--observe-ms must be a nonnegative integer",
);
assert(Number.isSafeInteger(turns) && turns > 0, "Turns must be a positive integer");
assert(!worktrees || turns >= 6, "--worktrees requires at least six turns");
assert(!diffs || turns >= 5, "--diffs requires at least five turns");
assert(process.env.OPENAI_API_KEY, "Live provider key required");
mkdirSync(output, { recursive: true, mode: 0o700 });
const root = values["fixture-root"]
  ? path.resolve(values["fixture-root"])
  : path.join(output, "fixture");
let fixtureEntries: NonNullable<OpenClawConfig["agents"]>["entries"];
if (values["fixture-root"]) {
  assert(
    existsSync(path.join(root, "team-boot-fixture.json")),
    "--fixture-root requires a seeded teamBoot fixture",
  );
  const seeded = JSON.parse(
    readFileSync(path.join(root, "openclaw.json"), "utf8"),
  ) as OpenClawConfig;
  fixtureEntries = seeded.agents?.entries;
  assert(
    fixtureEntries && Object.keys(fixtureEntries).length >= 2,
    "Fixture must contain at least two agents",
  );
}
const traces = path.join(output, "traces");
mkdirSync(root, { recursive: true, mode: 0o700 });
mkdirSync(traces, { recursive: true });
const config: OpenClawConfig = structuredClone(BASE_GATEWAY_BENCH_CONFIG);
configureLiveGatewayBenchmark(config, root, 1);
assert(config.agents?.defaults && config.models?.providers?.openai);
const defaults = config.agents.defaults;
const provider = config.models.providers.openai;
defaults.skipBootstrap = true;
defaults.models = {
  [LIVE_GATEWAY_MODEL]: {
    agentRuntime: { id: "openclaw" },
    params: { transport: "sse", openaiWsWarmup: false, maxTokens: 2048 },
  },
};
const model = provider.models[0]!;
model.maxTokens = 2048;
config.agents.ownership = "explicit";
config.agents.entries = fixtureEntries ?? {
  plain: { workspace: path.join(root, "plain") },
  boxed: { workspace: path.join(root, "boxed") },
};
const [hostAgent, sandboxAgent] = Object.keys(config.agents.entries);
assert(hostAgent && sandboxAgent, "Host and sandbox agents configured");
defaults.systemAgent = { agentId: hostAgent };
config.agents.entries[hostAgent]!.sandbox = { mode: "off" };
config.agents.entries[sandboxAgent]!.sandbox = {
  mode: "all",
  backend: "docker",
  scope: "session",
  workspaceAccess: "rw",
  docker: { image: "openclaw-sandbox:trixie-slim" },
};
if (!fixtureEntries) {
  for (const id of [hostAgent, sandboxAgent]) {
    mkdirSync(path.join(root, id), { recursive: true });
    writeFileSync(
      path.join(root, id, "AGENTS.md"),
      "This is a synthetic lifecycle test workspace. Follow the user's requested shell command and return its exact output.\n",
    );
  }
}
config.plugins = {
  allow: ["openai"],
  entries: { "memory-core": { config: { dreaming: { enabled: false } } } },
};
config.secrets = { egressProxy: { enabled: true } };
config.tools = { profile: "coding", codeMode: false, exec: { security: "full", ask: "off" } };
config.memory = { search: { enabled: false } };
if (diffs) {
  config.plugins.allow!.push("diffs");
  config.plugins.entries!.diffs = { enabled: true };
  config.tools.alsoAllow = ["diffs"];
}
config.logging = { file: path.join(output, "gateway.jsonl"), level: "info" };
if (codex) {
  config.plugins.allow!.push("codex");
  config.plugins.load = { paths: [path.join(path.dirname(entry), "extensions/codex")] };
  config.plugins.entries!.codex = {
    enabled: true,
    config: {
      discovery: { enabled: false },
      appServer: {
        mode: "yolo",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        requestTimeoutMs: 290000,
      },
    },
  };
  config.agents.entries[hostAgent]!.nativeRuntimeConsent = ["codex"];
  defaults.models[LIVE_GATEWAY_MODEL] = { agentRuntime: { id: "codex" } };
  provider.agentRuntime = { id: "codex" };
  model.agentRuntime = { id: "codex" };
}
const port = await getFreePort();
const configPath = writeGatewayBenchConfig(output, config, {});
const preload = path.resolve("scripts/perf/gateway-runtime-exit-listeners-preload.mjs");
const log = createWriteStream(path.join(output, "gateway.log"));
const child = spawn(process.execPath, buildGatewayBenchChildArgs(entry, port), {
  env: {
    ...createGatewayBenchEnv(root, configPath, {}),
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    NODE_OPTIONS: `--trace-warnings --import=${preload}`,
    OPENCLAW_EXIT_LISTENER_TRACE_DIR: traces,
    OPENCLAW_EXIT_LISTENER_TRACE_ENTRY: entry,
    OPENCLAW_EXIT_LISTENER_PROFILE: values.profile ? "1" : undefined,
  },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  detached: true,
});
assert(child.stdout && child.stderr, "Gateway output pipes available");
child.stdout.pipe(log);
child.stderr.pipe(log);
const evidence: Evidence = {
  pid: child.pid,
  port,
  turns: [],
  output,
  fixtureRoot: root,
  observeMs,
  startedAt: new Date().toISOString(),
};
const gatewayStartedAt = performance.now();
let client: ReturnType<typeof createGatewayWsClient> | undefined;
const checkpoint = (phase: string) =>
  new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onMessage = (message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        "phase" in message &&
        message.type === "exit-listeners:checkpoint:ack" &&
        message.phase === phase
      ) {
        finish("error" in message ? new Error(String(message.error)) : undefined);
      }
    };
    const onExit = () => finish(new Error(`Gateway exited before checkpoint ${phase}`));
    const timer = setTimeout(() => finish(new Error(`Checkpoint ${phase} timed out`)), 15000);
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.send({ type: "exit-listeners:checkpoint", phase }, (error) => {
      if (error) {
        finish(error);
      }
    });
  });
const save = () =>
  writeFileSync(path.join(output, "result.json"), JSON.stringify(evidence, null, 2));
try {
  const ready = await waitForInitialProbe({
    port,
    path: "/readyz",
    startAt: performance.now(),
    deadlineAt: performance.now() + 300000,
    isDone: () => child.exitCode !== null || child.signalCode !== null,
  });
  assert.equal(ready.status, 200, "Gateway readiness");
  client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
  await client.waitOpen();
  const rpc = async <T = unknown,>(
    method: string,
    params: unknown,
    timeout = 300000,
  ): Promise<T> => {
    const response = await client!.request(method, params, timeout);
    assert(response.ok, `${method}: ${JSON.stringify(response.error)}`);
    return response.payload as T;
  };
  await rpc("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: "gateway-client",
      displayName: "exit-listener-proof",
      version: "1.0.0",
      platform: process.platform,
      mode: "backend",
    },
    role: "operator",
    scopes: ["operator.read", "operator.write", "operator.admin"],
    caps: ["tool-events"],
  });
  await checkpoint("ready");
  let project: ProjectsRegisterResult | undefined;
  for (let index = 0; index < turns; index++) {
    const sandboxed = index % 2 === 1;
    const agentId = sandboxed ? sandboxAgent : hostAgent;
    const sessionKey = `agent:${agentId}:exit-proof-${runKey}-${worktrees && index >= 4 ? "project" : Math.floor(index / 4)}`;
    if (worktrees && index === 4) {
      const projectPath = path.join(output, "project");
      mkdirSync(projectPath);
      execFileSync("git", ["init", "--initial-branch=main", projectPath], { stdio: "ignore" });
      writeFileSync(path.join(projectPath, "README.md"), "Synthetic exit-listener fixture.\n");
      execFileSync("git", ["-C", projectPath, "add", "README.md"]);
      execFileSync(
        "git",
        [
          "-C",
          projectPath,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "-m",
          "fixture",
        ],
        { stdio: "ignore" },
      );
      project = await rpc<ProjectsRegisterResult>("projects.register", {
        path: projectPath,
        name: "Exit listener fixture",
      });
    }
    if (worktrees && (index === 4 || index === 5)) {
      const created: SessionsCreateResult = await rpc("sessions.create", {
        key: sessionKey,
        projectId: project!.id,
        worktree: true,
        worktreeBaseRef: "main",
        worktreeName: `exit-${agentId}`,
        visibility: "shared",
      });
      assert(created.worktree?.id, "Managed worktree created");
      await checkpoint(`worktree-created-${agentId}`);
    }
    const marker = `EXIT_LISTENER_TURN_${index}`;
    const runId = randomUUID();
    const startedAt = performance.now();
    const command = `test ${sandboxed ? "" : "! "}-f /.dockerenv && printf '${marker}\\n'`;
    const render =
      diffs && index === 4
        ? 'First call the diffs tool with before="old\\n", after="new\\n", path="fixture.txt", mode="file". Do not send the artifact anywhere. Then '
        : "";
    await rpc("agent", {
      sessionKey,
      message: `${render}Use an available shell execution tool to run exactly: ${command}. Then reply with only the command output.`,
      deliver: false,
      idempotencyKey: runId,
    });
    const result = await rpc<TurnResult>("agent.wait", { runId, timeoutMs: 290000 });
    const receipt = result.terminalReceipt;
    evidence.turns.push({
      index,
      agentId,
      sessionKey,
      ms: performance.now() - startedAt,
      status: result.status,
      successfulToolNames: receipt?.successfulToolNames,
      effective: receipt?.effective,
      reply: result.terminalReply,
      error: result.error,
      receipt,
    });
    save();
    assert.equal(result.status, "ok", "Completed live turn");
    assert(receipt, "Terminal receipt returned");
    assert(
      receipt.successfulToolNames.some((name) => ["exec", "bash", "sandbox_exec"].includes(name)),
      "Real shell execution completed",
    );
    if (diffs && index === 4) {
      assert(receipt?.successfulToolNames?.includes("diffs"), "Real diff rendering completed");
    }
    assert(
      result.terminalReply?.disposition === "visible" && result.terminalReply.text.includes(marker),
      "Expected synthetic shell output",
    );
    await checkpoint(`turn-${index}-${agentId}`);
    console.log(
      JSON.stringify({
        index,
        agentId,
        ms: performance.now() - startedAt,
        tools: receipt.successfulToolNames,
        ok: true,
      }),
    );
  }
  await delay(Math.max(0, observeMs - (performance.now() - gatewayStartedAt)));
  await checkpoint("complete");
} catch (error) {
  evidence.error = String(error);
  throw error;
} finally {
  client?.close();
  evidence.shutdown = await stopChild(child, { teardownGraceMs: 30000 });
  log.end();
  evidence.traces = readdirSync(traces).map((file) => ({
    file,
    events: readFileSync(path.join(traces, file), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ExitTraceEvent),
  }));
  evidence.finishedAt = new Date().toISOString();
  save();
}

// Persist the complete workload (including shutdown) before evaluating the traces.
const allEvents = evidence.traces!.flatMap((trace) => trace.events);
if (diffs) {
  assert(
    allEvents.some(
      (event) =>
        event.type === "register" &&
        event.pid === child.pid &&
        event.threadId === 0 &&
        event.name === "exitHandler" &&
        event.stack?.includes("playwright-core") &&
        event.stack.includes("addProcessHandlerIfNeeded"),
    ),
    "Real Playwright renderer activation captured",
  );
}
if (values.assert) {
  assert.equal(evidence.shutdown?.exitCode, 0, "Gateway shut down cleanly");
  for (const event of allEvents) {
    assert.equal(event.defaultLimit, defaultMaxListeners, "Default listener limit changed");
    assert.equal(event.limit, defaultMaxListeners, "Process listener limit changed");
    assert(
      event.count <= defaultMaxListeners,
      `Exit listener peak ${event.count} exceeds ${defaultMaxListeners} in ${event.pid}/${event.threadId}`,
    );
  }
  const checkpoints = allEvents.filter(
    (event) => event.type === "checkpoint" && event.pid === child.pid && event.threadId === 0,
  );
  const ready = checkpoints.find((event) => event.phase === "ready");
  assert(ready, "Ready checkpoint captured");
  const settled = checkpoints.filter(
    (event) => event.phase?.startsWith("turn-") || event.phase === "complete",
  );
  assert.equal(settled.length, turns + 1, "Every settled turn and final checkpoint captured");
  for (const event of settled) {
    const activeBrowserHooks = diffs
      ? event.listeners!.filter(
          (listener) =>
            listener.name === "exitHandler" &&
            listener.stack?.includes("playwright-core") &&
            listener.stack.includes("addProcessHandlerIfNeeded"),
        ).length
      : 0;
    assert.equal(
      event.count - activeBrowserHooks,
      ready.count,
      `Settled exit listeners grew at ${event.phase} (excluding ${activeBrowserHooks} active Playwright hooks)`,
    );
  }
}
