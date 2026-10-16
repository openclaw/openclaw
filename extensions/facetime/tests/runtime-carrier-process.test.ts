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
      processStartedAtMs: Date.parse(startedAt) + 900,
      bundleIdentifier: "com.apple.FaceTime",
      connectionGeneration: 1,
    },
  ],
  [
    1002,
    {
      processId: 1002,
      processStartedAtMs: Date.parse(startedAt) + 900,
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
    intercept: (inspect: (argv: string[], response: CommandResult) => CommandResult) => {
      const command = runCommand.getMockImplementation()!;
      runCommand.mockImplementation(async (argv, options) =>
        inspect(argv, await command(argv, options)),
      );
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
    fixture.intercept((argv, response) => {
      if (argv[0] === "/bin/ps" && argv[4] === "lstart=") {
        fixture.alive.delete(Number(argv[2]));
        return result(1);
      }
      return response;
    });
    await expect(fixture.shutdown()).resolves.toBeUndefined();
    expect(fixture.signals).toEqual([]);
  });

  it("does not mistake KILL permission failure for process absence", async () => {
    const fixture = processFixture();
    fixture.terminates.clear();
    const permissionFailures: string[] = [];
    fixture.intercept((argv, response) => {
      if (argv[0] === "/bin/kill" && argv[1] === "-KILL") {
        permissionFailures.push(argv[1]);
        return result(1, "", "kill: Operation not permitted");
      }
      return response;
    });
    await expect(fixture.shutdown()).rejects.toThrow("remains alive after force termination");
    expect(permissionFailures).toContain("-KILL");
    expect([...fixture.alive]).toEqual([1001, 1002]);
  });

  it.each([
    {
      name: "executable inspection error",
      field: "comm=",
      response: result(1, "", "ps: permission denied"),
      afterTerm: false,
    },
    {
      name: "different executable",
      field: "comm=",
      response: result(0, "UnrelatedApp"),
      afterTerm: false,
    },
    {
      name: "adjacent-second PID reuse",
      field: "lstart=",
      response: result(0, "Tue Nov 14 22:13:21 2023"),
      afterTerm: false,
    },
    {
      name: "start inspection failure after TERM",
      field: "lstart=",
      response: result(1, "", "ps: permission denied"),
      afterTerm: true,
    },
    {
      name: "PID reuse after TERM",
      field: "lstart=",
      response: result(0, "Tue Nov 14 22:13:30 2023"),
      afterTerm: true,
    },
  ])("stops signalling after $name", async ({ field, response, afterTerm }) => {
    const fixture = processFixture();
    fixture.terminates.clear();
    fixture.intercept((argv, original) =>
      argv[0] === "/bin/ps" && argv[4] === field && (!afterTerm || fixture.signals.length > 0)
        ? response
        : original,
    );
    await expect(fixture.shutdown()).rejects.toThrow("process identity no longer matches");
    expect(fixture.signals).toEqual(afterTerm ? [{ signal: "-TERM", pid: 1001 }] : []);
  });

  it.each(["comm=", "lstart=", "-TERM"])(
    "stops when ownership changes during %s",
    async (field) => {
      const fixture = processFixture();
      fixture.terminates.clear();
      let current = true;
      fixture.intercept((argv, response) => {
        if (
          (argv[0] === "/bin/ps" && argv[4] === field) ||
          (argv[0] === "/bin/kill" && argv[1] === field)
        ) {
          current = false;
        }
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
