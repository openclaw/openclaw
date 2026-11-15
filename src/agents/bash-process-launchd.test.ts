import { spawn as spawnChild } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ManagedRun, SpawnInput } from "../process/supervisor/types.js";
import { DURABLE_LAUNCHD_WRAPPER_SOURCE } from "./bash-process-launchd-wrapper.js";
import { launchdDurableSupervisor as supervisor } from "./bash-process-launchd.js";

const { spawn } = vi.hoisted(() => ({
  spawn: vi.fn<(input: SpawnInput) => Promise<ManagedRun>>(),
}));
// mock-isolation: launchctl would load real jobs into the test host's launchd.
vi.mock("../process/supervisor/index.js", () => ({ getProcessSupervisor: () => ({ spawn }) }));
vi.mock("../infra/executable-path.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/executable-path.js")>()),
  resolveExecutablePath: (name: string) => name,
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const label = supervisor.unitName("quiet-raven:0123456789ab");
let dir: string;
const file = (suffix: string) => path.join(dir, "processes", `${label}${suffix}`);
const status = (value: object) => fs.writeFile(file(".status.json"), JSON.stringify(value));
const activity = { resultSettled: true, lastOutputAtMs: 0 };
const respond = (stdout = "", exitCode = 0, whileInFlight?: () => Promise<unknown>) =>
  spawn.mockImplementationOnce(async (input) => {
    input.assertCurrent?.();
    await whileInFlight?.();
    const exit = { reason: "exit" as const, stdout, stderr: "", exitCode, exitSignal: null };
    const wait = async () => ({ ...exit, durationMs: 1, timedOut: false, noOutputTimedOut: false });
    return { runId: "", activity, startedAtMs: 0, wait, cancel() {} };
  });
const list = (row?: string, whileInFlight?: () => Promise<unknown>) =>
  respond(`PID\tStatus\tLabel\n-\t0\tcom.apple.other\n${row ? `${row}\n` : ""}`, 0, whileInFlight);

beforeEach(async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-launchd-"));
  await fs.mkdir(path.join(dir, "processes"));
  vi.stubEnv("OPENCLAW_STATE_DIR", dir);
  spawn.mockReset();
});
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

it("refuses non-Aqua hosts and bootstraps a private job without command env in the plist", async () => {
  respond("Background\n");
  await expect(supervisor.requireHost()).rejects.toThrow("GUI (Aqua)");
  respond();
  const assertCurrent = vi.fn();
  const env = { GH_TOKEN: "synthetic-secret" };
  await supervisor.launch({
    id: "quiet-raven:0123456789ab",
    argv: ["true"],
    env,
    cwd: "/",
    logPath: file(".log"),
    assertCurrent,
  });
  expect(spawn.mock.calls[1]![0]).toMatchObject({
    argv: ["launchctl", "bootstrap", `gui/${process.getuid!()}`, file(".plist")],
  });
  expect(assertCurrent).toHaveBeenCalledOnce();
  const plist = await fs.readFile(file(".plist"), "utf8");
  expect(plist).toContain("<string>Interactive</string>");
  expect(plist).not.toContain("synthetic-secret");
  expect((await fs.stat(file(".plist"))).mode & 0o777).toBe(0o644);
  expect((await fs.stat(file(".spec.json"))).mode & 0o777).toBe(0o600);
});

it("maps launchctl list and wrapper facts; failures stay unknown", async () => {
  respond("", 1);
  await expect(supervisor.read(label)).rejects.toThrow("not confirmed");
  respond("unexpected output\n");
  await expect(supervisor.read(label)).rejects.toThrow("not confirmed");
  list(`4242\t0\t${label}`);
  await expect(supervisor.read(label)).resolves.toEqual({ state: "running", pid: 4242 });
  list(`-\t0\t${label}`); // loaded, no PID, no status file: still starting
  await expect(supervisor.read(label)).resolves.toEqual({ state: "running" });
  list();
  await expect(supervisor.read(label)).resolves.toEqual({ state: "missing" });
  // A wrapper first seen running in this read may just have finished; never call it lost.
  list(`-\t0\t${label}`, () => status({ phase: "running", pgid: 999_999, startedAt: Date.now() }));
  await expect(supervisor.read(label)).resolves.toEqual({ state: "running" });
  await status({
    phase: "exited",
    exitCode: 3,
    exitSignal: null,
    reason: "exit",
    durationMs: 1234,
  });
  await expect(supervisor.read(label)).resolves.toMatchObject({ exitCode: 3, durationMs: 1234 });
  respond();
  await supervisor.cleanup(label);
  await expect(fs.stat(file(".status.json"))).rejects.toThrow();
});

it("checks the recorded process group after the wrapper is killed", async () => {
  const group = spawnChild("sleep", ["30"], { detached: true, stdio: "ignore" });
  const read = async (startedAt: number) => {
    await status({ phase: "running", pgid: group.pid, startedAt });
    list(`-\t-9\t${label}`);
    return supervisor.read(label);
  };
  expect(await read(Date.now())).toEqual({ state: "running" });
  // A group id recorded before the last boot belongs to some other program now.
  expect(await read(Date.now() - os.uptime() * 1000 - 60_000)).toMatchObject({
    result: "supervisor-lost",
  });
  process.kill(-group.pid!, "SIGKILL");
  await once(group, "exit");
  expect(await read(Date.now())).toMatchObject({ state: "exited", result: "supervisor-lost" });
});

async function runWrapper(command: string, timeoutMs = 0) {
  const statusPath = path.join(dir, "status.json");
  const wrapper = path.join(dir, "wrapper.cjs");
  const spec = path.join(dir, "spec.json");
  const logPath = path.join(dir, "out.log");
  await fs.writeFile(wrapper, DURABLE_LAUNCHD_WRAPPER_SOURCE);
  const env = { PATH: "/usr/bin:/bin", SECRET: "s" };
  await fs.writeFile(
    spec,
    JSON.stringify({
      argv: ["/bin/sh", "-c", command],
      cwd: dir,
      env,
      logPath,
      statusPath,
      timeoutMs,
      killGraceMs: 500,
    }),
  );
  await once(spawnChild(process.execPath, [wrapper, spec], { stdio: "ignore" }), "exit");
  await expect(fs.stat(spec)).rejects.toThrow();
  const recorded = JSON.parse(await fs.readFile(statusPath, "utf8"));
  return { status: recorded, log: await fs.readFile(logPath, "utf8") };
}

it("wrapper records the exit after the whole group ends and enforces the timeout", async () => {
  const run = await runWrapper('echo "$SECRET-out"; (sleep 0.2; echo child-done) & exit 7');
  expect(run.status).toMatchObject({
    phase: "exited",
    exitCode: 7,
    exitSignal: null,
    reason: "exit",
  });
  expect(run.log).toBe("s-out\nchild-done\n");
  expect(run.status.durationMs).toBeGreaterThanOrEqual(150);
  const timeout = await runWrapper("trap '' TERM; sleep 30 & wait", 300);
  const signal = expect.stringMatching(/^SIG(TERM|KILL)$/);
  expect(timeout.status).toMatchObject({ reason: "overall-timeout", exitSignal: signal });
  expect(timeout.status.durationMs).toBeLessThan(5000);
});
