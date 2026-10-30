/**
 * Kernel placement regression, run inside an isolated Delegate=yes,
 * DelegateSubgroup=gateway systemd service on Linux. Requires --device MAJ:MIN
 * and an isolated OPENCLAW_STATE_DIR. Build this entry with the repository's
 * esbuild into each already-built revision's dist directory (packages external).
 * The fixture prepares discoverable kernel policy. This proves placement,
 * not startup delegation admission; production
 * startup is covered separately by team-shape-stress --exec-io-storm.
 * Baseline must fail placement assertions.
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { execCommand } from "../../src/agents/sessions/exec.js";
import { spawnCommand } from "../../src/process/exec-spawn.js";
import { BrokerChild } from "../../src/process/spawn-broker/child.js";
import { runWithSpawnBroker } from "../../src/process/spawn-broker/context.js";
import { createSpawnBrokerHost } from "../../src/process/spawn-broker/host.js";
import { spawnProcess } from "../../src/process/spawn-utils.js";
import { createProcessSupervisor } from "../../src/process/supervisor/supervisor.js";
import { spawnTerminalPty } from "../../src/process/terminal-pty.js";

const { values } = parseArgs({ options: { device: { type: "string" } } });
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
fs.writeFileSync(
  path.join(group, "io.max"),
  `${values.device} rbps=16777216 wbps=16777216 riops=4096 wiops=4096`,
);
fs.writeFileSync(path.join(group, "memory.high"), "1073741824");
const expected = own.replace(/\/gateway$/u, "/agent-exec");
const code = `const fs = require('node:fs'); const cp = require('node:child_process'); console.log(JSON.stringify({self:fs.readFileSync('/proc/self/cgroup','utf8').trim(),descendant:cp.execFileSync(process.execPath,['-e',"process.stdout.write(require('node:fs').readFileSync('/proc/self/cgroup','utf8').trim())"],{encoding:'utf8'})}));`;
const observations: Array<{ route: string; self: string; descendant: string; expected: string }> =
  [];
function record(route: string, stdout: string, target = expected) {
  const observed: { self: string; descendant: string } = JSON.parse(stdout.trim());
  observations.push({ route, ...observed, expected: target });
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
      "broker-raw",
      await output(
        spawnProcess(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "pipe"] }),
      ),
    );
    const command = await spawnCommand([process.execPath, "-e", code]);
    record("broker-execa", String(command.stdout));
    record(
      "sqlite-worker-transport",
      await output(
        broker.spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "pipe"] }),
      ),
      own,
    );
  });
  const run = await supervisor.spawn({
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
  assert.equal(fs.readFileSync("/proc/self/cgroup", "utf8").trim(), own);
  assert.equal(fs.readFileSync(`/proc/${broker.pid}/cgroup`, "utf8").trim(), own);
  console.log(JSON.stringify({ observations }, null, 2));
  for (const observation of observations) {
    assert.equal(observation.self, observation.expected, observation.route);
    assert.equal(observation.descendant, observation.expected, `${observation.route} descendant`);
  }
} finally {
  await supervisor.shutdown();
  await broker.close();
}
