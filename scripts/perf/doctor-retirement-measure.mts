// Run with node --import ./scripts/tsx.mjs and --repo <built runtime> --output <fresh directory>.
// Count mode also requires --observer-root <frozen SQL harness>; --mode profile captures each thread.
// Native source update + Gateway diagnostic. The caller owns the timing lock/quiet-host gate.
// Synthetic fixtures only; no QA test watchdog is changed and no live state is read.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { UpdateRunResult } from "../../src/infra/update-runner-types.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    repo: { type: "string" },
    "cold-driver-root": { type: "string" },
    "warm-driver-root": { type: "string" },
    "target-sha": { type: "string" },
    "install-lock": { type: "string" },
    "pnpm-store": { type: "string" },
    mode: { type: "string", default: "count" },
    "cold-only": { type: "boolean", default: false },
    "observer-root": { type: "string" },
  },
});
assert.ok(values.output, "--output is required (use a fresh directory per invocation)");
assert.ok(values.repo, "--repo is required");
assert.ok(values["cold-driver-root"], "--cold-driver-root is required");
assert.ok(values["warm-driver-root"] || values["cold-only"], "--warm-driver-root is required");
assert.match(values["target-sha"] ?? "", /^[0-9a-f]{40}$/, "--target-sha must be a full SHA");
assert.ok(values["install-lock"], "--install-lock is required");
assert.ok(values["pnpm-store"], "--pnpm-store is required");
assert.ok(["count", "profile", "timing"].includes(values.mode!));
const mode = values.mode!;
const repoRoot = path.resolve(values.repo);
const coldDriverRoot = path.resolve(values["cold-driver-root"]);
const warmDriverRoot = values["warm-driver-root"] && path.resolve(values["warm-driver-root"]);
const targetSha = values["target-sha"];
const installLock = path.resolve(values["install-lock"]);
const pnpmStore = path.resolve(values["pnpm-store"]);
function gitHead(root: string) {
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}
const driverSha = gitHead(coldDriverRoot);
assert.notEqual(driverSha, targetSha, "The driver must perform a real source update");
const driverBuild = fs.readFileSync(path.join(coldDriverRoot, "dist/build-info.json"), "utf8");
assert.equal(JSON.parse(driverBuild).commit, driverSha, "The driver build must match its checkout");
if (warmDriverRoot) {
  assert.notEqual(warmDriverRoot, coldDriverRoot, "Cold and warm require independent driver roots");
  assert.equal(gitHead(warmDriverRoot), driverSha, "Cold and warm must start from the same driver");
  assert.equal(
    fs.readFileSync(path.join(warmDriverRoot, "dist/build-info.json"), "utf8"),
    driverBuild,
    "Cold and warm must start from the same build",
  );
}
const output = path.resolve(values.output);
assert.ok(!fs.existsSync(output), "--output must not already exist");
fs.mkdirSync(output, { recursive: true });
const scratchParent = process.env.TMPDIR;
assert.ok(scratchParent, "Set TMPDIR to the lane's internal-disk scratch directory");
const scratch = fs.mkdtempSync(path.join(scratchParent, "doctor-direct-"));
for (const name of ["home", "state", "cache"]) {
  fs.mkdirSync(path.join(scratch, name));
}
// Isolate the harness itself before importing QA modules, as well as its owned child.
Object.assign(process.env, {
  HOME: path.join(scratch, "home"),
  OPENCLAW_HOME: path.join(scratch, "home"),
  OPENCLAW_STATE_DIR: path.join(scratch, "state"),
  OPENCLAW_CONFIG_PATH: path.join(scratch, "openclaw.json"),
  XDG_CONFIG_HOME: path.join(scratch, "home"),
  XDG_DATA_HOME: path.join(scratch, "state"),
  XDG_CACHE_HOME: path.join(scratch, "cache"),
  NODE_DISABLE_COMPILE_CACHE: "1",
});
const phasePath = path.join(output, "phase");
function phase(name: string) {
  fs.writeFileSync(phasePath, name);
  fs.appendFileSync(
    path.join(output, "phases.jsonl"),
    `${JSON.stringify({ name, time: Date.now() })}\n`,
  );
}
phase("harness");
const observer = values["observer-root"]
  ? path.join(path.resolve(values["observer-root"]), "observer.cjs")
  : "";
if (mode === "count") {
  assert.ok(
    observer && fs.existsSync(observer),
    "Count mode requires --observer-root with the frozen SQL observer",
  );
}
const profileDir = path.join(output, "profiles");
fs.mkdirSync(profileDir);
const probe = path.join(output, "probe.cjs");
// Probe-only propagation is necessary: QA strips NODE_OPTIONS for child commands,
// and the fresh Doctor explicitly discards execArgv. Production launchers stay intact.
fs.writeFileSync(
  probe,
  String.raw`
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const wt = require('node:worker_threads');
const { syncBuiltinESMExports } = require('node:module');
const { StringDecoder } = require('node:string_decoder');
const root = process.env.DOCTOR_BENCH_OUTPUT;
const mode = process.env.DOCTOR_BENCH_MODE;
const rawWrite = fs.writeSync;
const fd = fs.openSync(path.join(root, 'process-' + process.pid + '-' + wt.threadId + '.jsonl'), 'a');
function record(event) {
  rawWrite(fd, JSON.stringify({ time: Date.now(), monotonicMs: performance.now(),
    hrtimeMicros: Number(process.hrtime.bigint() / 1000n),
    cpu: process.threadCpuUsage(), processCpu: wt.isMainThread ? process.cpuUsage() : undefined,
    pid: process.pid, threadId: wt.threadId, ...event }) + '\n');
}
record({ type: 'start', ppid: process.ppid, mainThread: wt.isMainThread, argv: process.argv });
const ownOptions = '--require=' + JSON.stringify(__filename) +
  (mode === 'count' ? ' --require=' + JSON.stringify(process.env.DOCTOR_BENCH_OBSERVER) : '');
function instrumentOptions(value) {
  const options = { ...value, env: { ...(value && value.env || process.env) } };
  const old = options.env.NODE_OPTIONS || '';
  options.env.NODE_OPTIONS = old.includes(__filename) ? old : old + ' ' + ownOptions;
  return options;
}
process.env.NODE_OPTIONS = instrumentOptions({ env: process.env }).env.NODE_OPTIONS;
const originalSpawn = cp.spawn;
cp.spawn = function(command, args, options) {
  const env = options && options.env || process.env;
  if (env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE === '1' &&
      (args.includes('--doctor') || (args.includes('doctor') && args.includes('--repair')))) {
    // Retain the first Doctor's receipt before the second replaces it with completion.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(env.OPENCLAW_STATE_DIR, 'state', 'openclaw.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT steps_json FROM update_runs WHERE run_id = ?').get(env.OPENCLAW_UPDATE_RUN_ID);
      const receipt = JSON.parse(row.steps_json).find(step =>
        step.step === 'finalize:doctor:model-retirement' && step.status === 'skipped');
      require('node:assert/strict').ok(receipt, 'First Doctor must record genuine deferred model retirement');
      fs.writeFileSync(path.join(root, 'retirement-deferred-' + env.OPENCLAW_UPDATE_RUN_ID + '.json'), JSON.stringify(receipt));
      record({ type: 'retirement-boundary', statementCount: 1 });
    } finally {
      db.close();
    }
  }
  return originalSpawn.call(this, command, args, instrumentOptions(options));
};
const OriginalWorker = wt.Worker;
wt.Worker = class extends OriginalWorker {
  constructor(filename, options = {}) {
    const inherited = (options.execArgv || process.execArgv).filter(arg => !arg.startsWith('--cpu-prof'));
    const env = options.env && options.env !== wt.SHARE_ENV ? {
      ...options.env, DOCTOR_BENCH_OUTPUT: root, DOCTOR_BENCH_MODE: mode,
      DOCTOR_BENCH_OBSERVER: process.env.DOCTOR_BENCH_OBSERVER, SQLMEASURE_OUT: root,
    } : options.env;
    super(filename, { ...options, env, execArgv: [...inherited, '--require', __filename] });
  }
};
const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
const pending = { stdout: '', stderr: '' };
function capture(stream, chunk, encoding) {
  const text = typeof chunk === 'string' ? chunk : decoders[stream].write(chunk);
  fs.appendFileSync(path.join(root, 'process-' + process.pid + '-' + wt.threadId + '.' + stream + '.log'), text);
  pending[stream] += text;
  const lines = pending[stream].split('\n');
  pending[stream] = lines.pop();
  for (const line of lines) {
    if (line.includes('[gateway] startup ') || line.includes('[update finalize] ') || line.includes('[qa-bootstrap] ')) {
      record({ type: 'trace', stream, line });
    }
  }
}
for (const stream of ['stdout', 'stderr']) {
  const original = process[stream].write;
  process[stream].write = function(chunk, encoding, callback) {
    capture(stream, chunk, encoding);
    return original.call(this, chunk, encoding, callback);
  };
}
fs.writeSync = function(target, chunk, ...args) {
  if (target === 1 || target === 2) capture(target === 1 ? 'stdout' : 'stderr', chunk);
  return rawWrite(target, chunk, ...args);
};
syncBuiltinESMExports();
if (mode === 'count') require(process.env.DOCTOR_BENCH_OBSERVER);
let inspector;
if (mode === 'profile') {
  const { Session } = require('node:inspector');
  inspector = new Session();
  inspector.connect();
  inspector.post('Profiler.enable');
  inspector.post('Profiler.start');
  record({ type: 'profile-start' });
}
const cpuSampleTimer = mode === 'profile'
  ? setInterval(() => record({ type: 'cpu-sample' }), 100).unref()
  : undefined;
process.once('exit', code => {
  if (cpuSampleTimer) clearInterval(cpuSampleTimer);
  record({ type: 'exit', code });
  if (inspector) {
    inspector.post('Profiler.stop', (error, result) => {
      if (error) record({ type: 'profile-error', message: error.message });
      else fs.writeFileSync(path.join(root, 'profiles', 'inspector-' + process.pid + '-' + wt.threadId + '.cpuprofile'), JSON.stringify(result.profile));
      inspector.disconnect();
    });
  }
});
`,
);

const startedAt = Date.now();
const summary: Record<string, unknown> = {
  mode,
  repoRoot,
  driverSha,
  targetSha,
  coldDriverRoot,
  warmDriverRoot,
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  loadAtStart: os.loadavg(),
  startedAt,
  fixture:
    "QA synthetic config and native source update CLI + real loopback Gateway, QA channel and local mock OpenAI; UI disabled",
  scope:
    "Standalone diagnostic, not a QA test result. No test deadline changes. Native update uses its own product budgets and explicit operator cancellation.",
  limitations: [
    "Fresh synthetic state/processes; OS file caches are not flushed.",
    "Public CLI update is invoked directly without the separate QA test progress watchdog.",
    "Fixed synthetic auth placeholders replace random synthetic auth placeholders; profile/config shape is unchanged.",
    "Inspector intervals are sampled elapsed attribution, not exact OS CPU.",
    "Hard-killed child/worker profiles and exits may be missing; analyzers expose coverage.",
    "Profile mode samples OS process/thread CPU every 100 ms; count/timing mode has no periodic CPU sampling.",
  ],
};
const childResults: Array<Record<string, unknown>> = [];
summary.commands = childResults;
let interrupted = false;
let stopTree: ((child: ChildProcess) => Promise<void>) | undefined;
type Owned = {
  child: ChildProcess;
  ended: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  closed: Promise<void>;
  row: Record<string, unknown>;
  logs: () => string;
  stop?: Promise<void>;
};
const active = new Set<Owned>();
async function stopOwned(owned: Owned) {
  owned.stop ??= (async () => {
    assert.ok(stopTree);
    await stopTree(owned.child);
    // The repository process-group owner uses bounded SIGTERM/SIGKILL settlement.
    // Pipe drain is separately bounded, as in the QA lifecycle owner.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        owned.closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Child pipes did not close after group settlement")),
            5_000,
          );
        }),
      ]);
      owned.row.processGroupStopped = true;
      active.delete(owned);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      owned.child.stdin?.destroy();
      owned.child.stdout?.destroy();
      owned.child.stderr?.destroy();
    }
  })();
  await owned.stop;
}
const interrupt = () => {
  interrupted = true;
  void Promise.allSettled([...active].map(stopOwned));
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
let bus: { baseUrl: string; stop(): Promise<void> } | undefined;
let mock: { baseUrl: string; sessionObserverUrl: string; stop(): Promise<void> } | undefined;
let rpc:
  | {
      request(method: string, params?: unknown, opts?: Record<string, unknown>): Promise<unknown>;
      stop(): Promise<void>;
    }
  | undefined;
let closeStores: ((root: string) => Promise<void>) | undefined;
const load = (relative: string) => import(pathToFileURL(path.join(repoRoot, relative)).href);
try {
  const qa = await load("extensions/qa-lab/api.ts");
  const { seedQaAgentWorkspace } = await load("extensions/qa-lab/src/qa-agent-workspace.ts");
  const { applyQaMockAuthProfileConfig, buildQaMockProfileId } = await load(
    "extensions/qa-lab/src/providers/shared/mock-auth.ts",
  );
  const { normalizeQaProviderModeEnv } = await load("extensions/qa-lab/src/providers/env.ts");
  const { SUPERVISOR_HINT_ENV_VARS } = await load("src/infra/supervisor-markers.ts");
  const { closeQaRuntimeStores } = await load("src/plugin-sdk/qa-runtime.ts");
  const { getUpdateRun } = await load("src/infra/update-run-reader.ts");
  closeStores = closeQaRuntimeStores;
  const { reserveQaGatewayPort } = await load("extensions/qa-lab/src/gateway-port-reservation.ts");
  const { waitForGatewayListening, waitForGatewayReady } = await load(
    "extensions/qa-lab/src/gateway-child-readiness.ts",
  );
  const { startQaGatewayRpcClient } = await load("extensions/qa-lab/src/gateway-rpc-client.ts");
  ({ stopQaGatewayChildProcessTree: stopTree } = await load(
    "extensions/qa-lab/src/gateway-child-process.ts",
  ));
  assert.ok(!interrupted, "Diagnostic interrupted");
  const state = qa.createQaBusState();
  const transport = qa.createQaChannelTransport(state);
  const startedBus: NonNullable<typeof bus> = await qa.startQaBusServer({ state });
  bus = startedBus;
  const model = "openai/doctor-benchmark";
  const startedMock: NonNullable<typeof mock> = await qa.startQaMockOpenAiServer({
    modelRefs: [model],
  });
  mock = startedMock;
  assert.ok(!interrupted, "Diagnostic interrupted");
  const reservation = await reserveQaGatewayPort(net.createServer());
  const port = reservation.port;
  await reservation.release();
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}`;
  const workspaceDir = path.join(scratch, "workspace");
  const stateDir = path.join(scratch, "state");
  const configPath = path.join(scratch, "openclaw.json");
  const authConfigPath = path.join(stateDir, "qa-auth-bootstrap", "openclaw.json");
  const token = `qa-suite-${randomUUID()}`;
  await seedQaAgentWorkspace({ workspaceDir, repoRoot });
  const cfg = applyQaMockAuthProfileConfig({
    cfg: qa.buildQaGatewayConfig({
      bind: "loopback",
      gatewayPort: port,
      gatewayToken: token,
      stampCurrentVersion: false,
      providerBaseUrl: mock.baseUrl,
      mockSessionObserverUrl: mock.sessionObserverUrl,
      workspaceDir,
      providerMode: "mock-openai",
      primaryModel: model,
      alternateModel: model,
      transportPluginIds: transport.requiredPluginIds,
      transportConfig: transport.createGatewayConfig({ baseUrl: bus.baseUrl }),
      controlUiEnabled: false,
    }),
    providers: ["openai", "anthropic"],
  });
  cfg.plugins ??= {};
  cfg.plugins.entries ??= {};
  cfg.plugins.entries.github = { ...cfg.plugins.entries.github, enabled: false };
  const configBytes = `${JSON.stringify(cfg, null, 2)}\n`;
  fs.writeFileSync(configPath, configBytes, { mode: 0o600 });
  fs.mkdirSync(path.dirname(authConfigPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(authConfigPath, configBytes, { mode: 0o600 });
  const env: NodeJS.ProcessEnv = normalizeQaProviderModeEnv(
    {
      ...process.env,
      HOME: path.join(scratch, "home"),
      OPENCLAW_HOME: path.join(scratch, "home"),
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_OAUTH_DIR: path.join(stateDir, "credentials"),
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_GATEWAY_PORT: String(port),
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_TEST_FAST: "1",
      OPENCLAW_EMBEDDED_ABORT_SETTLE_TIMEOUT_MS: "2000",
      OPENCLAW_QA_TEMP_ROOT: scratch,
      OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER: "1",
      OPENCLAW_ALLOW_SLOW_REPLY_TESTS: "1",
      XDG_CONFIG_HOME: path.join(scratch, "home"),
      XDG_DATA_HOME: stateDir,
      XDG_CACHE_HOME: path.join(scratch, "cache"),
      TMPDIR: scratch,
      TMP: scratch,
      TEMP: scratch,
      OPENCLAW_PROFILE: `qa-${createHash("sha256").update(scratch).digest("hex").slice(0, 24)}`,
      OPENCLAW_CLI: "1",
      NODE_DISABLE_COMPILE_CACHE: "1",
      OPENCLAW_VITEST_RUNTIME: "node",
      OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
      DOCTOR_BENCH_OUTPUT: output,
      DOCTOR_BENCH_MODE: mode,
      DOCTOR_BENCH_OBSERVER: observer,
      SQLMEASURE_OUT: output,
    },
    "mock-openai",
  );
  const blocked = [
    ...SUPERVISOR_HINT_ENV_VARS,
    "VITEST",
    "VITEST_POOL_ID",
    "VITEST_WORKER_ID",
    "BASH_ENV",
    "BASHOPTS",
    "ENV",
    "SHELLOPTS",
    "OPENCLAW_QA_CODEX_API_KEY_HANDOFF",
    "OPENCLAW_QA_CONVEX_SECRET_CI",
    "OPENCLAW_QA_CONVEX_SECRET_MAINTAINER",
    "OPENCLAW_QA_SUT_FORBIDDEN_SENTINEL",
    "OPENCLAW_QA_TELEGRAM_GROUP_ID",
    "OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN",
    "OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN",
    "OPENCLAW_SKIP_CHANNELS",
    "OPENCLAW_SKIP_PROVIDERS",
    "OPENCLAW_SKIP_CRON",
    "OPENCLAW_DEV_SOURCE_ROOT",
    "OPENCLAW_BUNDLED_PLUGINS_DIR",
    "OPENCLAW_QA_STAGED_RUNTIME_ROOT",
    "OPENCLAW_COMPATIBILITY_HOST_VERSION",
    "OPENCLAW_BUILD_PRIVATE_QA",
    "OPENCLAW_ENABLE_PRIVATE_QA_CLI",
    "OPENCLAW_GATEWAY_HOST_LIFELINE",
    "NODE_OPTIONS",
  ];
  for (const key of Object.keys(env)) {
    if (
      blocked.some((name) => name.toUpperCase() === key.toUpperCase()) ||
      key.startsWith("BASH_FUNC_")
    ) {
      delete env[key];
    }
  }
  if (env.NODE_ENV === "test") {
    delete env.NODE_ENV;
  }
  const prefix = [
    ...(mode === "profile" ? ["--cpu-prof", `--cpu-prof-dir=${profileDir}`] : []),
    "--require",
    probe,
    ...(mode === "count" ? ["--require", observer] : []),
  ];
  function start(
    label: string,
    args: string[],
    commandEnv: NodeJS.ProcessEnv,
    stdin?: string,
    runtimeRoot = repoRoot,
  ): Owned {
    assert.ok(!interrupted, "Diagnostic interrupted");
    const row: Record<string, unknown> = { label, args, startedAt: Date.now() };
    childResults.push(row);
    row.runtimeRoot = runtimeRoot;
    const child = spawn(
      process.execPath,
      [...prefix, path.join(runtimeRoot, "openclaw.mjs"), ...args],
      {
        cwd: runtimeRoot,
        env: commandEnv,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    row.pid = child.pid;
    let stderr = "";
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          Object.assign(row, {
            code,
            signal,
            endedAt: Date.now(),
            elapsedMs: Date.now() - Number(row.startedAt),
          });
          resolve({ code, signal });
        });
      },
    );
    // Attach now: the Gateway may exit before readiness has started awaiting it.
    void ended.catch(() => {});
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
    for (const [stream, kind] of [
      [child.stdout, "stdout"],
      [child.stderr, "stderr"],
    ] as const) {
      stream.on("data", (chunk: Buffer) => {
        fs.appendFileSync(path.join(output, `${label}.${kind}.log`), chunk);
        if (kind === "stderr") {
          stderr = (stderr + chunk.toString()).slice(-65536);
        }
      });
      stream.on("error", (error) => {
        row[`${kind}Error`] = error.message;
      });
    }
    child.stdin.on("error", (error) => {
      row.stdinError = error.message;
    });
    if (stdin !== undefined) {
      child.stdin.end(stdin);
    } else if (args[0] !== "gateway") {
      child.stdin.end();
    }
    const owned: Owned = { child, ended, closed, row, logs: () => stderr };
    active.add(owned);
    return owned;
  }
  async function command(
    label: string,
    args: string[],
    commandEnv = env,
    stdin?: string,
    runtimeRoot = repoRoot,
  ) {
    const owned = start(label, args, commandEnv, stdin, runtimeRoot);
    try {
      const result = await owned.ended;
      if (result.code !== 0) {
        throw new Error(
          `${label} exited code=${result.code} signal=${result.signal}; see child logs`,
        );
      }
      await stopOwned(owned);
      return fs.readFileSync(path.join(output, `${label}.stdout.log`), "utf8");
    } finally {
      await stopOwned(owned);
    }
  }
  phase("cold-bootstrap");
  const coldStarted = performance.now();
  for (const provider of ["openai", "anthropic"]) {
    await command(
      `auth-${provider}`,
      [
        "models",
        "auth",
        "--agent",
        "qa",
        "paste-api-key",
        "--provider",
        provider,
        "--profile-id",
        buildQaMockProfileId(provider),
      ],
      { ...env, OPENCLAW_CONFIG_PATH: authConfigPath },
      `sk-qa-mock-doctorperf-${provider}-not-a-real-key\n`,
    );
  }
  assert.equal(
    fs.readFileSync(configPath, "utf8"),
    configBytes,
    "Auth bootstrap mutated canonical config",
  );
  await closeQaRuntimeStores(scratch);
  const updateArgs = ["update", "--channel", "dev", "--yes", "--no-restart", "--json"];
  summary.updateArgs = updateArgs;
  async function update(label: string, runtimeRoot: string) {
    assert.equal(gitHead(runtimeRoot), driverSha, "Each update must start from the common driver");
    // Serialize the updater's real dependency installation with the campaign.
    while (true) {
      assert.ok(!interrupted, "Diagnostic interrupted");
      try {
        fs.mkdirSync(installLock);
        fs.writeFileSync(path.join(installLock, "pid"), String(process.pid));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        const pid = Number(fs.readFileSync(path.join(installLock, "pid"), "utf8"));
        assert.ok(Number.isSafeInteger(pid) && pid > 0, "Install lock has no valid owner");
        try {
          process.kill(pid, 0);
        } catch (ownerError) {
          if ((ownerError as NodeJS.ErrnoException).code !== "ESRCH") {
            throw ownerError;
          }
          fs.unlinkSync(path.join(installLock, "pid"));
          fs.rmdirSync(installLock);
          continue;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 1_000);
        });
      }
    }
    try {
      const available = fs.statfsSync(scratch);
      assert.ok(
        available.bavail * available.bsize >= 15 * 1024 ** 3,
        "Internal free disk below install threshold",
      );
      const result: UpdateRunResult = JSON.parse(
        await command(
          label,
          updateArgs,
          {
            ...env,
            OPENCLAW_BUILD_PRIVATE_QA: "1",
            PNPM_CONFIG_STORE_DIR: pnpmStore,
            npm_config_store_dir: pnpmStore,
            PNPM_CONFIG_FROZEN_LOCKFILE: "true",
            pnpm_config_frozen_lockfile: "true",
          },
          undefined,
          runtimeRoot,
        ),
      );
      assert.equal(result.status, "ok", "Native update must succeed");
      assert.equal(result.mode, "git", "Native update must use the Git owner");
      assert.equal(
        gitHead(runtimeRoot),
        targetSha,
        "Native update must activate the requested source",
      );
      const buildInfo = JSON.parse(
        fs.readFileSync(path.join(runtimeRoot, "dist/build-info.json"), "utf8"),
      );
      assert.equal(buildInfo.commit, targetSha, "Native update must activate the requested build");
      const plugins = result.postUpdate?.plugins;
      assert.ok(plugins, "Native update must complete plugin convergence");
      assert.equal(plugins.changed, false, "Fixture must leave plugin payloads unchanged");
      assert.equal(plugins.sync.changed, false, "Fixture must leave plugin sources unchanged");
      assert.equal(plugins.npm.changed, false, "Fixture must leave npm plugins unchanged");
      assert.ok(result.runId, "Native update must retain its genuine run");
      const run = getUpdateRun(result.runId, { env });
      assert.equal(run?.status, "succeeded", "Native update must settle its run");
      const deferredRetirement = JSON.parse(
        fs.readFileSync(path.join(output, `retirement-deferred-${result.runId}.json`), "utf8"),
      );
      assert.equal(deferredRetirement.step, "finalize:doctor:model-retirement");
      assert.equal(deferredRetirement.status, "skipped");
      assert.ok(
        run.steps.some(
          (step: { step: string; status: string }) =>
            step.step === "finalize:doctor:model-retirement" && step.status === "completed",
        ),
        "Second Doctor must complete the genuine retirement obligation",
      );
      return {
        status: result.status,
        mode: result.mode,
        commit: buildInfo.commit,
        plugins,
        deferredRetirement,
        retirement: "completed-after-deferral",
      };
    } finally {
      fs.unlinkSync(path.join(installLock, "pid"));
      fs.rmdirSync(installLock);
    }
  }
  phase("cold-update");
  const coldUpdateStarted = performance.now();
  summary.coldUpdate = await update("cold-update", coldDriverRoot);
  summary.coldUpdateMs = performance.now() - coldUpdateStarted;
  async function launchGateway(label: string, runtimeRoot: string) {
    const gatewayEnv = {
      ...env,
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
      OPENCLAW_GATEWAY_HOST_LIFELINE: "stdin",
    };
    const owned = start(
      label,
      ["gateway", "run", "--port", String(port), "--bind", "loopback", "--allow-unconfigured"],
      gatewayEnv,
      undefined,
      runtimeRoot,
    );
    const health = { baseUrl, logs: owned.logs, child: owned.child, timeoutMs: 120_000 };
    await waitForGatewayListening(health);
    await waitForGatewayReady(health);
    rpc = await startQaGatewayRpcClient({ wsUrl, token, logs: owned.logs });
    assert.ok(rpc);
    await rpc.request("config.get", {}, { timeoutMs: 30_000 });
    await transport.waitReady({ gateway: { call: rpc.request.bind(rpc) } });
    return owned;
  }
  phase("cold-gateway");
  let gateway = await launchGateway("cold-gateway", coldDriverRoot);
  summary.coldBootstrapMs = performance.now() - coldStarted;
  phase("cold-ready");
  if (!values["cold-only"]) {
    await rpc?.stop();
    rpc = undefined;
    await stopOwned(gateway);
    await closeQaRuntimeStores(scratch);
    assert.ok(warmDriverRoot);
    phase("warm-update");
    const warmStarted = performance.now();
    summary.warmUpdate = await update("warm-update", warmDriverRoot);
    summary.warmUpdateMs = performance.now() - warmStarted;
    phase("warm-gateway");
    gateway = await launchGateway("warm-gateway", warmDriverRoot);
    summary.warmUpdateAndGatewayMs = performance.now() - warmStarted;
    phase("warm-ready");
  }
  summary.completed = true;
} catch (error) {
  summary.completed = false;
  summary.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  phase("shutdown");
  const errors: string[] = [];
  try {
    await rpc?.stop();
  } catch (error) {
    errors.push(String(error));
  }
  const stopped = await Promise.allSettled([...active].map(stopOwned));
  errors.push(
    ...stopped
      .filter((result) => result.status === "rejected")
      .map((result) => String(result.reason)),
  );
  const cleanupFailed = active.size > 0;
  for (const stop of [() => bus?.stop(), () => mock?.stop(), () => closeStores?.(scratch)]) {
    try {
      await stop();
    } catch (error) {
      errors.push(String(error));
    }
  }
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  summary.cleanup = { process: cleanupFailed ? "unconfirmed" : "confirmed-stopped", errors };
  summary.elapsedMs = Date.now() - startedAt;
  summary.loadAtEnd = os.loadavg();
  if (errors.length || cleanupFailed || interrupted) {
    process.exitCode = 1;
    summary.completed = false;
  }
  if (interrupted) {
    summary.interrupted = true;
  }
  if (process.exitCode !== 1) {
    fs.rmSync(scratch, { recursive: true, force: true });
  } else {
    summary.retainedSyntheticScratch = scratch;
  }
  fs.writeFileSync(path.join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary));
}
