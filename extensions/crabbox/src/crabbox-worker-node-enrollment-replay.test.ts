import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createCrabboxNodeEnrollmentSetup } from "./crabbox-worker-node-enrollment.js";
import { createNodeBootstrapFixture } from "./crabbox-worker-node-enrollment.test-support.js";

const require = createRequire(import.meta.url);
const leaseId = "cbx_replay_fixture";

async function replay(
  platform: "linux" | "darwin",
  failure?: string,
  desktop = false,
  displayName = "Replay fixture",
  home = "/Users/worker",
  launch?: "ready" | "waiter-exit",
  interrupted?: "before-receipt" | "after-receipt" | "dangling-runtime" | "receipt-only",
) {
  const stateDir = path.join(home, ".openclaw", "cloud-workers", leaseId);
  const runtimeDir = path.join(home, ".openclaw-worker", "node-runtimes", "a".repeat(64));
  const cli = path.join(runtimeDir, "node_modules", "openclaw", "openclaw.mjs");
  const nodeStart = desktop ? "1788998400:123456" : "Wed Sep 9 12:00:00 2026";
  const hostStart = "1788998399:654321";
  const setup = createCrabboxNodeEnrollmentSetup({
    leaseId,
    ...(desktop ? { desktop: true, target: "macos" as const } : {}),
    enrollment: {
      mode: "connect",
      setupCode: "synthetic-code",
      setupId: "synthetic-setup",
      openclawVersion: "2026.8.1",
      nodeBootstrap: createNodeBootstrapFixture(),
      displayName,
      waitForDeviceId: async () => "synthetic-device",
    },
  });
  const command =
    failure === "argv"
      ? "unrelated-process"
      : failure === "original-argv"
        ? `/usr/bin/node ${cli} connect --ephemeral`
        : "openclaw-connect";
  const environment = `PATH=/usr/bin OPENCLAW_STATE_DIR=${stateDir}${failure === "state" ? "-other" : ""}`;
  const output: string[] = [];
  let launched = false;
  const waiter = Object.assign(new EventEmitter(), {
    pid: 777,
    exitCode: launch === "waiter-exit" ? 0 : null,
    signalCode: null,
    unref: vi.fn(),
  });
  const spawn = vi.fn(() => {
    if (!launch) {
      throw new Error("Replay must not spawn another node");
    }
    queueMicrotask(() => {
      launched = true;
      waiter.emit("spawn");
    });
    return waiter;
  });
  const processFixture = {
    platform,
    execPath: "/usr/bin/node",
    getuid: () => 501,
    env: { ...setup.forwardedEnv, LC_ALL: "fr_FR.UTF-8" },
    umask: vi.fn(),
    kill: vi.fn(),
    exitCode: 0,
  };
  const fs = {
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
    symlinkSync: vi.fn(),
    unlinkSync: vi.fn(),
    writeFileSync: vi.fn<(...args: unknown[]) => void>(),
    openSync: vi.fn(() => 11),
    closeSync: vi.fn(),
    lstatSync: (file: string) => {
      if (file === runtimeDir) {
        return { isDirectory: () => true };
      }
      if (
        (file === path.join(stateDir, "runtime") &&
          interrupted &&
          interrupted !== "receipt-only") ||
        (file === path.join(stateDir, "node-launch.json") &&
          (interrupted === "after-receipt" || interrupted === "receipt-only"))
      ) {
        return { isSymbolicLink: () => file.endsWith("/runtime") };
      }
      throw Object.assign(new Error("Missing runtime pointer"), { code: "ENOENT" });
    },
    existsSync: (file: string) =>
      file === runtimeDir ||
      (file === path.join(stateDir, "runtime") &&
        Boolean(
          interrupted && interrupted !== "receipt-only" && interrupted !== "dangling-runtime",
        )) ||
      (file === path.join(stateDir, "node-launch.json") &&
        (interrupted === "after-receipt" || interrupted === "receipt-only")) ||
      (file === path.join(stateDir, "node.pid") &&
        !interrupted &&
        (!launch || (launched && launch === "ready"))),
    readFileSync: (file: string) => {
      if (file === path.join(runtimeDir, "node_modules", "openclaw", "package.json")) {
        return JSON.stringify({ name: "openclaw", version: "2026.8.1" });
      }
      if (file === path.join(stateDir, "node.pid")) {
        return "123\n";
      }
      if (file === path.join(stateDir, "node-launch.json")) {
        if (failure === "missing-record" || launch === "waiter-exit") {
          throw new Error("ENOENT");
        }
        if (failure === "invalid-record") {
          return "invalid";
        }
        return JSON.stringify({
          pid: failure === "pid" ? 124 : 123,
          startTime: failure === "pid-reuse" ? "other-generation" : nodeStart,
          runtimeDir: runtimeDir + (failure === "runtime-record" ? "-other" : ""),
          stateDir: stateDir + (failure === "state" ? "-other" : ""),
          cli: cli + (failure === "cli-record" ? "-other" : ""),
          ...(desktop
            ? {
                hostPid: 456,
                hostStartTime: failure === "host-pid-reuse" ? "other-generation" : hostStart,
              }
            : {}),
        });
      }
      if (platform !== "linux") {
        throw new Error("macOS has no /proc filesystem");
      }
      if (failure === "unavailable") {
        throw new Error("Unreadable process identity");
      }
      if (file === "/proc/123/cmdline") {
        return failure === "original-argv" ? `/usr/bin/node\0${cli}\0connect\0` : command + "\0";
      }
      if (file === "/proc/123/environ") {
        return environment.replaceAll(" ", "\0");
      }
      throw new Error("Unexpected file read");
    },
    realpathSync: (file: string) =>
      file === "/proc/123/cwd" ? runtimeDir + (failure === "cwd" ? "-other" : "") : file,
    statSync: (file: string) => {
      if (file !== runtimeDir) {
        throw new Error("Unexpected directory identity read");
      }
      return { dev: -2147483647n, ino: 42n };
    },
  };
  const hostArguments = [
    "/Applications/OpenClawCloudWorker.app/Contents/MacOS/OpenClaw",
    "--cloud-worker-host",
    "--node-executable",
    "/usr/bin/node",
    "--runtime-dir",
    runtimeDir,
    "--state-dir",
    stateDir,
    "--desktop-dir",
    `/var/db/crabbox/openclaw-workers/${leaseId}`,
    "--lease-id",
    leaseId,
    "--display-name",
    displayName,
    "--enrollment-mode",
    "connect",
  ];
  const spawnSync = vi.fn((binary: string, args: string[]) => {
    if (binary === "/usr/bin/node") {
      if (args[0] !== cli) {
        throw new Error("Unexpected runtime executable");
      }
      return { status: 0, stdout: args[1] === "--version" ? "OpenClaw 2026.8.1" : "" };
    }
    if (failure === "unavailable") {
      return { status: 1, stdout: "" };
    }
    if (binary === hostArguments[0]) {
      if (
        args[0] !== "--cloud-worker-inspect-process" ||
        args[1] !== "456" ||
        (args[2] !== "123" && !(launch && args.length === 2))
      ) {
        throw new Error("Unexpected native process inspection");
      }
      if (
        [
          "host-inspect-unavailable",
          "host-replaced-during-inspect",
          "node-replaced-during-inspect",
        ].includes(failure ?? "")
      ) {
        return { status: 1, stdout: "" };
      }
      const cwd = { device: "2147483649", inode: "42" };
      const inspection =
        failure === "dead-host"
          ? { state: "gone" }
          : {
              state: "active",
              host: {
                pid: 456,
                uid: failure === "host-uid" ? 0 : 501,
                parentPid: 111,
                startTime: hostStart,
                executablePath: hostArguments[0],
                arguments: failure === "host-command" ? ["unrelated-host"] : hostArguments,
                cwd: failure === "host-cwd" ? { ...cwd, inode: "43" } : cwd,
              },
              node: {
                pid: 123,
                uid: failure === "node-uid" ? 0 : 501,
                parentPid: failure === "other-parent" ? 789 : 456,
                startTime: nodeStart,
                executablePath: "/usr/bin/node",
                arguments:
                  failure === "original-argv"
                    ? ["/usr/bin/node", cli, "connect", "--ephemeral"]
                    : [command],
                cwd: failure === "cwd" ? { ...cwd, inode: "43" } : cwd,
              },
            };
      return {
        status: 0,
        stdout: failure === "host-argv-invalid-json" ? "invalid" : JSON.stringify(inspection),
      };
    }
    if (binary.endsWith("lsof")) {
      if (failure === "lsof" || (failure === "lsof-fallback" && binary === "lsof")) {
        return { status: 1, stdout: "" };
      }
      return {
        status: 0,
        stdout: `p123\nfcwd\nn${runtimeDir.replace(/[^\x20-\x7e]/gu, "?")}${failure === "cwd" ? "-other" : ""}\n`,
      };
    }
    if (binary === "ps") {
      if (args.includes("lstart=")) {
        return {
          status: 0,
          stdout: failure === "missing-start" ? "" : "Wed Sep  9 12:00:00 2026\n",
        };
      }
      if (args.includes("-E") || args.includes("eww")) {
        throw new Error("Must not inspect macOS process environment");
      }
      return { status: 0, stdout: command + "\n" };
    }
    throw new Error("Unexpected process probe");
  });
  const script = setup.command
    .split("CRABBOX_NODE_ENROLLMENT_SCRIPT'\n")[1]!
    .split("\nCRABBOX_NODE_ENROLLMENT_SCRIPT")[0]!;
  await runInNewContext(script, {
    require: (name: string) =>
      name === "node:fs"
        ? fs
        : name === "node:os"
          ? { homedir: () => home }
          : name === "node:child_process"
            ? { spawn, spawnSync }
            : require(name),
    process: processFixture,
    console: { error: (line: string) => output.push(line) },
  });
  if (launch) {
    const logPath = path.join(stateDir, "node.log");
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      "/bin/bash",
      [
        "-c",
        expect.any(String),
        "openclaw-gui",
        "/usr/bin/open",
        "-n",
        "-g",
        "-W",
        "-a",
        "/Applications/OpenClawCloudWorker.app",
        "--stdin",
        "/dev/null",
        "--stdout",
        logPath,
        "--stderr",
        logPath,
        "--args",
        ...hostArguments.slice(1),
      ],
      expect.objectContaining({ cwd: runtimeDir, detached: true, stdio: ["ignore", 11, 11] }),
    );
    expect(fs.openSync).toHaveBeenCalledWith(logPath, "a", 0o600);
    expect(fs.closeSync).toHaveBeenCalledWith(11);
    const writtenFiles = fs.writeFileSync.mock.calls.map((call) => call[0]);
    expect(writtenFiles).not.toContain(path.join(stateDir, "node.pid"));
    expect(writtenFiles).not.toContain(path.join(stateDir, "node-launch.json"));
    expect(processFixture.kill).not.toHaveBeenCalled();
  } else {
    expect(spawn).not.toHaveBeenCalled();
  }
  if (interrupted) {
    expect(fs.unlinkSync).not.toHaveBeenCalled();
    expect(fs.symlinkSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(processFixture.kill).not.toHaveBeenCalled();
  }
  return { code: processFixture.exitCode, output: output.join("\n") };
}

describe.each(["linux", "darwin"] as const)("%s node enrollment replay", (platform) => {
  it("refuses an interrupted launch with a published runtime but no PID", async () => {
    expect(
      await replay(platform, undefined, false, undefined, undefined, undefined, "before-receipt"),
    ).toMatchObject({ code: 1, output: expect.stringContaining("launch is incomplete") });
  });
  it.each([undefined, "original-argv"])("reuses verified live invocation (%s)", async (variant) => {
    expect(await replay(platform, variant)).toEqual({
      code: 0,
      output:
        "CRABBOX_PHASE:openclaw-bootstrap-preparation\nCRABBOX_PHASE:openclaw-bootstrap-complete",
    });
  });
  it.each(["argv", "cwd", "state", "unavailable"])(
    "refuses %s mismatch or missing identity",
    async (failure) => {
      expect(await replay(platform, failure)).toMatchObject({
        code: 1,
        output: expect.stringContaining(
          platform === "linux" && failure === "unavailable"
            ? "Unreadable process identity"
            : "release and reprovision the worker",
        ),
      });
    },
  );
});

it.each([
  "missing-record",
  "invalid-record",
  "pid",
  "pid-reuse",
  "runtime-record",
  "cli-record",
  "missing-start",
  "lsof",
])("fails closed when macOS cannot report %s", async (failure) => {
  expect(await replay("darwin", failure)).toMatchObject({
    code: 1,
    output: expect.stringContaining("release and reprovision the worker"),
  });
});
it.each(["lsof-fallback"])("uses the available macOS %s probe", async (variant) => {
  expect(await replay("darwin", variant)).toMatchObject({ code: 0 });
});

describe("macOS desktop host enrollment replay", () => {
  it.each(["before-receipt", "after-receipt", "dangling-runtime", "receipt-only"] as const)(
    "preserves an interrupted host launch instead of launching another: %s",
    async (interrupted) => {
      expect(
        await replay("darwin", undefined, true, undefined, undefined, undefined, interrupted),
      ).toMatchObject({ code: 1, output: expect.stringContaining("launch is incomplete") });
    },
  );
  it.each([
    { launch: "ready" as const, failure: undefined, code: 0, message: "bootstrap-complete" },
    {
      launch: "waiter-exit" as const,
      failure: undefined,
      code: 1,
      message: "lease teardown is required",
    },
    {
      launch: "ready" as const,
      failure: "host-pid-reuse",
      code: 1,
      message: "mismatched process receipt",
    },
  ])(
    "launches through LaunchServices and requires the host receipt: $launch / $failure",
    async ({ launch, failure, code, message }) => {
      expect(
        await replay(
          "darwin",
          failure,
          true,
          "Cloud worker Développement 👨‍👩‍👧‍👦",
          "/Users/worker",
          launch,
        ),
      ).toMatchObject({ code, output: expect.stringContaining(message) });
    },
  );

  it("reuses the verified host and Node child despite a different SSH locale", async () => {
    expect(await replay("darwin", undefined, true)).toMatchObject({ code: 0 });
  });

  it.each(["Cloud worker Développement", "Cloud worker family 👨‍👩‍👧‍👦", "Cloud worker tab\tline\n"])(
    "preserves the exact native argv for %j",
    async (displayName) => {
      expect(await replay("darwin", undefined, true, displayName)).toMatchObject({ code: 0 });
    },
  );

  it.each(["/Users/Développement", "/Users/family 👨‍👩‍👧‍👦", "/Users/tab\tline\n"])(
    "binds the runtime directory and original Node argv under %j",
    async (home) => {
      expect(await replay("darwin", "original-argv", true, "Replay fixture", home)).toMatchObject({
        code: 0,
      });
    },
  );

  it.each([
    "dead-host",
    "host-pid-reuse",
    "host-command",
    "host-cwd",
    "other-parent",
    "host-uid",
    "node-uid",
    "cwd",
    "host-inspect-unavailable",
    "host-argv-invalid-json",
    "host-replaced-during-inspect",
    "node-replaced-during-inspect",
  ])("rejects %s even when the Node process still looks healthy", async (failure) => {
    expect(await replay("darwin", failure, true)).toMatchObject({
      code: 1,
      output: expect.stringContaining("release and reprovision the worker"),
    });
  });
});
