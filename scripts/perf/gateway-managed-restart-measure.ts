// macOS, synthetic state only. Run with node --import ./scripts/tsx.mjs.
// --entry <compiled dist/entry.js> --output <fresh directory> --observer-root <frozen harness>
// Optional --cpu-prof records every Node thread. The caller owns timing/load admission
// and alternates built revisions; this script performs one native managed restart.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";

const { values } = parseArgs({
  options: {
    entry: { type: "string" },
    output: { type: "string" },
    "observer-root": { type: "string" },
    "cpu-prof": { type: "boolean", default: false },
  },
});
assert.equal(process.platform, "darwin", "Native LaunchAgent workload requires macOS");
assert.ok(values.entry && values.output && values["observer-root"], "Missing required argument");
const entry = fs.realpathSync(values.entry);
assert.equal(path.basename(entry), "entry.js", "Use a compiled dist/entry.js");
assert.equal(path.basename(path.dirname(entry)), "dist", "Use a compiled dist/entry.js");
const output = path.resolve(values.output);
const observerRoot = fs.realpathSync(values["observer-root"]);
for (const name of ["observer.cjs", "causality.cjs", "background-roots.json"]) {
  assert.ok(fs.statSync(path.join(observerRoot, name)).isFile(), "Missing " + name);
}
assert.ok(process.env.TMPDIR, "Set TMPDIR to lane-local internal-disk scratch");
const tempRoot = fs.realpathSync(process.env.TMPDIR);
const accountHome = fs.realpathSync(os.userInfo().homedir);
assert.equal(fs.statSync(tempRoot).dev, fs.statSync(accountHome).dev, "TMPDIR must be internal");
fs.mkdirSync(output); // A fresh directory prevents accidental overwrite or mixed counts.
fs.mkdirSync(path.join(output, "profiles"));
const scratch = fs.mkdtempSync(path.join(tempRoot, "managed-restart-"));
const profile = "qa-boottime-" + randomUUID();
const state = path.join(scratch, "state");
const profilePath = path.join(accountHome, ".openclaw-" + profile);
const label = "ai.openclaw." + profile;
const target = "gui/" + process.getuid!() + "/" + label;
const plistPath = path.join(accountHome, "Library", "LaunchAgents", label + ".plist");
const trashPath = path.join(accountHome, ".Trash", label + ".plist");
const logPath = path.join(
  accountHome,
  "Library",
  "Logs",
  "openclaw",
  "gateway-" + profile + ".log",
);
const errorLogPath = logPath.replace(/\.log$/, ".err.log");
const phasePath = path.join(output, "phase");
const preload = path.join(output, "native-counts.cjs");
const profileArgs = values["cpu-prof"]
  ? ["--cpu-prof", "--cpu-prof-dir=" + path.join(output, "profiles")]
  : [];
const nodeOptions = "--require=" + JSON.stringify(preload);
const token = randomUUID();
const abort = new AbortController();
const interrupt = () => abort.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const summary: Record<string, unknown> = {
  completed: false,
  entry,
  node: process.version,
  entrySha256: createHash("sha256").update(fs.readFileSync(entry)).digest("hex"),
  platform: process.platform + "/" + process.arch,
  loadAtStart: os.loadavg(),
  cpuProfiles: values["cpu-prof"],
  fixture: "fresh synthetic canonical profile; loopback token auth; one native restart",
  timingScope:
    "Initial install to authenticated read; restart command to exit and subsequent authenticated read. " +
    "The post-CLI read is not the earliest serving time; no serving-to-child-exit timing is claimed.",
  countScope:
    "Counts are separated by phase and process role. Gateway thread0 counts are runtime MAIN; " +
    "restart-cli and helper thread0 counts are reported separately. Failed and prepare SQL are excluded.",
};
function phase(name: string) {
  fs.writeFileSync(phasePath, name);
  fs.appendFileSync(
    path.join(output, "phases.jsonl"),
    JSON.stringify({ name, time: Date.now() }) + "\n",
  );
}
phase("setup");

// Only fixed operation names and executable basenames leave the native boundary.
fs.writeFileSync(
  preload,
  String.raw`
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const wt = require('node:worker_threads');
const { syncBuiltinESMExports } = require('node:module');
const root = ${JSON.stringify(output)};
const gatewayEntry = ${JSON.stringify(entry)};
const profileArgs = ${JSON.stringify(profileArgs)};
const ownOptions = ${JSON.stringify(nodeOptions)};
function processRole() {
  if (!wt.isMainThread) return process.env.BOOTTIME_PROCESS_ROLE || 'helper';
  let main;
  try { main = fs.realpathSync(process.argv[1]); } catch { return 'helper'; }
  if (main !== gatewayEntry) return 'helper';
  const args = process.argv.slice(2);
  const gateway = args.indexOf('gateway');
  if (gateway < 0) return 'helper';
  const command = args[gateway + 1];
  if (command === 'restart') return 'restart-cli';
  return !command || command.startsWith('-') || command === 'run' ? 'gateway' : 'helper';
}
const role = processRole();
process.env.BOOTTIME_PROCESS_ROLE = role;
process.env.SQLMEASURE_OUT = root;
require(${JSON.stringify(path.join(observerRoot, "observer.cjs"))});
const fd = fs.openSync(path.join(root, 'native-' + process.pid + '-' + wt.threadId + '.jsonl'), 'a');
function record(event) {
  fs.writeSync(fd, JSON.stringify({ time: Date.now(), pid: process.pid, threadId: wt.threadId,
    phase: fs.readFileSync(path.join(root, 'phase'), 'utf8').trim(),
    role, ...event }) + '\n');
}
function operation(file, args) {
  const executable = path.basename(file);
  const category = executable === 'launchctl' ? 'service-' +
    (['print', 'print-disabled', 'kickstart', 'bootout', 'bootstrap', 'enable', 'disable'].find(x => args.includes(x)) || 'other')
    : executable === 'ps' ? (args.includes('user=') ? 'process-user' : 'process-command')
    : executable === 'lsof' || executable === 'ss' ? 'port-inspection'
    : executable === 'node' ? 'node-runtime' : 'other';
  return { executable, category };
}
record({ type: 'thread-start', main: wt.isMainThread });
const nativeSpawn = cp.ChildProcess.prototype.spawn;
cp.ChildProcess.prototype.spawn = function(options) {
  const previousOptions = options.envPairs.find(value => value.startsWith('NODE_OPTIONS='))?.slice(13) || '';
  const envPairs = options.envPairs.filter(value => !value.startsWith('NODE_OPTIONS=') && !value.startsWith('SQLMEASURE_OUT='));
  envPairs.push('NODE_OPTIONS=' + (previousOptions.includes(__filename) ? previousOptions : previousOptions + ' ' + ownOptions), 'SQLMEASURE_OUT=' + root);
  const node = path.basename(options.file) === path.basename(process.execPath);
  const args = node && profileArgs.length && !options.args.includes('--cpu-prof')
    ? [options.args[0], ...profileArgs, ...options.args.slice(1)] : options.args;
  const started = performance.now();
  const result = nativeSpawn.call(this, { ...options, args, envPairs });
  const detail = operation(options.file, options.args);
  record({ type: 'spawn', childPid: this.pid, ...detail });
  this.once('exit', (code, signal) => record({ type: 'child-exit', childPid: this.pid,
    ...detail, code, signal, elapsedMs: performance.now() - started }));
  return result;
};
for (const name of ['spawnSync', 'execFileSync', 'execSync']) {
  const original = cp[name];
  cp[name] = function(file, ...args) {
    record({ type: 'spawn', ...(name === 'execSync'
      ? { executable: 'shell', category: 'other' }
      : operation(file, Array.isArray(args[0]) ? args[0] : [])) });
    return Reflect.apply(original, this, [file, ...args]);
  };
}
const OriginalWorker = wt.Worker;
wt.Worker = class extends OriginalWorker {
  constructor(filename, options = {}) {
    const execArgv = options.execArgv || process.execArgv;
    const env = options.env === wt.SHARE_ENV ? wt.SHARE_ENV
      : { ...(options.env || process.env), BOOTTIME_PROCESS_ROLE: role };
    super(filename, { ...options, env, execArgv: [...execArgv,
      ...profileArgs.filter(arg => !execArgv.includes(arg)), '--require', __filename] });
  }
};
syncBuiltinESMExports();
process.once('exit', code => record({ type: 'thread-exit', code,
  cpu: process.threadCpuUsage(), processCpu: wt.isMainThread ? process.cpuUsage() : undefined }));
`,
);

let command: ChildProcess | undefined;
let ownsPaths = false;
let profileLinked = false;
let installAttempted = false;
let uninstall: (() => Promise<void>) | undefined;
let verifyUnloaded: (() => Promise<void>) | undefined;
const sink = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

async function authenticatedHealth(port: number) {
  const client = createGatewayWsClient({
    url: "ws://127.0.0.1:" + port,
    openTimeoutMs: 1_000,
    handshakeTimeoutMs: 1_000,
  });
  try {
    await client.waitOpen();
    const connected = await client.request(
      "connect",
      {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: { id: "gateway-client", version: "1.0.0", platform: "darwin", mode: "backend" },
        role: "operator",
        scopes: ["operator.read"],
        auth: { token },
        caps: [],
      },
      5_000,
    );
    assert.equal(connected.ok, true, "Synthetic token admission failed");
    const health = await client.request("health", {}, 5_000);
    assert.equal(health.ok, true, "Health RPC failed");
    assert.ok(
      health.payload && typeof health.payload === "object" && "coreReady" in health.payload,
    );
    assert.equal(health.payload.coreReady, true, "Gateway core is not ready");
  } finally {
    client.ws.terminate();
  }
}

async function waitReady(port: number) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    abort.signal.throwIfAborted();
    try {
      await authenticatedHealth(port);
      return;
    } catch {
      // Readiness retries do not repeat the restart command.
      await delay(250, undefined, { signal: abort.signal });
    }
  }
  throw new Error("Synthetic Gateway authenticated-read deadline exceeded");
}

function collectCounts(): unknown {
  // Keep the frozen analyze.py splitter exact: quoted semicolons and trigger bodies
  // make splitting SQL on semicolons an invalid statement count.
  const result = spawnSync(
    "python3",
    [
      "-c",
      String.raw`
import json, pathlib, re, sqlite3, sys
root = pathlib.Path(sys.argv[1])
roles = ('gateway', 'restart-cli', 'helper')
threads = {}
def records(file):
    with file.open() as stream:
        for line in stream:
            if line.strip(): yield json.loads(line)
def statements(sql):
    result=[];buffer=''
    for ch in sql:
        buffer+=ch
        if ch==';' and sqlite3.complete_statement(buffer):
            if re.sub(r'/\*.*?\*/|--[^\n]*','',buffer,flags=re.S).strip(' ;\n\t\r'):result.append(buffer.strip())
            buffer=''
    if re.sub(r'/\*.*?\*/|--[^\n]*','',buffer,flags=re.S).strip(' ;\n\t\r'):result.append(buffer.strip())
    return result
def empty():
    return dict(statements=0, requests=0, thread0Statements=0, thread0Requests=0, native={})
totals = {role: empty() for role in roles}
phases = {}
def buckets(phase, role):
    assert role in roles, 'Unknown process role'
    return totals[role], phases.setdefault(phase, {}).setdefault(role, empty())
for file in sorted(root.glob('native-*.jsonl')):
    for row in records(file):
        if row['type'] == 'thread-start':
            key = (row['pid'], row['threadId'])
            assert row['role'] in roles, 'Unknown process role'
            assert key not in threads or threads[key] == row['role'], 'Conflicting process role'
            threads[key] = row['role']
for file in sorted(root.glob('sql-*.jsonl')):
    sites = {}
    role = None
    for row in records(file):
        if isinstance(row, list):
            assert role is not None, 'SQL event without process metadata'
            site = sites[row[1]]
            if site['method'] == 'prepare' or not site['ok']: continue
            count = len(statements(site['sql'])) if site['method'] == 'exec' else 1
            for bucket in buckets(row[0], role):
                bucket['statements'] += count
                if thread == 0: bucket['thread0Statements'] += count
        elif row['type'] == 'process':
            thread = row['threadId']
            role = threads[(row['pid'], thread)]
        elif row['type'] == 'site':
            sites[row['id']] = row
        elif row['type'] == 'request':
            assert role is not None, 'Request without process metadata'
            for bucket in buckets(row['phase'], role):
                bucket['requests'] += 1
                if thread == 0: bucket['thread0Requests'] += 1
for file in sorted(root.glob('native-*.jsonl')):
    for row in records(file):
        if row['type'] == 'spawn':
            role = threads[(row['pid'], row['threadId'])]
            key = row['executable'] + ':' + row['category']
            for bucket in buckets(row['phase'], role):
                bucket['native'][key] = bucket['native'].get(key, 0) + 1
print(json.dumps(dict(totals=totals, byPhase=phases)))
`,
      output,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, "Frozen-compatible SQL count collection failed");
  return JSON.parse(result.stdout);
}

try {
  for (const ownedPath of [profilePath, plistPath, trashPath, logPath, errorLogPath]) {
    assert.equal(
      fs.lstatSync(ownedPath, { throwIfNoEntry: false }),
      undefined,
      "Synthetic fixture path already exists",
    );
  }
  ownsPaths = true;
  fs.mkdirSync(state, { mode: 0o700 });
  fs.symlinkSync(state, profilePath);
  profileLinked = true;
  const reservation = net.createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => (error ? reject(error) : resolve()));
  });
  const configPath = path.join(profilePath, "openclaw.json");
  fs.mkdirSync(path.join(scratch, "workspace"));
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      browser: { enabled: false },
      update: { checkOnStart: false },
      discovery: { mdns: { mode: "off" } },
      gateway: {
        mode: "local",
        bind: "loopback",
        port,
        auth: { mode: "token", token },
        controlUi: { enabled: false },
        tailscale: { mode: "off" },
      },
      agents: { defaults: { workspace: path.join(scratch, "workspace"), skipBootstrap: true } },
      plugins: { enabled: true, entries: { browser: { enabled: false } } },
    }),
    { mode: 0o600 },
  );
  const env: NodeJS.ProcessEnv = {
    HOME: accountHome,
    PATH:
      path.dirname(process.execPath) +
      ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
    XDG_CONFIG_HOME: path.join(scratch, "config"),
    XDG_DATA_HOME: path.join(scratch, "data"),
    XDG_CACHE_HOME: path.join(scratch, "cache"),
    OPENCLAW_HOME: accountHome,
    OPENCLAW_PROFILE: profile,
    OPENCLAW_STATE_DIR: profilePath,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_LAUNCHD_LABEL: label,
    OPENCLAW_GATEWAY_PORT: String(port),
    OPENCLAW_GATEWAY_TOKEN: token,
    OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
    OPENCLAW_NO_RESPAWN: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
    NODE_OPTIONS: nodeOptions,
    SQLMEASURE_OUT: output,
  };
  // Native service identity requires account HOME, while every state path is fixture-owned.
  Object.assign(process.env, env);
  const { installLaunchAgent, uninstallLaunchAgent } =
    await import("../../src/daemon/launchd-install.ts");
  const { stopLaunchAgent } = await import("../../src/daemon/launchd-stop.ts");
  const { buildServiceEnvironment } = await import("../../src/daemon/service-env.ts");
  const { probeLaunchAgentState } = await import("../../src/daemon/launchd-runtime.ts");
  assert.equal(
    (await probeLaunchAgentState(target)).state,
    "not-loaded",
    "Fixture label is loaded",
  );
  uninstall = async () => {
    await stopLaunchAgent({ env, stdout: sink });
    await uninstallLaunchAgent({ env, stdout: sink });
  };
  verifyUnloaded = async () => {
    assert.equal(
      (await probeLaunchAgentState(target)).state,
      "not-loaded",
      "Fixture remains loaded",
    );
    assert.equal(fs.existsSync(plistPath), false, "Fixture plist remains installed");
  };
  phase("initial-boot");
  const started = performance.now();
  installAttempted = true;
  await installLaunchAgent({
    env,
    stdout: sink,
    programArguments: [process.execPath, ...profileArgs, entry, "gateway", "--port", String(port)],
    workingDirectory: scratch,
    environment: {
      ...env,
      ...buildServiceEnvironment({ env, port, runtime: "node", launchdLabel: label }),
      NODE_OPTIONS: nodeOptions,
    },
  });
  await waitReady(port);
  summary.initialBootToAuthenticatedReadMs = performance.now() - started;
  phase("managed-restart");
  const restartStarted = performance.now();
  const stdoutFd = fs.openSync(path.join(output, "restart.stdout.log"), "w");
  const stderrFd = fs.openSync(path.join(output, "restart.stderr.log"), "w");
  try {
    command = spawn(
      process.execPath,
      [...profileArgs, entry, "gateway", "restart", "--preserve-definition", "--json"],
      {
        env,
        cwd: scratch,
        stdio: ["ignore", stdoutFd, stderrFd],
        signal: abort.signal,
      },
    );
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
  const cliCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      command?.kill("SIGTERM");
      reject(new Error("Restart CLI deadline exceeded"));
    }, 180_000);
    command!.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    command!.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert.equal(cliCode, 0, "Native restart CLI failed; inspect synthetic restart logs");
  summary.restartCliMs = performance.now() - restartStarted;
  phase("post-cli-read");
  await waitReady(port);
  summary.restartToPostCliAuthenticatedReadMs = performance.now() - restartStarted;
  summary.completed = true;
} catch (error) {
  summary.failure = error instanceof Error ? error.name : "UnknownError";
  summary.failurePhase = fs.readFileSync(phasePath, "utf8");
  process.exitCode = 1;
} finally {
  phase("cleanup");
  const cleanupErrors: string[] = [];
  if (command && command.exitCode === null && command.signalCode === null) {
    command.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => {
        command!.once("close", () => resolve());
      }),
      delay(5_000),
    ]);
    if (command.exitCode === null && command.signalCode === null) {
      command.kill("SIGKILL");
      await Promise.race([
        new Promise<void>((resolve) => {
          command!.once("close", () => resolve());
        }),
        delay(5_000),
      ]);
    }
    if (command.exitCode === null && command.signalCode === null) {
      cleanupErrors.push("restart-cli-still-running");
    }
  }
  try {
    assert.equal(cleanupErrors.length, 0, "CLI exit must be confirmed before removing its service");
    if (profileLinked) {
      assert.equal(fs.readlinkSync(profilePath), state, "Fixture link changed");
    }
    if (installAttempted) {
      assert.ok(uninstall && verifyUnloaded);
      await uninstall();
      await verifyUnloaded();
      const gatewayPids = new Set<number>();
      for (const file of fs
        .readdirSync(output)
        .filter((name) => /^native-\d+-\d+\.jsonl$/.test(name))) {
        for (const line of fs.readFileSync(path.join(output, file), "utf8").trim().split("\n")) {
          const event = JSON.parse(line);
          if (event.type === "thread-start" && event.role === "gateway") {
            gatewayPids.add(event.pid);
          }
        }
      }
      const deadline = Date.now() + 10_000;
      while (gatewayPids.size && Date.now() < deadline) {
        for (const pid of gatewayPids) {
          try {
            process.kill(pid, 0);
          } catch (error) {
            assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
            gatewayPids.delete(pid);
          }
        }
        if (gatewayPids.size) {
          await delay(100);
        }
      }
      assert.equal(gatewayPids.size, 0, "Observed fixture Gateways must exit before state removal");
    }
    if (profileLinked) {
      fs.unlinkSync(profilePath);
    }
    if (ownsPaths) {
      for (const ownedPath of [trashPath, logPath, errorLogPath]) {
        if (summary.completed === false && fs.existsSync(ownedPath) && ownedPath !== trashPath) {
          fs.copyFileSync(ownedPath, path.join(output, path.basename(ownedPath)));
        }
        fs.rmSync(ownedPath, { force: true });
      }
    }
    fs.rmSync(scratch, { recursive: true });
  } catch {
    cleanupErrors.push("fixture-cleanup-unconfirmed");
    summary.retainedSyntheticScratch = scratch;
    summary.retainedServiceTarget = target;
  }
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  summary.cleanupErrors = cleanupErrors;
  summary.loadAtEnd = os.loadavg();
  if (cleanupErrors.length || abort.signal.aborted) {
    summary.completed = false;
    process.exitCode = 1;
  }
  try {
    summary.counts = collectCounts();
  } catch {
    summary.completed = false;
    summary.countFailure = "frozen-compatible-count-collection-failed";
    process.exitCode = 1;
  }
  fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary));
}
