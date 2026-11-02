import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runWithSpawnBroker } from "../process/spawn-broker/context.js";
import type { SpawnBrokerHost } from "../process/spawn-broker/host.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { maybeWrapCommandWithShellSnapshot } from "./shell-snapshot.js";

const { killProcessTreeMock, spawnMock, getAgentExecCgroupMock } = vi.hoisted(() => ({
  killProcessTreeMock: vi.fn(),
  spawnMock: vi.fn(),
  getAgentExecCgroupMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    { spawn: spawnMock },
  );
});

vi.mock("../process/kill-tree.js", () => ({
  killProcessTree: killProcessTreeMock,
}));

// Keep the real spawnProcess: the placement decision under test lives in it, so
// replacing it would assert the argument instead of the resulting broker cgroup.
vi.mock("../process/linux-exec-cgroup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../process/linux-exec-cgroup.js")>();
  return { ...actual, getAgentExecCgroup: getAgentExecCgroupMock };
});

const CAPTURE_MARKER = "__OPENCLAW_SHELL_SNAPSHOT_CAPTURE__";
const ENV_MARKER = "__OPENCLAW_SHELL_SNAPSHOT_ENV__";

function fakeChild(pid: number): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    pid,
    kill: vi.fn(),
  }) as unknown as ChildProcess;
  return child;
}

/** Simulate the capture shell writing its stdout capture file, then exiting. */
function captureShellWritesOutput(command: string): boolean {
  const target = command.match(/>\s*'([^']*snapshot\.out)'/u)?.[1];
  if (!target) {
    return false;
  }
  fs.writeFileSync(target, ["", CAPTURE_MARKER, "", ENV_MARKER, "{}", ""].join("\n"), "utf8");
  return true;
}

describe.skipIf(process.platform === "win32")("shell snapshot subprocesses", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["HOME", "OPENCLAW_EXEC_SHELL_SNAPSHOT", "OPENCLAW_STATE_DIR"]);
    spawnMock.mockReset();
    killProcessTreeMock.mockReset();
    getAgentExecCgroupMock.mockReset();
    getAgentExecCgroupMock.mockReturnValue(undefined);
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("does not create output pipes for status-only shell commands", async () => {
    const child = fakeChild(4242);
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit("close", 1));
      return child;
    });

    const home = tempDirs.make("openclaw-snapshot-spawn-home-");
    const stateDir = tempDirs.make("openclaw-snapshot-spawn-state-");
    setTestEnvValue("HOME", home);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

    const command = "echo unchanged";
    await expect(
      maybeWrapCommandWithShellSnapshot({
        command,
        shell: "/bin/bash",
        shellArgs: ["-c"],
        cwd: os.tmpdir(),
        env: { ...process.env },
      }),
    ).resolves.toBe(command);

    const options = spawnMock.mock.calls[0]?.[2] as SpawnOptions | undefined;
    expect(options?.stdio).toBe("ignore");
    expect(killProcessTreeMock).toHaveBeenCalledWith(4242, { graceMs: 0, detached: true });
  });

  it("places capture and validation shells in the agent exec cgroup via the broker", async () => {
    const agentExecCgroup = "/sys/fs/cgroup/openclaw-test.service/agent-exec";
    getAgentExecCgroupMock.mockReturnValue(agentExecCgroup);

    let nextPid = 5000;
    // Type the implementation with the broker's whole tuple so mock.calls keeps
    // all five arguments and the placement index stays checkable.
    const brokerSpawn = vi.fn((...args: Parameters<SpawnBrokerHost["spawn"]>) => {
      const child = fakeChild(nextPid++);
      const command = args[1].at(-1) ?? "";
      const wroteCapture = captureShellWritesOutput(command);
      queueMicrotask(() => child.emit("close", wroteCapture || command.startsWith(". ") ? 0 : 1));
      return child;
    });

    const home = tempDirs.make("openclaw-snapshot-broker-home-");
    const stateDir = tempDirs.make("openclaw-snapshot-broker-state-");
    setTestEnvValue("HOME", home);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

    const wrapped = await runWithSpawnBroker(
      { spawn: brokerSpawn } as unknown as SpawnBrokerHost,
      () =>
        maybeWrapCommandWithShellSnapshot({
          command: "echo captured",
          shell: "/bin/bash",
          shellArgs: ["-c"],
          cwd: os.tmpdir(),
          env: { ...process.env },
        }),
    );

    // Capture and validation both run through the broker; each must carry the
    // agent exec cgroup, which is what actually selects kernel placement.
    expect(brokerSpawn).toHaveBeenCalledTimes(2);
    const placement = brokerSpawn.mock.calls.map((call) => call[4]);
    expect(placement).toEqual([agentExecCgroup, agentExecCgroup]);
    // A validated snapshot is published and used to wrap the command.
    expect(wrapped).toContain("shell-snapshots");
    expect(wrapped).toContain("echo captured");
  });

  it("places capture and validation shells in the agent exec cgroup without a broker", async () => {
    // The Gateway ships on runtimes that start no spawn broker, so the no-broker
    // transport is what decides placement there.
    const agentExecCgroup = "/sys/fs/cgroup/openclaw-test.service/agent-exec";
    getAgentExecCgroupMock.mockReturnValue(agentExecCgroup);

    let nextPid = 6000;
    spawnMock.mockImplementation((...args: [string, string[]]) => {
      const child = fakeChild(nextPid++);
      const command = args[1].at(-1) ?? "";
      const wroteCapture = captureShellWritesOutput(command);
      queueMicrotask(() => child.emit("close", wroteCapture || command.startsWith(". ") ? 0 : 1));
      return child;
    });

    const home = tempDirs.make("openclaw-snapshot-nobroker-home-");
    const stateDir = tempDirs.make("openclaw-snapshot-nobroker-state-");
    setTestEnvValue("HOME", home);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

    const wrapped = await maybeWrapCommandWithShellSnapshot({
      command: "echo captured",
      shell: "/bin/bash",
      shellArgs: ["-c"],
      cwd: os.tmpdir(),
      env: { ...process.env },
    });

    // Each shell moves itself into the agent exec cgroup and then execs the
    // requested command, so the spawned pid is the shell that ends up placed.
    expect(spawnMock).toHaveBeenCalledTimes(2);
    for (const call of spawnMock.mock.calls) {
      const command = call[0] as string;
      const args = call[1] as string[];
      expect(command).toBe("/bin/sh");
      expect(args[0]).toBe("-c");
      expect(args[1]).toContain(`> '${agentExecCgroup}/cgroup.procs'`);
      expect(args[1]).toContain('exec "$@"');
      expect(args[3]).toBe("/bin/bash");
      expect((args.at(-1) ?? "").length).toBeGreaterThan(0);
    }
    expect(wrapped).toContain("shell-snapshots");
    expect(wrapped).toContain("echo captured");
  });
});
