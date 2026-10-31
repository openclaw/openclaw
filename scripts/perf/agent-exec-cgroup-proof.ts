/**
 * Kernel placement regression, run inside an isolated Delegate=yes,
 * DelegateSubgroup=gateway systemd service on Linux. Requires --device MAJ:MIN
 * and an isolated OPENCLAW_STATE_DIR. Build this entry with the repository's
 * esbuild into each already-built revision's dist directory (packages external).
 * The fixture prepares discoverable kernel policy. This proves placement,
 * not startup delegation admission; production
 * startup is covered separately by team-shape-stress --exec-io-storm.
 * Baseline must fail placement assertions.
 * Add --repo <disposable-synthetic-repository> --samples 5 to measure real
 * managed creation and record each Git child's kernel cgroup before exec.
 * Use distinct state directories for serial AB/BA and A/A runs; --allocation
 * adds a separate 32 KiB inspector sampling pass. CPU covers this host process,
 * allocations cover its main isolate; neither includes native Git or workers.
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { runExecProcess } from "../../src/agents/bash-tools.exec-runtime.js";
import { execCommand } from "../../src/agents/sessions/exec.js";
import { spawnCommand } from "../../src/process/exec-spawn.js";
import { BrokerChild } from "../../src/process/spawn-broker/child.js";
import { runWithSpawnBroker } from "../../src/process/spawn-broker/context.js";
import { createSpawnBrokerHost } from "../../src/process/spawn-broker/host.js";
import { spawnProcess } from "../../src/process/spawn-utils.js";
import { shutdownProcessSupervisor } from "../../src/process/supervisor/index.js";
import { createProcessSupervisor } from "../../src/process/supervisor/supervisor.js";
import { spawnTerminalPty } from "../../src/process/terminal-pty.js";

const { values } = parseArgs({
  options: {
    device: { type: "string" },
    repo: { type: "string" },
    samples: { type: "string", default: "1" },
    allocation: { type: "boolean" },
    "io-bytes": { type: "string", default: "84095180" },
  },
});
assert.equal(process.platform, "linux");
assert.match(values.device ?? "", /^\d+:\d+$/u);
const own = fs.readFileSync("/proc/self/cgroup", "utf8").trim();
assert.match(own, /^0::\/.+\.service\/gateway$/u);
const root = path.dirname(path.join("/sys/fs/cgroup", own.slice(3)));
assert.equal(fs.readFileSync(path.join(root, "cgroup.procs"), "utf8").trim(), "");
fs.writeFileSync(path.join(root, "cgroup.subtree_control"), "+cpu +io +memory");
const group = path.join(root, "agent-exec");
fs.mkdirSync(group);
fs.writeFileSync(path.join(group, "cpu.weight"), "10");
const ioBytes = Number(values["io-bytes"]);
assert(Number.isSafeInteger(ioBytes) && ioBytes > 0);
fs.writeFileSync(
  path.join(group, "io.max"),
  `${values.device} rbps=${ioBytes} wbps=${ioBytes} riops=20531 wiops=20531`,
);
fs.writeFileSync(path.join(group, "memory.high"), "1073741824");
const expected = own.replace(/\/gateway$/u, "/agent-exec");
const code = `const fs = require('node:fs'); const cp = require('node:child_process'); console.log(JSON.stringify({self:fs.readFileSync('/proc/self/cgroup','utf8').trim(),descendant:cp.execFileSync(process.execPath,['-e',"process.stdout.write(require('node:fs').readFileSync('/proc/self/cgroup','utf8').trim())"],{encoding:'utf8'})}));`;
const observations: Array<{ route: string; self: string; descendant?: string; expected: string }> =
  [];
function record(route: string, stdout: string, target = expected) {
  const observed: { self: string; descendant: string } = JSON.parse(stdout.trim());
  observations.push({ route, ...observed, expected: target });
  console.log(JSON.stringify(observations.at(-1)));
}
async function output(child: ChildProcess): Promise<string> {
  if (child instanceof BrokerChild) {
    await child.ready();
  }
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data) => {
      stdout += data;
    });
    child.stderr?.on("data", (data) => {
      stderr += data;
    });
    child.once("error", reject);
    child.once("close", (exit) =>
      exit === 0 ? resolve(stdout) : reject(new Error(stderr || `child exit ${exit}`)),
    );
  });
}
const broker = createSpawnBrokerHost();
const supervisor = createProcessSupervisor();
try {
  await broker.ready();
  await runWithSpawnBroker(broker, async () => {
    record(
      "gateway-broker-raw",
      await output(
        spawnProcess(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "pipe"] }),
      ),
      own,
    );
    const command = await spawnCommand([process.execPath, "-e", code]);
    record("gateway-broker-execa", String(command.stdout), own);
    record(
      "agent-broker-raw",
      await output(
        spawnProcess(
          process.execPath,
          ["-e", code],
          { stdio: ["ignore", "pipe", "pipe"] },
          undefined,
          "agent-tool",
        ),
      ),
    );
    const agentCommand = await spawnCommand([process.execPath, "-e", code], {
      executionIntent: "agent-tool",
    });
    record("agent-broker-execa", agentCommand.stdout);
    record(
      "sqlite-worker-transport",
      await output(
        broker.spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "pipe"] }),
      ),
      own,
    );
  });
  const run = await supervisor.spawn({
    executionIntent: "agent-tool",
    runId: "cgroup-no-broker",
    mode: "child",
    argv: [process.execPath, "-e", code],
    cwd: process.env.OPENCLAW_STATE_DIR,
    memoryLimitBytes: 1024 ** 3,
    timeoutMs: 30_000,
  });
  const outcome = await run.wait();
  assert.equal(outcome.exitCode, 0, outcome.stderr);
  record("no-broker-anchor", outcome.stdout);
  await run.waitForExtinction?.();
  const secretRun = await supervisor.spawn({
    executionIntent: "agent-tool",
    runId: "cgroup-secret-fd",
    mode: "child",
    argv: [process.execPath, "-e", `require('node:fs').readFileSync(3); ${code}`],
    cwd: process.env.OPENCLAW_STATE_DIR,
    memoryLimitBytes: 1024 ** 3,
    timeoutMs: 30_000,
    secretInput: { fd: 3, createData: () => Buffer.from("synthetic-input") },
  });
  const secretOutcome = await secretRun.wait();
  assert.equal(secretOutcome.exitCode, 0, secretOutcome.stderr);
  record("no-broker-secret-fd", secretOutcome.stdout);
  await secretRun.waitForExtinction?.();
  const extensionOutcome = await execCommand(process.execPath, ["-e", code], process.cwd());
  assert.equal(extensionOutcome.code, 0, extensionOutcome.stderr);
  record("no-broker-extension-exec", extensionOutcome.stdout);
  const pty = await spawnTerminalPty({
    executionIntent: "agent-tool",
    file: process.execPath,
    args: ["-e", code],
    cwd: process.env.OPENCLAW_STATE_DIR,
    cols: 120,
    rows: 24,
  });
  const terminal = await new Promise<string>((resolve, reject) => {
    let text = "";
    pty.onData((data) => {
      text += data;
    });
    pty.onExit(({ exitCode }) => (exitCode === 0 ? resolve(text) : reject(new Error(text))));
  });
  record("pty-helper", terminal);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await runWithSpawnBroker(broker, async () => {
    const exec = await runExecProcess({
      command: `${quote(process.execPath)} -e ${quote(code)}`,
      workdir: process.env.OPENCLAW_STATE_DIR!,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      usePty: false,
      warnings: [],
      maxOutput: 16_384,
      pendingMaxOutput: 16_384,
      notifyOnExit: false,
      timeoutSec: 30,
    });
    const execOutcome = await exec.promise;
    assert.equal(execOutcome.status, "completed", execOutcome.aggregated);
    record("agent-exec-runtime", execOutcome.aggregated);
  });
  if (values.repo) {
    const state = process.env.OPENCLAW_STATE_DIR;
    assert(state, "--repo requires isolated OPENCLAW_STATE_DIR");
    const samples = Number(values.samples);
    assert(Number.isSafeInteger(samples) && samples > 0);
    const bin = path.join(state, "cgroup-git-bin");
    const trace = path.join(state, "git-cgroups.log");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh\n/bin/cat /proc/self/cgroup >> ${quote(trace)}\nexec ${quote(realGit)} "$@"\n`,
      { mode: 0o755 },
    );
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
    const config = {};
    setRuntimeConfigSnapshot(config, config);
    const { ManagedWorktreeService } = await import("../../src/agents/worktrees/service.js");
    const { drainGlobalSingletonLifecycleState } =
      await import("../../src/shared/global-singleton.js");
    try {
      await runWithSpawnBroker(broker, async () => {
        for (let index = 0; index < samples; index++) {
          fs.writeFileSync(trace, "");
          const inspector = new Session();
          if (values.allocation) {
            inspector.connect();
            await inspector.post("HeapProfiler.startSampling", {
              samplingInterval: 32768,
              includeObjectsCollectedByMajorGC: true,
              includeObjectsCollectedByMinorGC: true,
            });
          }
          const cpu = process.cpuUsage();
          const loadBefore = loadavg();
          const started = performance.now();
          const created = await new ManagedWorktreeService().create({
            repoRoot: path.resolve(values.repo!),
            name: `cgroup-proof-${process.pid}-${index}`,
            ownerKind: "session",
            ownerId: `synthetic-${index}`,
            runSetupScript: false,
            provisionIgnoredFiles: false,
          });
          const elapsedMs = performance.now() - started;
          const used = process.cpuUsage(cpu);
          let allocatedBytes: number | undefined;
          if (values.allocation) {
            const { profile } = await inspector.post("HeapProfiler.stopSampling");
            allocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
            inspector.disconnect();
          }
          const groups = fs.readFileSync(trace, "utf8").trim().split("\n");
          assert(groups.length > 0 && groups[0], "managed preparation must launch Git");
          console.log(
            JSON.stringify({
              route: "managed-worktree",
              index,
              elapsedMs,
              hostCpuMs: (used.user + used.system) / 1000,
              hostSampledAllocatedBytes: allocatedBytes,
              gitChildren: groups.length,
              gitCgroups: [...new Set(groups)],
              loadBefore,
              loadAfter: loadavg(),
              path: created.path,
            }),
          );
          for (const gitGroup of groups) {
            observations.push({
              route: "managed-worktree-git",
              self: gitGroup,
              expected: own,
            });
          }
        }
      });
    } finally {
      process.env.PATH = oldPath;
      await drainGlobalSingletonLifecycleState();
    }
  }
  assert.equal(fs.readFileSync("/proc/self/cgroup", "utf8").trim(), own);
  assert.equal(fs.readFileSync(`/proc/${broker.pid}/cgroup`, "utf8").trim(), own);
  for (const observation of observations) {
    assert.equal(observation.self, observation.expected, observation.route);
    if (observation.descendant !== undefined) {
      assert.equal(observation.descendant, observation.expected, `${observation.route} descendant`);
    }
  }
} finally {
  await shutdownProcessSupervisor();
  await supervisor.shutdown();
  await broker.close();
}
