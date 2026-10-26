import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import type { FaceTimeHelperPeer } from "../src/helper-rpc.js";
import { terminateExactCarrierProcesses } from "../src/runtime-carrier-process.js";

const startedAt = "Tue Nov 14 22:13:20 2023";
const peer = (processId: number, bundleIdentifier: string): [number, FaceTimeHelperPeer] => [
  processId,
  {
    processId,
    bundleIdentifier,
    connectionGeneration: processId - 1000,
    processStartedAtMs: Date.parse(startedAt) + 900,
  },
];
const peers = new Map([
  peer(1001, "com.apple.FaceTime"),
  peer(1002, "com.apple.FaceTime.FTConversationService"),
]);
type RunCommand = PluginRuntime["system"]["runCommandWithTimeout"];
type CommandResult = Awaited<ReturnType<RunCommand>>;
function result(code: number, stdout = "", stderr = ""): CommandResult {
  return { code, stdout, stderr, signal: null, killed: false, termination: "exit" };
}

function processFixture(terminating = [...peers.keys()]) {
  const alive = new Set(peers.keys());
  const terminates = new Set(terminating);
  const signals: Array<{ signal: string; pid: number }> = [];
  const runCommand = vi.fn<RunCommand>(async (argv) => {
    const pid = Number(argv[2]);
    if (argv[0] === "/bin/ps") {
      return alive.has(pid)
        ? result(
            0,
            argv[4] === "comm=" ? (pid === 1001 ? "FaceTime" : "FTConversationService") : startedAt,
          )
        : result(1);
    }
    if (argv[0] !== "/bin/kill" || !argv[1]) {
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    }
    signals.push({ signal: argv[1], pid });
    if (terminates.has(pid)) {
      alive.delete(pid);
    }
    return result(0);
  });
  return {
    alive,
    terminates,
    signals,
    intercept: (
      field: string,
      inspect: (argv: string[], response: CommandResult) => CommandResult,
    ) => {
      const command = runCommand.getMockImplementation()!;
      runCommand.mockImplementation(async (argv, options) => {
        const response = await command(argv, options);
        return (argv[0] === "/bin/ps" ? argv[4] : argv[1]) === field
          ? inspect(argv, response)
          : response;
      });
    },
    shutdown: (assertCurrent = () => {}) =>
      terminateExactCarrierProcesses({
        runtime: { system: { runCommandWithTimeout: runCommand } },
        peers,
        assertCurrent,
      }),
  };
}

describe("FaceTime exact carrier process termination", () => {
  it("retries partial shutdown without resignalling exited peers and accepts fractional starts", async () => {
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

  it("does not signal a carrier that disappears during start-time inspection", async () => {
    const fixture = processFixture();
    fixture.intercept("lstart=", (argv) => {
      fixture.alive.delete(Number(argv[2]));
      return result(1);
    });
    await expect(fixture.shutdown()).resolves.toBeUndefined();
    expect(fixture.signals).toEqual([]);
  });

  it("does not mistake KILL permission failure for process absence", async () => {
    const fixture = processFixture([]);
    const permissionFailure = vi.fn(() => result(1, "", "kill: Operation not permitted"));
    fixture.intercept("-KILL", permissionFailure);
    await expect(fixture.shutdown()).rejects.toThrow("remains alive after force termination");
    expect(permissionFailure).toHaveBeenCalled();
    expect([...fixture.alive]).toEqual([1001, 1002]);
  });

  it.each([
    ["inspection error", "comm=", result(1, "", "ps: permission denied"), false],
    ["different executable", "comm=", result(0, "UnrelatedApp"), false],
    ["adjacent-second PID reuse", "lstart=", result(0, "Tue Nov 14 22:13:21 2023"), false],
    ["inspection failure after TERM", "lstart=", result(1, "", "ps: permission denied"), true],
    ["PID reuse after TERM", "lstart=", result(0, "Tue Nov 14 22:13:30 2023"), true],
  ] as const)("stops signalling after %s", async (_name, field, response, afterTerm) => {
    const fixture = processFixture([]);
    fixture.intercept(field, (_argv, original) =>
      !afterTerm || fixture.signals.length > 0 ? response : original,
    );
    await expect(fixture.shutdown()).rejects.toThrow("process identity no longer matches");
    expect(fixture.signals).toEqual(afterTerm ? [{ signal: "-TERM", pid: 1001 }] : []);
  });

  it.each(["comm=", "lstart=", "-TERM"])(
    "stops when ownership changes during %s",
    async (field) => {
      const fixture = processFixture([]);
      let current = true;
      fixture.intercept(field, (_argv, response) => {
        current = false;
        return response;
      });
      await expect(
        fixture.shutdown(() => {
          if (!current) {
            throw new Error("carrier owner changed");
          }
        }),
      ).rejects.toThrow("carrier owner changed");
      expect(fixture.signals).toEqual(field === "-TERM" ? [{ signal: "-TERM", pid: 1001 }] : []);
    },
  );
});
