import { spawn as spawnChild } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ManagedRun, RunExit, SpawnInput } from "../process/supervisor/types.js";
import { DURABLE_LAUNCHD_WRAPPER_SOURCE } from "./bash-process-launchd-wrapper.js";
import {
  cleanupDurableProcess,
  durableProcessUnitName,
  launchDurableProcess,
  readDurableProcess,
  requireDurableProcessHost,
} from "./bash-process-launchd.js";

const { spawn } = vi.hoisted(() => ({
  spawn: vi.fn<(input: SpawnInput) => Promise<ManagedRun>>(),
}));
// mock-isolation: launchctl would load real jobs into the test host's launchd.
vi.mock("../process/supervisor/index.js", () => ({ getProcessSupervisor: () => ({ spawn }) }));
vi.mock("../infra/executable-path.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/executable-path.js")>()),
  resolveExecutablePath: (name: string) => `/bin/${name}`,
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const label = durableProcessUnitName("quiet-raven:0123456789ab");
let stateDir: string;
const statusFile = () => path.join(stateDir, "processes", `${label}.status.json`);
function respond(stdout = "", exitCode = 0) {
  const exit: RunExit = {
    reason: "exit",
    stdout,
    stderr: "",
    exitCode,
    exitSignal: null,
    durationMs: 1,
    timedOut: false,
    noOutputTimedOut: false,
  };
  spawn.mockImplementationOnce(async (input) => {
    input.assertCurrent?.();
    return {
      runId: "helper",
      activity: { resultSettled: true, lastOutputAtMs: 0 },
      startedAtMs: 0,
      wait: async () => exit,
      cancel() {},
    };
  });
}
const list = (row?: string) =>
  respond(`PID\tStatus\tLabel\n-\t0\tcom.apple.unrelated\n${row ? `${row}\n` : ""}`);

beforeEach(async () => {
  Object.defineProperty(process, "platform", { ...originalPlatform, value: "darwin" });
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-launchd-"));
  await fs.mkdir(path.join(stateDir, "processes"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  spawn.mockReset();
});
afterEach(async () => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.unstubAllEnvs();
  await fs.rm(stateDir, { recursive: true, force: true });
});

it("refuses hosts outside a logged-in Aqua session", async () => {
  respond("Background\n");
  await expect(requireDurableProcessHost()).rejects.toThrow("logged-in user's GUI (Aqua)");
  respond("Aqua\n");
  await expect(requireDurableProcessHost()).resolves.toBeUndefined();
});

it("bootstraps a private job through the supervisor without command env in the plist", async () => {
  respond();
  const assertCurrent = vi.fn();
  await launchDurableProcess({
    id: "quiet-raven:0123456789ab",
    argv: ["/bin/sh", "-c", "echo hi"],
    env: { GH_TOKEN: "synthetic-launch-secret" },
    cwd: "/workspace",
    logPath: path.join(stateDir, "processes", "job.log"),
    timeoutMs: 1000,
    assertCurrent,
  });
  const call = spawn.mock.calls[0]![0];
  expect(call.mode === "child" && call.argv.slice(1, 3)).toEqual([
    "bootstrap",
    `gui/${process.getuid!()}`,
  ]);
  expect(assertCurrent).toHaveBeenCalledOnce();
  const plistPath = path.join(stateDir, "processes", `${label}.plist`);
  const plist = await fs.readFile(plistPath, "utf8");
  expect(plist).toContain("<string>Interactive</string>");
  expect(plist).not.toContain("synthetic-launch-secret");
  expect((await fs.stat(plistPath)).mode & 0o777).toBe(0o644);
  const spec = path.join(stateDir, "processes", `${label}.spec.json`);
  expect((await fs.stat(spec)).mode & 0o777).toBe(0o600);
});

it("treats a failed or unparsable launchctl list as unknown, never missing", async () => {
  respond("", 1);
  await expect(readDurableProcess(label)).rejects.toThrow("not confirmed");
  respond("something else entirely\n");
  await expect(readDurableProcess(label)).rejects.toThrow("not confirmed");
});

it("maps launchd and wrapper facts to durable observations", async () => {
  list(`4242\t0\t${label}`);
  await expect(readDurableProcess(label)).resolves.toEqual({ state: "running", pid: 4242 });
  // Loaded, no PID, no status file: launchd has not started the wrapper yet.
  list(`-\t0\t${label}`);
  await expect(readDurableProcess(label)).resolves.toEqual({ state: "running" });
  list();
  await expect(readDurableProcess(label)).resolves.toEqual({ state: "missing" });
});

it("checks the recorded process group after the wrapper is killed", async () => {
  const group = spawnChild("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
  try {
    await fs.writeFile(statusFile(), JSON.stringify({ phase: "running", pgid: group.pid }));
    list(`-\t-9\t${label}`);
    await expect(readDurableProcess(label)).resolves.toEqual({ state: "running" });
  } finally {
    process.kill(-group.pid!, "SIGKILL");
  }
  await once(group, "exit");
  list(`-\t-9\t${label}`);
  await expect(readDurableProcess(label)).resolves.toMatchObject({
    state: "exited",
    reason: "spawn-error",
    result: "supervisor-lost",
  });
});

it("reports the wrapper's recorded duration and releases the job files", async () => {
  await fs.writeFile(
    statusFile(),
    JSON.stringify({
      phase: "exited",
      exitCode: 3,
      exitSignal: null,
      reason: "exit",
      durationMs: 1234,
    }),
  );
  await expect(readDurableProcess(label)).resolves.toMatchObject({
    state: "exited",
    exitCode: 3,
    durationMs: 1234,
  });
  respond("", 0);
  await cleanupDurableProcess(label);
  await expect(fs.stat(statusFile())).rejects.toThrow();
});

async function runWrapper(argv: string[], timeoutMs = 0) {
  const dir = path.join(stateDir, "wrapper");
  await fs.mkdir(dir, { recursive: true });
  const wrapper = path.join(dir, "wrapper.cjs");
  await fs.writeFile(wrapper, DURABLE_LAUNCHD_WRAPPER_SOURCE);
  const spec = path.join(dir, "spec.json");
  const statusPath = path.join(dir, "status.json");
  const logPath = path.join(dir, "out.log");
  await fs.writeFile(
    spec,
    JSON.stringify({
      argv,
      cwd: dir,
      env: { PATH: "/usr/bin:/bin", SECRET: "s" },
      logPath,
      statusPath,
      timeoutMs,
      killGraceMs: 500,
    }),
  );
  const child = spawnChild(process.execPath, [wrapper, spec], { stdio: "ignore" });
  const [code] = await once(child, "exit");
  await expect(fs.stat(spec)).rejects.toThrow();
  return {
    code,
    status: JSON.parse(await fs.readFile(statusPath, "utf8")),
    log: await fs.readFile(logPath, "utf8"),
  };
}

it("wrapper records exit code, output and duration after the whole group ends", async () => {
  const started = Date.now();
  const run = await runWrapper([
    "/bin/sh",
    "-c",
    'echo "$SECRET-out"; (sleep 1; echo child-done) & exit 7',
  ]);
  expect(run.status).toMatchObject({
    phase: "exited",
    exitCode: 7,
    exitSignal: null,
    reason: "exit",
  });
  expect(run.log).toBe("s-out\nchild-done\n");
  expect(run.status.durationMs).toBeGreaterThanOrEqual(900);
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);
});

it("wrapper enforces the timeout on the process group", async () => {
  const run = await runWrapper(["/bin/sh", "-c", "trap '' TERM; sleep 30 & wait"], 300);
  expect(run.status).toMatchObject({ phase: "exited", reason: "overall-timeout" });
  expect(run.status.exitSignal).toMatch(/^SIG(TERM|KILL)$/);
  expect(run.status.durationMs).toBeLessThan(5000);
});
