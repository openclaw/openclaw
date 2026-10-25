/**
 * Isolated built-Gateway stress; never pass operator state. Generate each side independently:
 * node --import ./scripts/tsx.mjs scripts/perf/team-shape-fixture.ts \
 *   --state-dir "$PWD/.local/ws-base" --sessions 10000 --runs 6000 --settled-runs \
 *   --projects 32 --transcript-mib 16 --port 41721
 * node --import ./scripts/tsx.mjs scripts/perf/ws-counter-stress.ts \
 *   --state-dir "$PWD/.local/ws-base" --port 41721 --mock-port 41722 --revision <sha>
 * Run separate fixtures/builds in counterbalanced base/candidate order. The 600-second
 * untraced window gates CPU, GC and latency. A subsequent 60-second sampled allocation
 * window is reported separately, includes collected objects, and never gates GC/latency.
 * Reuse --duration-seconds 10 --allocation-seconds 5 only for harness smoke, not perf proof.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { applyMockOpenAiModelConfig } from "../e2e/lib/fixtures/mock-openai-config.mjs";
import { stopChild } from "../lib/gateway-bench-child.ts";
import {
  controlGatewayProfile,
  measureGatewayCpuUsage,
  readGatewayCpuUsage,
  readGatewayHeapProfile,
  readGatewayResources,
  startGatewayDiagnostics,
} from "../lib/gateway-bench-profile.ts";
import {
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  waitForInitialProbe,
  writeGatewayBenchConfig,
  writePluginFixtures,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    entry: { type: "string", default: "dist/entry.js" },
    revision: { type: "string" },
    port: { type: "string", default: "41721" },
    "mock-port": { type: "string", default: "41722" },
    clients: { type: "string", default: "64" },
    active: { type: "string", default: "32" },
    "duration-seconds": { type: "string", default: "600" },
    "allocation-seconds": { type: "string", default: "60" },
    "poll-ms": { type: "string", default: "5000" },
    "turn-ms": { type: "string", default: "10000" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "Usage: node --import ./scripts/tsx.mjs scripts/perf/ws-counter-stress.ts --state-dir <new synthetic team-shape fixture> [--entry dist/entry.js] [--port 41721 --mock-port 41722 --clients 64 --active 32 --duration-seconds 600 --allocation-seconds 60 --revision <sha>]\nSee the script header for fixture preparation and paired-run rules.",
  );
  process.exit(0);
}
assert(values["state-dir"], "--state-dir is required");
const integer = (key: keyof typeof values, min = 1) =>
  parseStrictIntegerOption({
    raw: String(values[key]),
    fallback: min,
    min,
    label: `--${key}`,
  });
const port = integer("port", 40000);
const mockPort = integer("mock-port", 40000);
assert(port <= 65535 && mockPort <= 65535 && port !== mockPort);
const clientCount = integer("clients");
const active = integer("active");
assert(active <= clientCount && clientCount <= 128);
const root = path.resolve(values["state-dir"]);
const summary = JSON.parse(readFileSync(path.join(root, "team-shape-summary.json"), "utf8"));
assert(summary.format === "openclaw-team-shape-v1", "requires synthetic team-shape fixture");
assert(
  summary.sessionCount >= 10000 && summary.projects >= active,
  "fixture needs >=10000 sessions and one project worktree per active client",
);
assert(existsSync(values.entry), "build the requested Gateway entry before measuring");
const output = path.join(root, `ws-stress-${Date.now()}`);
mkdirSync(output);
const clients: ReturnType<typeof createGatewayWsClient>[] = [];
const children: ChildProcess[] = [];
const successfulTools = new Set<string>();
let eventFrames = 0;
let failure: Error | undefined;
let closing = false;
function launch(args: string[], env: NodeJS.ProcessEnv, name: string, ipc = false) {
  const child = spawn(process.execPath, args, {
    env,
    detached: true,
    stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
  });
  const log = createWriteStream(path.join(output, `${name}.log`));
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  children.push(child);
  child.on("error", (error) => {
    failure ??= error;
  });
  return child;
}
async function rpc(client: (typeof clients)[number], method: string, params: unknown) {
  const result = await client.request(method, params, 120000);
  assert(result.ok, `${method}: ${JSON.stringify(result.error)}`);
  return result.payload;
}
async function ready(child: ChildProcess, childPort: number, probePath: string) {
  const start = performance.now();
  const result = await waitForInitialProbe({
    port: childPort,
    path: probePath,
    startAt: start,
    deadlineAt: start + 180000,
    isDone: () => child.exitCode !== null,
  });
  assert(result.status === 200, `child readiness failed: ${output}`);
}
async function assertFreePort(childPort: number) {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(childPort, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
}
function extra(child: ChildProcess, action: "start" | "stop"): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", listener);
      reject(new Error("stress preload timeout"));
    }, 30000);
    function listener(message: unknown) {
      if (
        isRecord(message) &&
        message.channel === "ws-counter-stress" &&
        message.action === action
      ) {
        clearTimeout(timer);
        child.off("message", listener);
        resolve(message);
      }
    }
    child.on("message", listener);
    child.send({ channel: "ws-counter-stress", action });
  });
}
function tails(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    count: sorted.length,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null,
    maxMs: sorted.at(-1) ?? null,
  };
}
let cleanupPromise: Promise<void> | undefined;
function cleanup() {
  return (cleanupPromise ??= (async () => {
    closing = true;
    for (const client of clients) {
      client.ws.terminate();
    }
    for (const child of children.toReversed()) {
      await stopChild(child, { teardownGraceMs: 10000 });
    }
  })());
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}
try {
  await assertFreePort(port);
  await assertFreePort(mockPort);
  const config = JSON.parse(readFileSync(path.join(root, "openclaw.json"), "utf8"));
  applyMockOpenAiModelConfig(config, {
    mockPort,
    modelRef: "openai/gpt-4.1",
    utilityModelRef: "openai/gpt-4.1-mini",
  });
  config.models.providers.openai.api = "openai-completions";
  for (const model of config.models.providers.openai.models) {
    model.api = "openai-completions";
  }
  config.tools = { codeMode: false };
  config.agents.defaults = {
    ...config.agents.defaults,
    maxConcurrent: active,
    skipBootstrap: true,
  };
  config.diagnostics = { enabled: true };
  config.cron = { ...config.cron, enabled: true };
  config.plugins.entries = { "memory-core": { config: { dreaming: { enabled: false } } } };
  const configPath = writeGatewayBenchConfig(output, config, {
    pluginFixtures: writePluginFixtures(output, { count: 40 }),
  });
  const control = path.join(output, "mock-control.json");
  const reply = "Synthetic workspace inspected. ".repeat(40);
  writeFileSync(
    control,
    JSON.stringify({
      models: {
        "gpt-4.1": {
          text: reply,
          toolCall: {
            name: "exec",
            arguments: { command: "cat README.md && rg -n Synthetic README.md" },
          },
        },
        "gpt-4.1-mini": { text: "Synthetic workspace inspection" },
      },
    }),
  );
  const mock = launch(
    ["scripts/e2e/mock-openai-server.mjs"],
    {
      PATH: process.env.PATH,
      HOME: path.join(root, "home"),
      MOCK_PORT: String(mockPort),
      MOCK_RESPONSE_CONTROL: control,
    },
    "mock",
  );
  await ready(mock, mockPort, "/health");
  const gateway = launch(
    buildGatewayBenchChildArgs(values.entry, port, [
      "--import",
      "./scripts/tsx.mjs",
      "--import",
      "./scripts/lib/gateway-bench-profile-preload.ts",
      "--import",
      "./scripts/perf/ws-counter-stress-preload.ts",
    ]),
    createGatewayBenchEnv(path.join(root, "home"), configPath, {
      startupTrace: false,
      caseEnv: {
        OPENCLAW_STATE_DIR: root,
        TMPDIR: path.join(root, "tmp"),
        OPENCLAW_PROFILE: `ws-stress-${port}`,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENAI_API_KEY: "synthetic-local-mock",
        DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer",
      },
    }),
    "gateway",
    true,
  );
  await ready(gateway, port, "/readyz");
  for (let index = 0; index < clientCount; index++) {
    const client = createGatewayWsClient({
      url: `ws://127.0.0.1:${port}`,
      onEvent(event) {
        eventFrames++;
        if (
          (event.event !== "session.tool" && event.event !== "agent") ||
          !isRecord(event.payload) ||
          event.payload.sessionKey !== `agent:main:dashboard:ws-stress-${port}-${index}`
        ) {
          return;
        }
        const data = event.payload.data;
        if (!isRecord(data) || data.phase !== "result") {
          return;
        }
        const result = data.result;
        const details = isRecord(result) ? result.details : undefined;
        if (
          data.isError === false &&
          isRecord(details) &&
          details.exitCode === 0 &&
          isRecord(result) &&
          Array.isArray(result.content) &&
          result.content.some(
            (block: unknown) =>
              isRecord(block) &&
              block.type === "text" &&
              typeof block.text === "string" &&
              block.text.includes(`1:# Synthetic project ${index}`),
          ) &&
          typeof event.payload.runId === "string"
        ) {
          successfulTools.add(event.payload.runId);
        }
      },
    });
    clients.push(client);
    client.ws.on("error", (error) => {
      failure ??= error;
    });
    client.ws.on("close", () => {
      if (!closing) {
        failure ??= new Error("load client disconnected");
      }
    });
    await client.waitOpen();
    await rpc(client, "connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        version: "1.0.0",
        platform: process.platform,
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      caps: ["tool-events", "session-scoped-events"],
    });
    await rpc(client, "sessions.subscribe", { limit: 100, rowMode: "sidebar", source: "sidebar" });
    if (index < active) {
      const key = `agent:main:dashboard:ws-stress-${port}-${index}`;
      await rpc(client, "sessions.create", {
        key,
        model: "openai/gpt-4.1",
        permissionMode: "full",
        cwd: path.join(root, "fixture-worktrees", `team-shape-project-${index}`),
      });
      await rpc(client, "sessions.messages.subscribe", { key, subscriptionId: `stress-${index}` });
    }
  }
  async function workload(seconds: number) {
    const started = performance.now();
    const deadline = started + seconds * 1000;
    const listTimes: number[] = [];
    let turns = 0;
    let mutations = 0;
    const framesBefore = eventFrames;
    await Promise.all([
      ...clients.map(async (client, index) => {
        let ordinal = 0;
        await delay(index * 10);
        while (performance.now() < deadline) {
          if (failure) {
            throw failure;
          }
          const at = performance.now();
          const rows = await rpc(client, "sessions.list", {
            limit: 100,
            archived: "all",
            source: ordinal % 3 === 0 ? "sidebar" : "sessions-page",
            ...(ordinal % 3 === 0 ? { rowMode: "sidebar" } : {}),
            ...(ordinal % 3 === 2 ? { search: "Synthetic" } : {}),
          });
          assert(
            isRecord(rows) && typeof rows.count === "number" && rows.count > 0,
            "empty list is invalid load",
          );
          listTimes.push(performance.now() - at);
          if (index === 0) {
            await rpc(client, "sessions.patch", {
              key: `agent:main:team-shape-session-${1 + (ordinal % 100)}`,
              label: `Synthetic churn ${ordinal}`,
            });
            mutations++;
          }
          ordinal++;
          await delay(
            Math.min(
              Math.max(0, integer("poll-ms") - (performance.now() - at)),
              Math.max(0, deadline - performance.now()),
            ),
          );
        }
      }),
      ...clients.slice(0, active).map(async (client, index) => {
        await delay(index * 50);
        while (performance.now() < deadline) {
          if (failure) {
            throw failure;
          }
          const at = performance.now();
          const runId = randomUUID();
          const key = `agent:main:dashboard:ws-stress-${port}-${index}`;
          const accepted = await rpc(client, "agent", {
            sessionKey: key,
            message: "Inspect the synthetic README with a file read and grep.",
            deliver: false,
            idempotencyKey: runId,
          });
          assert(isRecord(accepted) && accepted.runId === runId);
          const completed = await rpc(client, "agent.wait", { runId, timeoutMs: 110000 });
          assert(isRecord(completed) && completed.status === "ok", "mock turn failed");
          assert(successfulTools.delete(runId), "turn lacked successful read/grep tool evidence");
          turns++;
          await delay(
            Math.min(
              Math.max(0, integer("turn-ms") - (performance.now() - at)),
              Math.max(0, deadline - performance.now()),
            ),
          );
        }
      }),
    ]);
    if (failure) {
      throw failure;
    }
    assert(turns > 0 && mutations > 0 && eventFrames > framesBefore, "incomplete workload");
    return {
      durationMs: performance.now() - started,
      turns,
      mutations,
      receivedEvents: eventFrames - framesBefore,
      sessionsList: tails(listTimes),
    };
  }
  await workload(10);
  console.log(
    JSON.stringify({
      phase: "ready",
      output,
      fixture: summary,
      clients: clientCount,
      active,
      plugins: 40,
    }),
  );
  const beforeResources = await readGatewayResources(gateway);
  const stopDiagnostics = await startGatewayDiagnostics(gateway);
  await extra(gateway, "start");
  const beforeCpu = await readGatewayCpuUsage(gateway);
  const untracedWork = await workload(integer("duration-seconds"));
  const cpu = measureGatewayCpuUsage(beforeCpu, await readGatewayCpuUsage(gateway));
  const counters = await extra(gateway, "stop");
  const diagnostics = await stopDiagnostics();
  assert(
    diagnostics.collectionErrors === 0 &&
      diagnostics.droppedEvents === 0 &&
      diagnostics.droppedHistogramSamples === 0,
    "incomplete diagnostic capture",
  );
  const gcMs = diagnostics.gc.durationMs?.total ?? 0;
  const afterResources = await readGatewayResources(gateway);
  assert(
    typeof counters.frames === "number" && counters.frames > 0,
    "WebSocket metrics consumer did not receive frames",
  );
  const untraced = {
    ...untracedWork,
    cpu,
    mainThreadCpuPercent: (cpu.mainThread.totalMs / cpu.wallMs) * 100,
    gcSecondsPerMinute: (gcMs / diagnostics.durationMs) * 60,
    counters,
    diagnostics,
    resources: { before: beforeResources, after: afterResources },
  };
  writeFileSync(path.join(output, "untraced.json"), JSON.stringify(untraced, null, 2));
  console.log(JSON.stringify({ phase: "untraced-complete", ...untraced }));
  const profilePath = path.join(output, "allocation.heapprofile");
  await controlGatewayProfile(gateway, "heap", "start", profilePath, {
    includeCollectedObjects: true,
  });
  await extra(gateway, "start");
  const allocationWork = await workload(integer("allocation-seconds"));
  const allocationCounters = await extra(gateway, "stop");
  await controlGatewayProfile(gateway, "heap", "stop", profilePath);
  const heap = readGatewayHeapProfile(profilePath);
  const allocation = {
    ...allocationWork,
    counters: allocationCounters,
    bytesPerSecond: (heap.sampledAllocatedBytes / allocationWork.durationMs) * 1000,
    heap,
  };
  const report = {
    revision: values.revision,
    fixture: summary,
    clientCount,
    active,
    plugins: 40,
    durationSeconds: integer("duration-seconds"),
    untraced,
    allocation,
    output,
  };
  writeFileSync(path.join(output, "result.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      phase: "complete",
      output,
      allocationBytesPerSecond: allocation.bytesPerSecond,
    }),
  );
} finally {
  await cleanup();
}
