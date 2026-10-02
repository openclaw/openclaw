import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import type { FaceTimeHelperPeer } from "../src/helper-rpc.js";
import { terminateExactCarrierProcesses } from "../src/runtime-carrier-process.js";

const startedAt = "Tue Nov 14 22:13:20 2023";
const peers = new Map<number, FaceTimeHelperPeer>([
  [
    1001,
    {
      processId: 1001,
      processStartedAtMs: Date.parse(startedAt),
      bundleIdentifier: "com.apple.FaceTime",
      connectionGeneration: 1,
    },
  ],
  [
    1002,
    {
      processId: 1002,
      processStartedAtMs: Date.parse(startedAt),
      bundleIdentifier: "com.apple.mobilephone",
      connectionGeneration: 2,
    },
  ],
]);

type RunCommand = PluginRuntime["system"]["runCommandWithTimeout"];
type CommandResult = Awaited<ReturnType<RunCommand>>;

function result(code: number, stdout = "", stderr = ""): CommandResult {
  return { code, stdout, stderr, signal: null, killed: false, termination: "exit" };
}

function processFixture() {
  const alive = new Set(peers.keys());
  const terminates = new Set(peers.keys());
  const signals: Array<{ signal: string; pid: number }> = [];
  const runCommand = vi.fn<RunCommand>(async (argv) => {
    const pid = Number(argv[2]);
    if (argv[0] === "/bin/ps") {
      return alive.has(pid)
        ? result(0, argv[4] === "comm=" ? (pid === 1001 ? "FaceTime" : "Phone") : startedAt)
        : result(1);
    }
    if (argv[0] !== "/bin/kill") {
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    }
    const signal = argv[1];
    if (!signal) {
      throw new Error("Expected a carrier process signal");
    }
    signals.push({ signal, pid });
    if (terminates.has(pid)) {
      alive.delete(pid);
    }
    return result(0);
  });
  const runtime = { system: { runCommandWithTimeout: runCommand } };
  return {
    alive,
    terminates,
    signals,
    runCommand,
    runtime,
    shutdown: (assertCurrent = () => {}) =>
      terminateExactCarrierProcesses({ runtime, peers, assertCurrent }),
  };
}

describe("FaceTime exact carrier process termination", () => {
  it("retries the remaining carrier after another peer exited during partial shutdown", async () => {
    const fixture = processFixture();
    fixture.terminates.delete(1002);

    await expect(fixture.shutdown()).rejects.toThrow("remains alive after force termination");
    expect([...fixture.alive]).toEqual([1002]);
    fixture.signals.length = 0;
    fixture.terminates.add(1002);

    await expect(fixture.shutdown()).resolves.toBeUndefined();
    expect(fixture.signals).toEqual([{ signal: "-TERM", pid: 1002 }]);
    expect(fixture.alive.size).toBe(0);
  });

  it.each(["comm=", "lstart="])(
    "settles an already-exited carrier confirmed during %s inspection without signalling it",
    async (field) => {
      const fixture = processFixture();
      const runCommand = fixture.runCommand.getMockImplementation()!;
      fixture.runCommand.mockImplementation(async (argv, options) => {
        if (argv[0] === "/bin/ps" && argv[4] === field) {
          fixture.alive.delete(Number(argv[2]));
        }
        return await runCommand(argv, options);
      });

      await expect(fixture.shutdown()).resolves.toBeUndefined();
      expect(fixture.signals).toEqual([]);
    },
  );

  it("settles a carrier that exits during inspection after graceful termination", async () => {
    const fixture = processFixture();
    fixture.terminates.clear();
    const runCommand = fixture.runCommand.getMockImplementation()!;
    fixture.runCommand.mockImplementation(async (argv, options) => {
      if (argv[0] === "/bin/ps" && fixture.signals.some(({ pid }) => pid === Number(argv[2]))) {
        fixture.alive.delete(Number(argv[2]));
      }
      return await runCommand(argv, options);
    });

    await expect(fixture.shutdown()).resolves.toBeUndefined();
    expect(fixture.signals).toEqual([
      { signal: "-TERM", pid: 1001 },
      { signal: "-TERM", pid: 1002 },
    ]);
  });

  it("does not mistake a permission failure for process absence after force termination", async () => {
    const fixture = processFixture();
    fixture.terminates.clear();
    const permissionFailures: string[] = [];
    const runCommand = fixture.runCommand.getMockImplementation()!;
    fixture.runCommand.mockImplementation(async (argv, options) => {
      const commandResult = await runCommand(argv, options);
      if (argv[0] === "/bin/kill" && argv[1] === "-KILL") {
        permissionFailures.push(argv[1]);
        return result(1, "", "kill: Operation not permitted");
      }
      return commandResult;
    });

    await expect(fixture.shutdown()).rejects.toThrow("remains alive after force termination");
    expect(permissionFailures).toContain("-KILL");
    expect([...fixture.alive]).toEqual([1001, 1002]);
  });

  it.each([
    { name: "process inspection failure", response: result(1, "", "ps: permission denied") },
    { name: "reused PID", response: result(0, "Tue Nov 14 22:13:30 2023") },
  ])("does not force termination after a $name", async ({ response }) => {
    const fixture = processFixture();
    fixture.terminates.clear();
    const runCommand = fixture.runCommand.getMockImplementation()!;
    fixture.runCommand.mockImplementation(async (argv, options) =>
      argv[0] === "/bin/ps" && argv[4] === "lstart=" && fixture.signals.length > 0
        ? response
        : await runCommand(argv, options),
    );

    await expect(fixture.shutdown()).rejects.toThrow("process identity no longer matches");
    expect(fixture.signals).toEqual([{ signal: "-TERM", pid: 1001 }]);
  });

  it.each([
    { name: "inspection error", response: result(1, "", "ps: permission denied") },
    { name: "failed inspection", response: result(2) },
    { name: "different executable", response: result(0, "UnrelatedApp") },
  ])("does not signal a carrier after $name", async ({ response }) => {
    const fixture = processFixture();
    const runCommand = fixture.runCommand.getMockImplementation()!;
    fixture.runCommand.mockImplementation(async (argv, options) =>
      argv[0] === "/bin/ps" && argv[4] === "comm=" ? response : await runCommand(argv, options),
    );

    await expect(fixture.shutdown()).rejects.toThrow("process identity no longer matches");
    expect(fixture.signals).toEqual([]);
  });

  it.each([
    { name: "matching second", observed: startedAt, matches: true },
    { name: "adjacent-second PID reuse", observed: "Tue Nov 14 22:13:21 2023", matches: false },
  ])("compares fractional native process starts with $name", async ({ observed, matches }) => {
    const fixture = processFixture();
    const fractionalPeers = new Map<number, FaceTimeHelperPeer>();
    for (const [pid, peer] of peers) {
      fractionalPeers.set(pid, { ...peer, processStartedAtMs: peer.processStartedAtMs + 900 });
    }
    const runCommand = fixture.runCommand.getMockImplementation()!;
    fixture.runCommand.mockImplementation(async (argv, options) =>
      argv[0] === "/bin/ps" && argv[4] === "lstart="
        ? result(0, observed)
        : await runCommand(argv, options),
    );
    const shutdown = terminateExactCarrierProcesses({
      runtime: fixture.runtime,
      peers: fractionalPeers,
      assertCurrent: () => {},
    });

    if (matches) {
      await expect(shutdown).resolves.toBeUndefined();
      expect(fixture.signals.map(({ pid }) => pid)).toEqual([...peers.keys()]);
    } else {
      await expect(shutdown).rejects.toThrow("process identity no longer matches");
      expect(fixture.signals).toEqual([]);
    }
  });

  it.each(["comm=", "lstart="])(
    "does not signal a carrier if ownership changes during %s inspection",
    async (field) => {
      const fixture = processFixture();
      const runCommand = fixture.runCommand.getMockImplementation()!;
      let current = true;
      fixture.runCommand.mockImplementation(async (argv, options) => {
        const inspected = await runCommand(argv, options);
        if (argv[0] === "/bin/ps" && argv[4] === field) {
          current = false;
        }
        return inspected;
      });

      await expect(
        fixture.shutdown(() => {
          if (!current) {
            throw new Error("carrier owner changed");
          }
        }),
      ).rejects.toThrow("carrier owner changed");
      expect(fixture.signals).toEqual([]);
    },
  );

  it("does not continue shutdown if ownership changes while sending TERM", async () => {
    const fixture = processFixture();
    fixture.terminates.clear();
    const runCommand = fixture.runCommand.getMockImplementation()!;
    let current = true;
    fixture.runCommand.mockImplementation(async (argv, options) => {
      const commandResult = await runCommand(argv, options);
      if (argv[0] === "/bin/kill" && argv[1] === "-TERM") {
        current = false;
      }
      return commandResult;
    });

    await expect(
      fixture.shutdown(() => {
        if (!current) {
          throw new Error("carrier owner changed");
        }
      }),
    ).rejects.toThrow("carrier owner changed");
    expect(fixture.signals).toEqual([{ signal: "-TERM", pid: 1001 }]);
  });
});
