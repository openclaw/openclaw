import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ManagedRun, RunExit, SpawnInput } from "../process/supervisor/types.js";
import {
  cleanupDurableProcess,
  durableProcessUnitName,
  launchDurableProcess,
  readDurableProcess,
  requireDurableProcessHost,
  stopDurableProcess,
} from "./bash-process-systemd.js";

const { spawn } = vi.hoisted(() => ({
  spawn: vi.fn<(input: SpawnInput) => Promise<ManagedRun>>(),
}));
// mock-isolation: The systemd CLI is an unavailable external boundary on macOS.
vi.mock("../process/supervisor/index.js", () => ({ getProcessSupervisor: () => ({ spawn }) }));
vi.mock("../infra/executable-path.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/executable-path.js")>()),
  resolveExecutablePath: (name: string, options: { env: NodeJS.ProcessEnv }) => {
    expect(options.env).toBe(process.env);
    return `/gateway/bin/${name}`;
  },
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const unitName = durableProcessUnitName("quiet-raven:0123456789ab");
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

beforeEach(() => {
  Object.defineProperty(process, "platform", { ...originalPlatform, value: "linux" });
  vi.stubEnv("XDG_RUNTIME_DIR", "/run/user/1000");
  vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", undefined);
  spawn.mockReset();
});
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.unstubAllEnvs();
});

it("launches an independent user service with private environment, cgroup limits and retained result", async () => {
  respond("PATH=/usr/bin\nMANAGER_ONLY_TOKEN=synthetic-manager-secret\n");
  respond();
  const assertCurrent = vi.fn();
  await expect(
    launchDurableProcess({
      id: "quiet-raven:0123456789ab",
      argv: ["/bin/sh", "-c", 'printf "%s" "$GH_TOKEN"'],
      env: { PATH: "/workspace/command-bin", GH_TOKEN: "synthetic-launch-secret" },
      cwd: "/workspace",
      logPath: "/state/process.log",
      timeoutMs: 120_000,
      memoryLimitBytes: 1048576,
      assertCurrent,
    }),
  ).resolves.toEqual({ unitName });
  const launch = spawn.mock.calls[1]![0];
  expect(launch).toMatchObject({
    mode: "child",
    env: { GH_TOKEN: "synthetic-launch-secret" },
    exactEnv: true,
    cleanupOwnership: "external",
    stdinMode: "pipe-closed",
  });
  expect(launch.mode === "child" && launch.argv).toEqual(
    expect.arrayContaining([
      "/gateway/bin/systemd-run",
      "--user",
      `--unit=${unitName}`,
      "--working-directory=/workspace",
      "--property=ExitType=cgroup",
      "--property=RemainAfterExit=yes",
      "--property=KillMode=control-group",
      "--property=StandardInput=null",
      "--property=StandardOutput=append:/state/process.log",
      "--property=UnsetEnvironment=MANAGER_ONLY_TOKEN",
      "--property=RuntimeMaxSec=120s",
      "--property=MemoryMax=1048576",
      "--setenv=GH_TOKEN",
      'printf "%s" "$$GH_TOKEN"',
    ]),
  );
  expect(assertCurrent).toHaveBeenCalledOnce();
  expect(JSON.stringify(launch.mode === "child" && launch.argv)).not.toContain("secret");
});

it.each([
  ["ActiveState=active\nSubState=running\nMainPID=42", { state: "running", pid: 42 }],
  [
    "ActiveState=active\nSubState=exited\nExecMainCode=1\nExecMainStatus=7\nResult=exit-code",
    { state: "exited", exitCode: 7, exitSignal: null, reason: "exit", result: "exit-code" },
  ],
  [
    "ActiveState=failed\nSubState=failed\nExecMainCode=2\nExecMainStatus=9\nResult=oom-kill",
    { state: "exited", exitCode: null, exitSignal: 9, reason: "memory-limit", result: "oom-kill" },
  ],
  [
    "ActiveState=failed\nSubState=failed\nExecMainCode=0\nExecMainStatus=0\nResult=resources",
    {
      state: "exited",
      exitCode: null,
      exitSignal: null,
      reason: "spawn-error",
      result: "resources",
    },
  ],
])("reads retained systemd status: %s", async (fields, expected) => {
  respond(`LoadState=loaded\n${fields}`);
  await expect(readDurableProcess(unitName)).resolves.toEqual(expected);
});

it("distinguishes a missing unit from an unavailable manager", async () => {
  respond("LoadState=not-found\n", 4);
  await expect(readDurableProcess(unitName)).resolves.toEqual({ state: "missing" });
  respond("", 1);
  await expect(readDurableProcess(unitName)).rejects.toThrow("control was not confirmed");
});

it("refuses unsupported hosts and unreachable user managers", async () => {
  Object.defineProperty(process, "platform", { ...originalPlatform, value: "darwin" });
  await expect(requireDurableProcessHost({ XDG_RUNTIME_DIR: "/run/user/1000" })).rejects.toThrow(
    "Linux",
  );
  Object.defineProperty(process, "platform", { ...originalPlatform, value: "linux" });
  vi.stubEnv("XDG_RUNTIME_DIR", undefined);
  await expect(requireDurableProcessHost({})).rejects.toThrow("XDG_RUNTIME_DIR");
  vi.stubEnv("XDG_RUNTIME_DIR", "/run/user/1000");
  respond("systemd 250\n");
  respond("", 1);
  await expect(requireDurableProcessHost({ XDG_RUNTIME_DIR: "/run/user/1000" })).rejects.toThrow(
    "reachable",
  );
});

it("checks current stop authority and never selects arbitrary units", async () => {
  await expect(stopDurableProcess("gateway.service")).rejects.toThrow("unit identity");
  respond();
  const assertCurrent = () => {
    throw new Error("source retired");
  };
  await expect(stopDurableProcess(unitName, { assertCurrent })).rejects.toThrow(
    "control was not confirmed",
  );
  respond();
  respond();
  await cleanupDurableProcess(unitName);
  expect(spawn.mock.calls[1]![0]).toMatchObject({
    argv: ["/gateway/bin/systemctl", "--user", "--no-ask-password", "stop", "--", unitName],
  });
  expect(spawn.mock.calls[2]![0]).toMatchObject({
    argv: ["/gateway/bin/systemctl", "--user", "--no-ask-password", "reset-failed", "--", unitName],
  });
});

it("does not expose helper command arguments in launch failures", async () => {
  respond();
  spawn.mockRejectedValueOnce(new Error("command argv containing synthetic-secret"));
  await expect(
    launchDurableProcess({
      id: "failure",
      argv: ["/bin/sh", "-c", "synthetic-secret"],
      env: {},
      cwd: "/",
      logPath: "/log",
    }),
  ).rejects.toThrow("control was not confirmed");
});

it("refuses environment overrides selecting a different user manager", async () => {
  await expect(
    requireDurableProcessHost({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/synthetic-other-manager" }),
  ).rejects.toThrow("Gateway user's systemd manager");
  expect(spawn).not.toHaveBeenCalled();
});

it.each([
  [249, 250],
  [250, 249],
  [250, 250],
])("requires client and reachable manager >=250: %i/%i", async (client, manager) => {
  vi.resetModules();
  const api = await import("./bash-process-systemd.js");
  respond(`systemd ${client}\n`);
  respond(`Version=${manager}\n`);
  const env = { XDG_RUNTIME_DIR: "/run/user/1000" };
  if (client < 250 || manager < 250) {
    await expect(api.requireDurableProcessHost(env)).rejects.toThrow("systemd 250 or newer");
    return;
  }
  await expect(api.requireDurableProcessHost(env)).resolves.toBeUndefined();
  respond("Version=250\n");
  await expect(api.requireDurableProcessHost(env)).resolves.toBeUndefined();
  expect(
    spawn.mock.calls.filter(
      ([input]) => input.mode === "child" && input.argv.includes("--version"),
    ),
  ).toHaveLength(1);
});
