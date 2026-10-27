/**
 * Real sandbox exec/Files-reader contention on an isolated source Gateway.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/local-workspace-lease-holders-measure.ts
 *   --output .local/buf595-base --execs 200 --files 1000 --port 44960
 * Add --revision <sha> to overlay the four workspace owners from that revision;
 * surrounding runtime stays current. Use fresh processes and identical fixtures
 * for each arm. --instrument allocation samples main-thread allocations separately.
 * Requires the existing openclaw-sandbox:bookworm-slim image and local Docker.
 * Each mock-provider turn requests at most 20 sequential real exec tool calls;
 * every tenth command appends a counter line, verified in canonical files. The
 * remaining commands are no-ops; --write-every changes the write frequency.
 * One serial sessions.files.list reader runs concurrently, pausing one second after
 * each reply so it does not continuously reacquire custody. Lease measurements cover
 * acknowledged acquisition through release acknowledgement, including cleanup.
 * Callback substeps are inclusive (do not sum nested timings). Caller categories
 * come from in-memory stack matching; no stacks, session IDs, or messages are saved.
 * This focused source-Gateway run is not the separate full Team-shaped stress test.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { transformSync } from "esbuild";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { OpenClawConfig } from "../../src/config/types.openclaw.ts";
import { applyMockOpenAiModelConfig } from "../e2e/lib/fixtures/mock-openai-config.mjs";
import { readBody, writeJson, writeSse } from "../e2e/lib/mock-openai-http.mjs";
import { BASE_GATEWAY_BENCH_CONFIG, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    revision: { type: "string" },
    execs: { type: "string", default: "200" },
    files: { type: "string", default: "1000" },
    "write-every": { type: "string", default: "10" },
    port: { type: "string", default: "44960" },
    instrument: { type: "string", default: "timing" },
  },
});
assert(values.output, "--output must be a new synthetic fixture directory");
const execs = Number(values.execs),
  files = Number(values.files),
  port = Number(values.port);
const writeEvery = Number(values["write-every"]);
for (const value of [execs, files, port, writeEvery]) {
  assert(Number.isSafeInteger(value) && value > 0);
}
assert(port >= 40000 && port < 65535);
assert(["timing", "allocation"].includes(values.instrument!));
const output = path.resolve(values.output);
fs.mkdirSync(output);
for (const name of ["home", "tmp", "repo"]) {
  fs.mkdirSync(path.join(output, name));
}
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const ownerFiles = [
  "src/agents/sandbox/local-workspace.ts",
  "src/agents/sandbox/local-workspace-quiescence.ts",
  "src/agents/sandbox/persistent-exec.ts",
  "src/gateway/worker-environments/local-workspace-projection.ts",
];
const source = new Map(
  ownerFiles.map((file) => [
    file,
    values.revision
      ? execFileSync("git", ["show", `${values.revision}:${file}`], {
          cwd: sourceRoot,
          encoding: "utf8",
          env: { ...process.env, DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" },
        })
      : fs.readFileSync(path.join(sourceRoot, file), "utf8"),
  ]),
);
const loadedOwners = new Set<string>();
type LeaseSample = {
  caller: string;
  requestedAt: number;
  acquiredAt?: number;
  releasedAt?: number;
};
type CallbackSample = { caller: string; ms: number; steps: Record<string, number[]> };
const leases: LeaseSample[] = [];
const callbacks: CallbackSample[] = [];
const activeHolder = new AsyncLocalStorage<CallbackSample>();
const requestedCaller = new AsyncLocalStorage<string>();
let measuring = false;
let completedExecs = 0;
let failedExecs = 0;
function caller(stack = "") {
  if (/checkpointLocalWorkspacePath|sessions-files/.test(stack)) {
    return "reader";
  }
  if (/backend\.buildExecSpec|buildExecSpec/.test(stack)) {
    return "exec.prepare";
  }
  if (/backend\.finalizeExec|finalizeExec/.test(stack)) {
    return "exec.checkpoint";
  }
  if (/settleWorkspace|persistent-exec\.ts/.test(stack)) {
    return "persistent.settle";
  }
  if (stack.includes("checkpointLocalWorkspace")) {
    return "checkpoint.other";
  }
  if (stack.includes("prepareLocalSandboxWorkspace")) {
    return "turn.setup";
  }
  return "other";
}
function startStep(name: string) {
  const sample = activeHolder.getStore();
  const started = performance.now();
  return () => {
    if (sample) {
      (sample.steps[name] ??= []).push(performance.now() - started);
    }
  };
}
Object.assign(globalThis, {
  __buf595: {
    finalized(status: string, exitCode: number | null, timedOut: boolean) {
      if (!measuring) {
        return;
      }
      completedExecs++;
      if (status !== "completed" || exitCode !== 0 || timedOut) {
        failedExecs++;
      }
    },
    scope<T>(stack: string, run: () => T) {
      return requestedCaller.run(caller(stack), run);
    },
    request(stack: string) {
      if (!measuring) {
        return undefined;
      }
      const sample: LeaseSample = {
        caller: requestedCaller.getStore() ?? caller(stack),
        requestedAt: performance.now(),
      };
      leases.push(sample);
      return {
        acquired: () => {
          sample.acquiredAt = performance.now();
        },
        released: () => {
          sample.releasedAt = performance.now();
        },
      };
    },
    async hold<T>(stack: string, run: () => Promise<T>) {
      if (!measuring) {
        return await run();
      }
      const sample: CallbackSample = { caller: caller(stack), ms: 0, steps: {} };
      const started = performance.now();
      try {
        return await activeHolder.run(sample, run);
      } finally {
        sample.ms = performance.now() - started;
        callbacks.push(sample);
      }
    },
    startStep,
    observe(name: string) {
      return /\.quiesce\.|\.resume\./.test(name) ? startStep(name) : undefined;
    },
  },
});
function replaceOnce(code: string, before: string, after: string) {
  assert.equal(
    code.split(before).length,
    2,
    `Instrumentation anchor changed: ${before.slice(0, 90)}`,
  );
  return code.replace(before, after);
}
registerHooks({
  load(url, context, nextLoad) {
    const relative = url.startsWith("file:") ? path.relative(sourceRoot, fileURLToPath(url)) : "";
    let code = source.get(relative);
    if (code !== undefined) {
      loadedOwners.add(relative);
    }
    if (relative === "src/agents/sandbox/local-workspace.ts") {
      assert(code !== undefined);
      const finalization =
        "      await finalize?.({ ...params, token: pending.token });\n      await projection.checkpoint();";
      code = replaceOnce(
        code,
        finalization,
        finalization +
          "\n      globalThis.__buf595.finalized(params.status, params.exitCode, params.timedOut);",
      );
    }
    if (relative === "src/state/openclaw-state-lease.ts") {
      code = fs.readFileSync(path.join(sourceRoot, relative), "utf8");
      code = replaceOnce(
        code,
        "  const releaseOwned = async () => {",
        "  const __leaseProbe = validated.scope === 'workspace.local-reconciliation' ? globalThis.__buf595.request(new Error().stack) : undefined;\n  const releaseOwned = async () => {",
      );
      code = replaceOnce(
        code,
        "        acquired(expiresAt) {\n          confirmedExpiresAt = expiresAt;",
        "        acquired(expiresAt) {\n          __leaseProbe?.acquired();\n          confirmedExpiresAt = expiresAt;",
      );
      code = replaceOnce(
        code,
        "    await execution?.settle();\n  };\n  workerStorage?.assertCurrent();",
        "    await execution?.settle();\n    __leaseProbe?.released();\n  };\n  workerStorage?.assertCurrent();",
      );
    }
    if (relative === "src/gateway/worker-environments/local-workspace-store.ts") {
      code = fs.readFileSync(path.join(sourceRoot, relative), "utf8");
      code =
        'import { withDiagnosticsTimelineObserver as __observeHolder } from "../../infra/diagnostics-timeline.js";\n' +
        code;
      code = replaceOnce(
        code,
        "  const env = params.env ?? process.env;",
        "  const __caller = new Error().stack;\n  const env = params.env ?? process.env;",
      );
      code = replaceOnce(
        code,
        "  return withWorktreeRunEnd(env, () =>",
        "  return globalThis.__buf595.scope(__caller, () => withWorktreeRunEnd(env, () =>",
      );
      code = replaceOnce(
        code,
        "      (lease) => {",
        "      (lease) => globalThis.__buf595.hold(__caller, () => __observeHolder(globalThis.__buf595.observe, () => {\n        const __finishSetup = globalThis.__buf595.startStep('store.setup');",
      );
      code = replaceOnce(
        code,
        "\n                await pruneLegacy();\n                const prepare",
        "\n                const __finishPrune = globalThis.__buf595.startStep('store.pruneLegacy');\n                await pruneLegacy();\n                __finishPrune();\n                __finishSetup();\n                const prepare",
      );
      const manifest =
        'const readManifest: LocalWorkspaceStore["manifest"] = async (previous, action) => {';
      code = replaceOnce(
        code,
        manifest,
        manifest +
          "\n                  const __finishManifest = globalThis.__buf595.startStep('manifest.' + action.kind);\n                  try {",
      );
      code = replaceOnce(
        code,
        "                  return value;\n                };\n                const accept:",
        "                  return value;\n                  } finally { __finishManifest(); }\n                };\n                const accept:",
      );
      code = replaceOnce(code, "      },\n    ),\n  );\n}", "      })),\n    ),\n  ));\n}");
    }
    if (relative === "src/agents/worktrees/preparation-timing.ts") {
      code = fs.readFileSync(path.join(sourceRoot, relative), "utf8");
      code = replaceOnce(
        code,
        "  const finish = startWorktreePreparationPhase(phase);",
        "  const finish = startWorktreePreparationPhase(phase);\n  const __finishProbe = globalThis.__buf595.startStep('worktree.' + phase);",
      );
      code = replaceOnce(
        code,
        "    finish();\n  }\n}",
        "    finish();\n    __finishProbe();\n  }\n}",
      );
    }
    return code === undefined
      ? nextLoad(url, context)
      : {
          format: "module",
          source: transformSync(code, { loader: "ts", format: "esm", target: "esnext" }).code,
          shortCircuit: true,
        };
  },
});

const repo = path.join(output, "repo"),
  canonical = path.join(output, "canonical");
const configPath = path.join(output, "openclaw.json");
const prefix = `b595-${randomUUID().slice(0, 8)}-`;
// The container owner appends a 42-character slug; longer prefixes are shortened.
assert(prefix.length <= 21);
process.env = createGatewayBenchEnv(path.join(output, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_STATE_DIR: path.join(output, "state"),
    TMPDIR: path.join(output, "tmp"),
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENAI_API_KEY: "synthetic-loopback-only",
    DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  },
});
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { env: process.env, encoding: "utf8" });
git("init", "--quiet", "-b", "main");
git("config", "user.name", "Synthetic fixture");
git("config", "user.email", "fixture@example.invalid");
for (let i = 0; i < files; i++) {
  fs.writeFileSync(path.join(repo, `file-${i}.txt`), `synthetic ${i}\n`);
}
git("add", ".");
git("commit", "--quiet", "-m", "Synthetic workspace");
git("worktree", "add", "--quiet", "-b", "fixture", canonical);
const config: OpenClawConfig = {
  ...BASE_GATEWAY_BENCH_CONFIG,
  worktreeAcceleration: false,
  gateway: {
    ...BASE_GATEWAY_BENCH_CONFIG.gateway,
    controlUi: { enabled: false, allowedOrigins: [`http://127.0.0.1:${port}`] },
  },
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "docker",
        scope: "session",
        workspaceAccess: "rw",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          containerPrefix: prefix,
          network: "none",
        },
      },
    },
    entries: { main: { workspace: repo } },
  },
  cron: { enabled: false },
  tools: { codeMode: { enabled: false } },
};
applyMockOpenAiModelConfig(config, {
  mockPort: port + 1,
  modelRef: "openai/holder-fixture",
  utilityModelRef: "openai/holder-utility",
});
config.plugins = { enabled: true, allow: ["openai"], slots: { memory: "none" } };
fs.writeFileSync(configPath, JSON.stringify(config));
let pendingCommands: string[] = [];
let emittedCalls = 0;
const mock = createServer((request, response) => {
  void (async () => {
    try {
      const body: unknown = JSON.parse(await readBody(request));
      assert(isRecord(body));
      const command =
        body.model === "holder-fixture" && Array.isArray(body.tools) && body.tools.length
          ? pendingCommands.shift()
          : undefined;
      if (command !== undefined) {
        emittedCalls++;
      }
      const args = command === undefined ? undefined : JSON.stringify({ command });
      const text = "FIXTURE_DONE";
      const item =
        args === undefined
          ? {
              type: "message",
              id: `msg_${randomUUID()}`,
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text, annotations: [] }],
            }
          : {
              type: "function_call",
              id: `fc_${randomUUID()}`,
              call_id: `call_${randomUUID()}`,
              name: "exec",
              arguments: args,
            };
      const result = {
        id: `resp_${randomUUID()}`,
        object: "response",
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 64,
          output_tokens: 16,
          total_tokens: 80,
          input_tokens_details: { cached_tokens: 0 },
        },
      };
      if (!body.stream) {
        writeJson(response, 200, result);
        return;
      }
      writeSse(response, [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: args === undefined ? { ...item, content: [] } : { ...item, arguments: "" },
        },
        args === undefined
          ? {
              type: "response.output_text.delta",
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              delta: text,
            }
          : { type: "response.function_call_arguments.delta", delta: args },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: result },
      ]);
    } catch {
      writeJson(response, 500, { error: { message: "Synthetic provider request failed" } });
    }
  })();
});
await new Promise<void>((resolve, reject) => {
  mock.once("error", reject);
  mock.listen(port + 1, "127.0.0.1", resolve);
});
const containers = new Set<string>();
function recordContainers() {
  const ids = execFileSync("docker", ["ps", "-aq", "--no-trunc", "--filter", `name=^/${prefix}`], {
    env: process.env,
    encoding: "utf8",
  }).trim();
  for (const id of ids ? ids.split(/\s+/u) : []) {
    assert(/^[a-f0-9]{64}$/u.test(id));
    const name = execFileSync("docker", ["inspect", "--format", "{{.Name}}", id], {
      env: process.env,
      encoding: "utf8",
    }).trim();
    assert(name.startsWith(`/${prefix}`), "Only this run's unique prefix is owned");
    containers.add(id);
  }
  fs.writeFileSync(
    path.join(output, "owned-containers.json"),
    JSON.stringify({ prefix, ids: [...containers] }, null, 2),
  );
}
recordContainers();
assert.equal(containers.size, 0, "Fixture prefix must be unused before Gateway startup");
let server: { close: (options?: { reason?: string }) => Promise<void> } | undefined;
const peers: Array<{ stop: () => void }> = [];
const readerState = { done: false };
let reader: Promise<void> | undefined;
const waiterMs: number[] = [];
const turnMs: number[] = [];
const inspector = values.instrument === "allocation" ? new Session() : undefined;
const loop = monitorEventLoopDelay({ resolution: 10 });
let gcMs = 0;
const gc = new PerformanceObserver((entries) => {
  for (const entry of entries.getEntries()) {
    gcMs += entry.duration;
  }
});
function stats(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.floor((sorted.length - 1) * p)] ?? null;
  return {
    samples: sorted.length,
    totalMs: sorted.reduce((a, b) => a + b, 0),
    p50Ms: percentile(0.5),
    p99Ms: percentile(0.99),
    maxMs: sorted.at(-1) ?? null,
  };
}
const failures: unknown[] = [];
try {
  const { startGatewayServer } = await import("../../src/gateway/server.js");
  const { GatewayClient } = await import("../../src/gateway/client.js");
  const { insertRegistryWorktree } = await import("../../src/agents/worktrees/registry.js");
  const { upsertSessionEntryCore } = await import("../../src/config/sessions/session-accessor.js");
  (await import("../../src/config/runtime-snapshot.js")).setRuntimeConfigSnapshot(config);
  (await import("../../src/state/openclaw-agent-db.js")).openOpenClawAgentDatabase({
    agentId: "main",
  });
  const sessionKey = `agent:main:dashboard:buf595-${randomUUID()}`;
  const worktree = {
    id: randomUUID(),
    name: "fixture",
    repoFingerprint: "fixture",
    repoRoot: repo,
    path: canonical,
    branch: "fixture",
    baseRef: "main",
    ownerKind: "session" as const,
    ownerId: sessionKey,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };
  await insertRegistryWorktree(process.env, worktree);
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey },
    {
      sessionId: randomUUID(),
      label: "Synthetic workspace",
      updatedAt: Date.now(),
      spawnedCwd: canonical,
      worktree: { id: worktree.id, branch: worktree.branch, repoRoot: repo },
    },
  );
  await (await import("../../src/state/openclaw-agent-db.js")).closeOpenClawAgentDatabasesAsync();
  await (await import("../../src/state/openclaw-state-db.js")).closeOpenClawStateDatabaseAsync();
  server = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
  async function connect(instanceId: string) {
    const ready = Promise.withResolvers<void>();
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      clientName: "openclaw-control-ui",
      mode: "webchat",
      platform: "web",
      instanceId,
      scopes: ["operator.admin"],
      requestTimeoutMs: 610_000,
      onHelloOk: () => ready.resolve(),
      onConnectError: (error) => ready.reject(error),
    });
    peers.push(client);
    client.start();
    await ready.promise;
    return client;
  }
  const client = await connect("synthetic-holder-execs"),
    fileClient = await connect("synthetic-holder-reader");
  async function turn(commands: string[]) {
    const hasCommands = commands.length > 0;
    pendingCommands = commands;
    const runId = randomUUID(),
      started = performance.now();
    await client.request("agent", {
      sessionKey,
      message: "Run the synthetic fixture commands.",
      deliver: false,
      idempotencyKey: runId,
    });
    const result = await client.request<{
      status: string;
      terminalReceipt?: { successfulToolNames?: string[] };
    }>("agent.wait", { runId, timeoutMs: 600_000 });
    assert.equal(result.status, "ok", "Synthetic turn failed");
    assert.equal(pendingCommands.length, 0, "Not every requested exec was emitted");
    if (hasCommands) {
      assert(result.terminalReceipt?.successfulToolNames?.includes("exec"), "No exec succeeded");
    }
    return performance.now() - started;
  }
  await turn([]);
  recordContainers();
  assert.equal(containers.size, 1, "Exactly one isolated session container is expected");
  await fileClient.request("sessions.files.list", { sessionKey });
  globalThis.gc?.();
  inspector?.connect();
  await inspector?.post("HeapProfiler.startSampling", {
    samplingInterval: 32_768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const hostLoad = loadavg(),
    cpuBefore = process.threadCpuUsage(),
    started = performance.now();
  loop.enable();
  gc.observe({ entryTypes: ["gc"] });
  measuring = true;
  reader = (async () => {
    while (!readerState.done) {
      const began = performance.now();
      await fileClient.request("sessions.files.list", { sessionKey });
      waiterMs.push(performance.now() - began);
      await delay(1000);
    }
  })();
  // Attach immediately so a reader failure cannot become an unhandled rejection.
  const readerFailure = reader.catch((error: unknown) => {
    readerState.done = true;
    return error;
  });
  for (let offset = 0; offset < execs; offset += 20) {
    assert(!readerState.done, "Concurrent reader stopped unexpectedly");
    turnMs.push(
      await turn(
        Array.from({ length: Math.min(20, execs - offset) }, (_, i) =>
          (offset + i + 1) % writeEvery === 0
            ? `printf '%s\\n' '${offset + i + 1}' >> buf595-exec-count.txt`
            : "true",
        ),
      ),
    );
    const completed = Math.min(execs, offset + 20),
      writes = Math.floor(completed / writeEvery);
    if (writes) {
      const lines = fs
        .readFileSync(path.join(canonical, "buf595-exec-count.txt"), "utf8")
        .trim()
        .split("\n");
      assert.deepEqual(
        lines,
        Array.from({ length: writes }, (_, i) => String((i + 1) * writeEvery)),
        "Canonical checkpoint omitted exec writes",
      );
    }
    console.log(
      JSON.stringify({
        completedExecs: completed,
        readerRequests: waiterMs.length,
        acquisitions: leases.length,
      }),
    );
  }
  readerState.done = true;
  await reader;
  assert.equal(await readerFailure, undefined);
  measuring = false;
  const elapsedMs = performance.now() - started,
    cpu = process.threadCpuUsage(cpuBefore);
  const profile = await inspector?.post("HeapProfiler.stopSampling");
  inspector?.disconnect();
  loop.disable();
  gc.disconnect();
  const allocation = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((sum, child) => sum + allocation(child), 0);
  assert.equal(emittedCalls, execs);
  assert.equal(completedExecs, execs, "Not every emitted exec completed workspace finalization");
  assert.equal(
    failedExecs,
    0,
    "A measured exec failed, timed out, or returned a nonzero exit code",
  );
  assert(leases.length > 0 && waiterMs.length > 0, "Missing lease or reader measurements");
  assert(
    leases.every((sample) => sample.acquiredAt !== undefined && sample.releasedAt !== undefined),
    "A measured lease did not settle",
  );
  const callers = [...new Set(leases.map((sample) => sample.caller))];
  const byCaller = Object.fromEntries(
    callers.map((name) => {
      const selected = leases.filter((sample) => sample.caller === name);
      const selectedCallbacks = callbacks.filter((sample) => sample.caller === name);
      const steps: Record<string, number[]> = {};
      for (const sample of selectedCallbacks) {
        for (const [step, times] of Object.entries(sample.steps)) {
          (steps[step] ??= []).push(...times);
        }
      }
      return [
        name,
        {
          acquisitions: selected.length,
          acquisitionsPerExec: selected.length / execs,
          wait: stats(selected.map((sample) => sample.acquiredAt! - sample.requestedAt)),
          hold: stats(selected.map((sample) => sample.releasedAt! - sample.acquiredAt!)),
          callback: stats(selectedCallbacks.map((sample) => sample.ms)),
          steps: Object.fromEntries(
            Object.entries(steps).map(([step, times]) => [step, stats(times)]),
          ),
        },
      ];
    }),
  );
  const report = {
    revision: values.revision ?? "working-tree",
    comparison: "workspace-owner overlay on current runtime",
    files,
    execs,
    writeEvery,
    readerPauseMs: 1000,
    fullExecProtocol: execs >= 200,
    instrument: values.instrument,
    elapsedMs,
    hostLoad,
    hostLoadAfter: loadavg(),
    mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
    mainThreadCpuPercent: (cpu.user + cpu.system) / (elapsedMs * 10),
    sampledAllocatedBytes: profile ? allocation(profile.profile.head) : null,
    gcMs,
    gcMsPerMinute: (gcMs * 60_000) / elapsedMs,
    eventLoop: { samples: loop.count, p99Ms: loop.percentile(99) / 1e6 },
    memory: process.memoryUsage(),
    waiter: stats(waiterMs),
    turns: stats(turnMs),
    byCaller,
    sources: Object.fromEntries(
      [...source].map(([file, code]) => [file, createHash("sha256").update(code).digest("hex")]),
    ),
    loadedOwners: [...loadedOwners],
    canonicalExecWritesVerified: Math.floor(execs / writeEvery),
    completedExecs,
    allExecStatusesSuccessful: failedExecs === 0,
    notes: [
      "Lease hold includes release acknowledgement; callback substeps overlap.",
      "Caller matching can report other; inspect counts before attributing acquisitions per exec.",
      "Tail metrics below 1,000 samples are context only.",
    ],
  };
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  failures.push(error);
} finally {
  const cleanup = async (run: () => unknown) => {
    try {
      await run();
    } catch (error) {
      failures.push(error);
    }
  };
  measuring = false;
  readerState.done = true;
  await reader?.catch(() => {});
  await cleanup(() => inspector?.disconnect());
  loop.disable();
  gc.disconnect();
  for (const peer of peers) {
    await cleanup(() => peer.stop());
  }
  await cleanup(() => server?.close({ reason: "synthetic holder measurement complete" }));
  await cleanup(() => mock.closeAllConnections());
  await cleanup(
    () =>
      new Promise<void>((resolve) => {
        mock.close(() => resolve());
      }),
  );
  await cleanup(recordContainers);
  for (const id of containers) {
    await cleanup(() => execFileSync("docker", ["rm", "--force", id], { env: process.env }));
  }
  await cleanup(async () =>
    (await import("../../src/state/openclaw-agent-db.js")).closeOpenClawAgentDatabasesAsync(),
  );
  await cleanup(async () =>
    (await import("../../src/state/openclaw-state-db.js")).closeOpenClawStateDatabaseAsync(),
  );
  await cleanup(async () =>
    (await import("../../src/shared/global-singleton.js")).drainGlobalSingletonLifecycleState(),
  );
}
if (failures.length) {
  throw new AggregateError(failures, "Synthetic holder benchmark failed");
}
