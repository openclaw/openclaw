import { createRequire } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createCrabboxNodeEnrollmentSetup } from "./crabbox-worker-node-enrollment.js";
import { createNodeBootstrapFixture } from "./crabbox-worker-node-enrollment.test-support.js";

const require = createRequire(import.meta.url);
const home = "/Users/worker";
const leaseId = "cbx_replay_fixture";
const stateDir = path.join(home, ".openclaw", "cloud-workers", leaseId);
const runtimeDir = path.join(home, ".openclaw-worker", "node-runtimes", "a".repeat(64));
const cli = path.join(runtimeDir, "node_modules", "openclaw", "openclaw.mjs");

async function replay(platform: "linux" | "darwin", failure?: string) {
  const setup = createCrabboxNodeEnrollmentSetup({
    leaseId,
    enrollment: {
      mode: "connect",
      setupCode: "synthetic-code",
      setupId: "synthetic-setup",
      openclawVersion: "2026.8.1",
      nodeBootstrap: createNodeBootstrapFixture(),
      displayName: "Replay fixture",
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
  const spawn = vi.fn(() => {
    throw new Error("Replay must not spawn another node");
  });
  const processFixture = {
    platform,
    execPath: "/usr/bin/node",
    env: { ...setup.forwardedEnv },
    umask: vi.fn(),
    kill: vi.fn(),
    exitCode: 0,
  };
  const fs = {
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
    existsSync: (file: string) => file === path.join(stateDir, "node.pid"),
    readFileSync: (file: string) => {
      if (file === path.join(stateDir, "node.pid")) {
        return "123\n";
      }
      if (file === path.join(stateDir, "node-launch.json")) {
        if (failure === "missing-record") {
          throw new Error("ENOENT");
        }
        if (failure === "invalid-record") {
          return "invalid";
        }
        return JSON.stringify({
          pid: failure === "pid" ? 124 : 123,
          startTime:
            failure === "pid-reuse" ? "Tue Sep 8 12:00:00 2026" : "Wed Sep 9 12:00:00 2026",
          runtimeDir: runtimeDir + (failure === "runtime-record" ? "-other" : ""),
          stateDir: stateDir + (failure === "state" ? "-other" : ""),
          cli: cli + (failure === "cli-record" ? "-other" : ""),
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
  };
  const spawnSync = vi.fn((binary: string, args: string[]) => {
    if (failure === "unavailable") {
      return { status: 1, stdout: "" };
    }
    if (binary.endsWith("lsof")) {
      if (failure === "lsof" || (failure === "lsof-fallback" && binary === "lsof")) {
        return { status: 1, stdout: "" };
      }
      return {
        status: 0,
        stdout: `p123\nfcwd\nn${runtimeDir}${failure === "cwd" ? "-other" : ""}\n`,
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
  expect(spawn).not.toHaveBeenCalled();
  return { code: processFixture.exitCode, output: output.join("\n") };
}

describe.each(["linux", "darwin"] as const)("%s node enrollment replay", (platform) => {
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
