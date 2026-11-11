/** Explicit cron.run through a real, isolated Gateway; synthetic fixtures only. */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { buildDeviceAuthPayloadV3 } from "../packages/gateway-client/src/device-auth.ts";
import { PROTOCOL_VERSION } from "../packages/gateway-protocol/src/version.ts";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import type { CronEvent } from "../src/cron/types.js";
import { applyMockOpenAiModelConfig } from "./e2e/lib/fixtures/mock-openai-config.mjs";
import { stopChild } from "./lib/gateway-bench-child.ts";
import { getFreePort } from "./lib/gateway-bench-probes.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  gatewayBenchCpuProfileArgs,
  waitForInitialProbe,
  writeGatewayBenchConfig,
} from "./lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "./lib/gateway-ws-client.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    observer: { type: "string" },
    entry: { type: "string", default: "dist/entry.js" },
    samples: { type: "string", default: "1" },
    "cpu-profile": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "node --import ./scripts/tsx.mjs scripts/bench-cron-run.mts --out <NEW DIR> --observer <frozen observer.cjs> [--samples 1] [--cpu-profile]\n" +
      "Runs one cold explicit cron.run and optional warm repetitions, using a stored synthetic provider account.\n" +
      "The fixture uses TMPDIR and is deleted after all children stop. Counts and profiles are separate from latency evidence.",
  );
  process.exit(0);
}
assert(values.out && values.observer, "--out and --observer are required");
const samples = Number(values.samples);
assert(Number.isSafeInteger(samples) && samples >= 1 && samples <= 100, "--samples must be 1..100");
const output = path.resolve(values.out);
mkdirSync(output, { mode: 0o700 });
const fixture = mkdtempSync(path.join(tmpdir(), "openclaw-cron-run-"));
const children: Array<{ name: string; child: ChildProcess }> = [];
type ProviderRequestCounts = {
  responses: number;
  chatCompletions: number;
  embeddings: number;
  other: number;
};
async function readProviderRequestCounts(port: number): Promise<ProviderRequestCounts> {
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert(response.ok, "Mock provider counters unavailable");
  const health = (await response.json()) as { requests: { ingress: ProviderRequestCounts } };
  return health.requests.ingress;
}
const evidence = {
  format: "cron-run-v1",
  harnessVersion: "cron-run-v1 / frozen-observer-3.1.5",
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  children: [] as Array<{ name: string; pid: number }>,
  // The frozen analyzer distinguishes ordinary chat turns from cron execution.
  turns: [],
  samples,
  cpuProfile: values["cpu-profile"],
  phases: [] as Array<{ phase: string; start: number; end: number }>,
  rpcs: [] as Array<{ phase: string; method: string; ok: boolean }>,
  runs: [] as Array<{
    phase: string;
    historyPolls: number;
    providerRequests: ProviderRequestCounts;
    status: string;
    finishedAt: number;
    verifiedAt: number;
    settledAt: number;
  }>,
  events: [] as Array<{ action: string; status?: string }>,
  shutdown: [] as Array<{ name: string; exitCode: number | null; signal: string | null }>,
  ok: false,
  error: undefined as string | undefined,
};
let phase = "00.fixture";
let phaseStart = Date.now();
let client: ReturnType<typeof createGatewayWsClient> | undefined;
let gateway: ChildProcess | undefined;
let jobId: string | undefined;
let expectedRuns = 0;
let cleanupPromise: Promise<void> | undefined;
const cronEvents: CronEvent[] = [];
function save() {
  writeFileSync(path.join(output, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
}
function setPhase(next: string) {
  evidence.phases.push({ phase, start: phaseStart, end: Date.now() });
  phase = next;
  phaseStart = Date.now();
  writeFileSync(path.join(output, "phase.new"), phase);
  renameSync(path.join(output, "phase.new"), path.join(output, "phase"));
  save();
}
writeFileSync(path.join(output, "phase"), phase);
function launch(name: string, args: string[], env: NodeJS.ProcessEnv) {
  const log = createWriteStream(path.join(output, `${name}.log`));
  const child = spawn(process.execPath, args, {
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    detached: true,
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  children.push({ name, child });
  if (child.pid) {
    evidence.children.push({ name, pid: child.pid });
  }
  save();
  return child;
}
async function rpc<T>(method: string, params: unknown): Promise<T> {
  assert(client);
  const result = await client.request(method, params, 125_000);
  evidence.rpcs.push({ phase, method, ok: result.ok });
  assert(result.ok, `${method} failed: ${JSON.stringify(result.error)}`);
  return result.payload as T;
}
function assertRunning() {
  assert(
    gateway?.exitCode === null && gateway.signalCode === null,
    "Gateway exited during workload",
  );
  const started = cronEvents.filter((event) => event.action === "started");
  assert(started.length <= expectedRuns, "Unexpected scheduled or duplicate cron execution");
}
async function cleanup() {
  return (cleanupPromise ??= (async () => {
    client?.close();
    setPhase("90.shutdown");
    let stopped = true;
    for (const { name, child } of children.toReversed()) {
      try {
        const result = await stopChild(child, { teardownGraceMs: 30_000, killGraceMs: 2_000 });
        evidence.shutdown.push({ name, exitCode: result.exitCode, signal: result.signal });
        if (
          (result.exitCode === null && result.signal === null) ||
          result.signal === "SIGKILL" ||
          (name === "gateway" && result.exitCode !== 0)
        ) {
          stopped = false;
        }
      } catch (error) {
        stopped = false;
        evidence.ok = false;
        evidence.error ??= String(error);
      }
    }
    if (stopped) {
      rmSync(fixture, { recursive: true, force: true });
    } else {
      evidence.ok = false;
      evidence.error ??= "Child shutdown incomplete; synthetic fixture retained";
    }
    setPhase("99.done");
    save();
  })());
}
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.once(signal, () => {
    evidence.ok = false;
    evidence.error = `Interrupted by ${signal}`;
    void cleanup().finally(() => process.exit(code));
  });
}
try {
  const port = await getFreePort();
  const mockPort = await getFreePort();
  const token = randomUUID();
  const workspace = path.join(fixture, "workspace");
  mkdirSync(workspace);
  const cfg: OpenClawConfig = structuredClone(BASE_GATEWAY_BENCH_CONFIG);
  cfg.gateway = { ...cfg.gateway, port, auth: { mode: "token", token } };
  cfg.tools = { codeMode: false };
  applyMockOpenAiModelConfig(cfg, { mockPort, modelRef: "openai/gpt-4.1" });
  cfg.agents = {
    ...cfg.agents,
    defaults: { ...cfg.agents?.defaults, skipBootstrap: true },
    entries: { main: { workspace } },
  };
  cfg.plugins = {
    ...cfg.plugins,
    entries: {
      ...cfg.plugins?.entries,
      "memory-core": { config: { dreaming: { enabled: false } } },
    },
  };
  const configPath = writeGatewayBenchConfig(fixture, cfg, {});
  const fixtureEnv = {
    ...createGatewayBenchEnv(fixture, configPath, { caseEnv: { OPENCLAW_SKIP_CHANNELS: "1" } }),
    NODE_DISABLE_COMPILE_CACHE: "1",
    OPENAI_API_KEY: "synthetic-cron-provider-config",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
    OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT: process.env.OPENCLAW_VITEST_FS_MODULE_CACHE_ROOT,
  };
  // Provision the stored account through the CLI before Gateway takes custody.
  const account = spawn(
    process.execPath,
    [
      path.resolve(values.entry),
      "models",
      "auth",
      "paste-api-key",
      "--provider",
      "openai",
      "--profile-id",
      "openai:cron-bench",
      "--agent",
      "main",
    ],
    { env: fixtureEnv, stdio: ["pipe", "pipe", "pipe"], detached: true },
  );
  children.push({ name: "fixture-account", child: account });
  if (account.pid) {
    evidence.children.push({ name: "fixture-account", pid: account.pid });
  }
  save();
  const accountLog = createWriteStream(path.join(output, "fixture-account.log"));
  account.stdout?.pipe(accountLog);
  account.stderr?.pipe(accountLog);
  const accountClosed = once(account, "close");
  account.stdin?.end("sk-synthetic-cron-bench-fixture\n");
  const [accountCode, accountSignal] = await Promise.race([
    accountClosed,
    delay(120_000, undefined, { ref: false }).then(() => {
      throw new Error("Synthetic account setup timed out");
    }),
  ]);
  assert(accountCode === 0 && accountSignal === null, "Synthetic account setup failed");
  const control = path.join(fixture, "mock-control.json");
  writeFileSync(control, JSON.stringify({ text: "Synthetic cron result.", chunkDelayMs: 5 }));
  launch("mock", ["scripts/e2e/mock-openai-server.mjs"], {
    ...fixtureEnv,
    MOCK_PORT: String(mockPort),
    MOCK_RESPONSE_CONTROL: control,
  });
  assert.equal(
    (
      await waitForInitialProbe({
        port: mockPort,
        path: "/health",
        startAt: performance.now(),
        deadlineAt: performance.now() + 30_000,
      })
    ).status,
    200,
    "Mock provider unavailable",
  );
  setPhase("01.boot");
  gateway = launch(
    "gateway",
    buildGatewayBenchChildArgs(
      values.entry,
      port,
      values["cpu-profile"] ? gatewayBenchCpuProfileArgs(path.join(output, "profiles")) : [],
      "token",
    ),
    {
      ...fixtureEnv,
      SQLMEASURE_OUT: output,
      NODE_OPTIONS: `--require=${JSON.stringify(path.resolve(values.observer))} --enable-source-maps`,
    },
  );
  assert.equal(
    (
      await waitForInitialProbe({
        port,
        path: "/readyz",
        startAt: performance.now(),
        deadlineAt: performance.now() + 300_000,
        isDone: () =>
          Boolean(gateway && (gateway.exitCode !== null || gateway.signalCode !== null)),
      })
    ).status,
    200,
    "Gateway unavailable",
  );
  setPhase("02.connect");
  const challenge = Promise.withResolvers<{ nonce: string; ts: number }>();
  client = createGatewayWsClient({
    url: `ws://127.0.0.1:${port}`,
    onEvent(event) {
      if (event.event === "connect.challenge") {
        challenge.resolve(event.payload as { nonce: string; ts: number });
      }
      if (event.event === "cron") {
        const cron = event.payload as CronEvent;
        if (cron.jobId === jobId) {
          cronEvents.push(cron);
          evidence.events.push({ action: cron.action, status: cron.status });
        }
      }
    },
  });
  const challengeTimer = setTimeout(
    () => challenge.reject(new Error("Gateway challenge timed out")),
    10_000,
  );
  void challenge.promise.catch(() => {});
  let hello: { nonce: string; ts: number };
  try {
    await client.waitOpen();
    hello = await challenge.promise;
  } finally {
    clearTimeout(challengeTimer);
  }
  const pair = generateKeyPairSync("ed25519");
  const rawKey = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const deviceId = createHash("sha256").update(rawKey).digest("hex");
  const scopes = ["operator.read", "operator.write", "operator.admin"];
  const signed = buildDeviceAuthPayloadV3({
    deviceId,
    clientId: "gateway-client",
    clientMode: "ui",
    role: "operator",
    scopes,
    signedAtMs: hello.ts,
    token,
    nonce: hello.nonce,
    platform: process.platform,
  });
  await rpc("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: "gateway-client",
      displayName: "cron-run-benchmark",
      version: "1.0.0",
      platform: process.platform,
      mode: "ui",
    },
    auth: { token },
    role: "operator",
    scopes,
    caps: [],
    device: {
      id: deviceId,
      publicKey: rawKey.toString("base64url"),
      signature: sign(null, Buffer.from(signed), pair.privateKey).toString("base64url"),
      signedAt: hello.ts,
      nonce: hello.nonce,
    },
  });
  setPhase("02.job-create");
  const scheduledAt = Date.now() + 86_400_000;
  const job = await rpc<{ id: string }>("cron.add", {
    name: "Synthetic explicit cron benchmark",
    agentId: "main",
    schedule: { kind: "at", at: new Date(scheduledAt).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "now",
    deleteAfterRun: false,
    payload: {
      kind: "agentTurn",
      message: "Return a short synthetic cron result.",
      model: "openai/gpt-4.1@openai:cron-bench",
    },
    delivery: { mode: "none" },
  });
  jobId = job.id;
  for (let sample = 0; sample < samples; sample++) {
    assertRunning();
    assert.equal(cronEvents.filter((event) => event.action === "started").length, sample);
    const beforeRequests = await readProviderRequestCounts(mockPort);
    const runPhase = sample === 0 ? "04.cron-cold" : `04.cron-warm-${sample}`;
    setPhase(runPhase);
    expectedRuns++;
    const ack: { enqueued: boolean; runId: string } = await rpc("cron.run", {
      id: jobId,
      mode: "force",
    });
    assert(ack.enqueued && ack.runId, "cron.run did not enqueue a run");
    const deadline = Date.now() + 120_000;
    while (!cronEvents.some((event) => event.action === "finished" && event.runId === ack.runId)) {
      assertRunning();
      assert(Date.now() < deadline, "Cron completion event timed out");
      await delay(10);
    }
    const finishedAt = Date.now();
    setPhase(`${runPhase}.verify`);
    // Finished follows the history persistence attempt; verify its success once.
    const page: {
      entries: Array<{ runId?: string; status?: string; summary?: string }>;
    } = await rpc("cron.runs", {
      id: jobId,
      runId: ack.runId,
      limit: 1,
    });
    const entry: (typeof page.entries)[number] | undefined = page.entries[0];
    assert(entry && entry.runId === ack.runId, "Finished cron run is absent from history");
    assert.equal(entry.status, "ok", "Persisted cron run failed");
    assert(entry.summary?.includes("Synthetic cron result."), "Missing mock provider response");
    const verifiedAt = Date.now();
    setPhase(`${runPhase}.settle`);
    await delay(1_000);
    assertRunning();
    assert.equal(cronEvents.filter((event) => event.action === "started").length, sample + 1);
    assert.equal(cronEvents.filter((event) => event.action === "finished").length, sample + 1);
    assert(Date.now() < scheduledAt, "Fixture reached its scheduled execution time");
    const afterRequests = await readProviderRequestCounts(mockPort);
    const providerRequests = {
      responses: afterRequests.responses - beforeRequests.responses,
      chatCompletions: afterRequests.chatCompletions - beforeRequests.chatCompletions,
      embeddings: afterRequests.embeddings - beforeRequests.embeddings,
      other: afterRequests.other - beforeRequests.other,
    };
    assert.deepEqual(
      providerRequests,
      { responses: 1, chatCompletions: 0, embeddings: 0, other: 0 },
      "Expected one model request per cron run",
    );
    evidence.runs.push({
      phase: runPhase,
      historyPolls: 1,
      providerRequests,
      status: entry.status,
      finishedAt,
      verifiedAt,
      settledAt: Date.now(),
    });
    save();
  }
  evidence.ok = true;
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
} finally {
  await cleanup();
}
if (!evidence.ok) {
  process.exitCode = 1;
}
console.log(
  JSON.stringify({ output, ok: evidence.ok, error: evidence.error, runs: evidence.runs }),
);
