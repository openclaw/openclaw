import { execFile } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PosixProcess,
  readCodexAppServerProcessCommand,
  readCodexAppServerProcessSnapshot,
} from "./transport-process-snapshot.js";

const procfs = vi.hoisted(() => ({
  readFile: vi.fn<(file: string) => string>(),
  readdir: vi.fn<() => string[]>(),
}));

const observedProcess: PosixProcess = {
  pid: process.pid,
  ppid: process.ppid,
  pgid: process.pid,
  state: "S",
  startedAt: "00000000-0000-0000-0000-000000000001:12345",
};

const bootId = "00000000-0000-0000-0000-000000000001";
function stat(pid = process.pid, threads = "1", state = "S") {
  return `${pid} (worker) ${state} ${process.ppid} ${pid}${" 0".repeat(14)} ${threads} 0 12345\n`;
}

function mockProcfs(read: (file: string) => string) {
  procfs.readFile.mockImplementation((file) =>
    file === "/proc/sys/kernel/random/boot_id" ? bootId : read(file),
  );
}

function runInspectorFixture(
  name: string,
  timeout: number,
  args: string[] = [],
  env = process.env,
) {
  const fixture = new URL(
    `./test-support/transport-process-${name}.test-support.mjs`,
    import.meta.url,
  );
  return new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", path.resolve("scripts/tsx.mjs"), fileURLToPath(fixture), ...args],
      { timeout, env },
      (error, output) => (error ? reject(error) : resolve(output)),
    );
  });
}

afterEach(() => {
  procfs.readFile.mockReset();
  procfs.readdir.mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.skipIf(process.platform === "win32")(
  "keeps timers responsive and reaps a blocked command inspector",
  async () => {
    const result = JSON.parse(await runInspectorFixture("blocked-command", 10_000));
    expect(result).toMatchObject({
      outcome: { status: "rejected", reason: "deadline" },
      inspectorUsed: true,
      inspectorClosed: true,
      ambientPreloadExecuted: false,
    });
    expect(result.firstHeartbeatMs).toBeLessThan(500);
    expect(result.inspectionMs).toBeLessThan(2000);
  },
  15_000,
);

it.skipIf(process.platform === "win32")(
  "inspects procfs identities, commands and trees despite filesystem worker starvation",
  async () => {
    const stdout = await runInspectorFixture(
      "starvation",
      15_000,
      process.platform === "linux" ? [] : ["--fixture-procfs"],
      { ...process.env, UV_THREADPOOL_SIZE: "1" },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      startupDeadlineMs: 10_000,
      filesystemWorkerReleaseDeadlineMs: 10_500,
      filesystemWorkerHeldAtInspection: true,
      outcomes: [
        { operation: "selected-identity", status: "fulfilled", observerPresent: true },
        { operation: "selected-command", status: "fulfilled", commandBytes: expect.any(Number) },
        { operation: "full-snapshot", status: "fulfilled", observerPresent: true },
      ],
    });
  },
  20_000,
);

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { createProcfsCommandFixture } = await import("./transport-procfs.test-support.js");
  return {
    ...original,
    execFile: vi.fn(
      createProcfsCommandFixture(
        original,
        (file) => (procfs.readFile.getMockImplementation() ? procfs.readFile(file) : undefined),
        () => (procfs.readdir.getMockImplementation() ? procfs.readdir() : undefined),
      ),
    ),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  const { createProcfsSyncFixture } = await import("./transport-procfs.test-support.js");
  return {
    ...original,
    ...createProcfsSyncFixture(original, (file) =>
      procfs.readFile.getMockImplementation() ? procfs.readFile(file) : undefined,
    ),
  };
});

it.for(["snapshot", "command"] as const)("normalizes inspector launch denial: %s", async (kind) => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.mocked(execFile).mockImplementationOnce(() => {
    throw Object.assign(new Error("spawn EPERM"), { code: "EPERM" });
  });
  const inspected =
    kind === "snapshot"
      ? readCodexAppServerProcessSnapshot()
      : readCodexAppServerProcessCommand(observedProcess, performance.now() + 1_000);
  await expect(inspected).rejects.toMatchObject({
    name: "ProcessInspectionError",
    reason: "permission",
    message: expect.stringContaining("Check process inspection permissions"),
  });
});

describe("Codex procfs inspector", () => {
  beforeEach(() => vi.spyOn(process, "platform", "get").mockReturnValue("linux"));
  it.for([
    "ready",
    "empty",
    "gone",
    "replaced",
    "zombie",
    "reparented",
    "regrouped",
    "read-error",
    "replaced after read",
  ])("binds command readiness to the same live identity: %s", async (mode) => {
    // Keep deadline advancement independent of wall-clock scheduling.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let monotonicNowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => monotonicNowMs);
    const deadline = performance.now() + 250;
    let commandReads = 0;
    mockProcfs((file) => {
      if (file === `/proc/${process.pid}/cmdline`) {
        commandReads += 1;
        if (commandReads > 1 && mode === "empty") {
          monotonicNowMs = deadline;
        }
        if (commandReads > 1 && mode === "read-error") {
          throw Object.assign(new Error("command read failed"), { code: "EIO" });
        }
        return commandReads === 1 || mode === "empty" ? "" : "/opt/codex\0app-server\0";
      }
      expect(file).toBe(`/proc/${process.pid}/stat`);
      if (commandReads && mode === "gone") {
        throw Object.assign(new Error("identity unavailable"), { code: "ENOENT" });
      }
      const changed = commandReads > 0;
      const state = changed && mode === "zombie" ? "Z" : "R";
      const ppid = process.ppid + Number(changed && mode === "reparented");
      const pgid = process.pid + Number(changed && mode === "regrouped");
      const replaced =
        (changed && mode === "replaced") || (commandReads > 1 && mode === "replaced after read");
      return `${process.pid} (codex) ${state} ${ppid} ${pgid}${" 0".repeat(14)} 1 0 ${replaced ? 54321 : 12345}\n`;
    });
    const observed = (await readCodexAppServerProcessSnapshot(undefined, [process.pid]))[0]!;
    const inspected = readCodexAppServerProcessCommand(observed, deadline);
    if (mode === "ready") {
      await expect(inspected).resolves.toBe("/opt/codex app-server");
    } else {
      await expect(inspected).rejects.toMatchObject({
        reason: mode === "empty" ? "deadline" : "unavailable",
      });
    }
    if (["ready", "empty", "read-error", "replaced after read"].includes(mode)) {
      expect(commandReads).toBe(2);
    }
  });

  it.for([
    { input: "\0", reason: "unavailable" },
    { code: "EACCES", reason: "permission" },
    { code: "ABORT_ERR", reason: "deadline" },
  ])("rejects absent or unreadable command identities: %j", async (fixture) => {
    procfs.readFile.mockImplementation((file) => {
      expect(file).toBe(`/proc/${process.pid}/cmdline`);
      if (fixture.code) {
        throw Object.assign(new Error("command unavailable"), { code: fixture.code });
      }
      return fixture.input!;
    });

    const inspected = readCodexAppServerProcessCommand(observedProcess, performance.now() + 1_000);
    await expect(inspected).rejects.toMatchObject({ reason: fixture.reason });
    if (fixture.reason !== "permission") {
      await expect(inspected).rejects.not.toThrow("permissions");
    }
    if (fixture.reason === "deadline") {
      await expect(inspected).rejects.toThrow("deadline");
      procfs.readFile.mockClear();
      await expect(
        readCodexAppServerProcessCommand(observedProcess, performance.now() - 1),
      ).rejects.toMatchObject({ reason: "deadline" });
      expect(procfs.readFile).not.toHaveBeenCalled();
    }
  });

  it.for(["command at limit", "command overflow", "snapshot overflow"])(
    "enforces the selected-read byte budget: %s",
    async (mode) => {
      const maxBytes = 8 * 1024 * 1024;
      mockProcfs((file) => {
        if (file.endsWith("/cmdline")) {
          return "x".repeat(maxBytes + Number(mode === "command overflow"));
        }
        const pid = file === `/proc/${process.pid}/stat` ? process.pid : process.pid + 1;
        return pid === process.pid ? stat(pid).padEnd(maxBytes - 10, " ") : stat(pid);
      });
      const inspected =
        mode === "snapshot overflow"
          ? readCodexAppServerProcessSnapshot(performance.now() + 10_000, [process.pid + 1])
          : readCodexAppServerProcessCommand(observedProcess, performance.now() + 10_000);
      if (mode === "command at limit") {
        expect((await inspected).length).toBe(maxBytes);
      } else {
        await expect(inspected).rejects.toMatchObject({ reason: "unavailable" });
      }
    },
  );

  it.for(["2", "9007199254740992"])("validates zombie thread counts: %s", async (threads) => {
    mockProcfs((file) => {
      expect(file).toBe(`/proc/${process.pid}/stat`);
      return stat(process.pid, threads, "Z");
    });
    const snapshot = readCodexAppServerProcessSnapshot(undefined, [process.pid]);
    if (threads === "2") {
      await expect(snapshot).resolves.toEqual([{ ...observedProcess, state: "Zl" }]);
    } else {
      await expect(snapshot).rejects.toMatchObject({ reason: "unavailable" });
    }
  });

  it.for(["ESRCH", "EACCES", "exiting"] as const)(
    "distinguishes vanished and unreadable neighbors: %s",
    async (code) => {
      const neighborPid = process.pid + 1;
      procfs.readdir.mockReturnValue([String(process.pid), String(neighborPid)]);
      mockProcfs((file) => {
        if (file === `/proc/${process.pid}/stat`) {
          // Fields 3..22 follow the final ')', even when comm contains ')' and spaces.
          return `${process.pid} (codex ) worker) S ${process.ppid} ${process.pid}${" 0".repeat(14)} 1 0 12345${" 0".repeat(30)}\n`;
        }
        if (file === `/proc/${neighborPid}/stat`) {
          if (code === "exiting") {
            return `${neighborPid} (worker) Z 0 -1${" 0".repeat(16)} 12345\n`;
          }
          throw Object.assign(new Error("neighbor process read failed"), { code });
        }
        throw new Error(`Unexpected procfs read: ${file}`);
      });
      const snapshot = readCodexAppServerProcessSnapshot();
      if (code === "EACCES") {
        await expect(snapshot).rejects.toMatchObject({ reason: "permission" });
      } else {
        await expect(snapshot).resolves.toEqual([observedProcess]);
      }
      if (code === "exiting") {
        await expect(
          readCodexAppServerProcessSnapshot(undefined, [neighborPid]),
        ).rejects.toMatchObject({ reason: "unavailable" });
      }
    },
  );
});

describe.skipIf(process.platform !== "darwin")("Codex Darwin process inspector", () => {
  it("reads the observer through the shared native owner", async () => {
    const [observed] = await readCodexAppServerProcessSnapshot(undefined, [process.pid]);
    expect(observed).toMatchObject({
      pid: process.pid,
      ppid: process.ppid,
      pgid: expect.any(Number),
      state: expect.stringMatching(/^[RSZTI?]$/),
      startedAt: expect.stringMatching(/^\w{3} \w{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/),
    });
    expect(await readCodexAppServerProcessCommand(observed!, performance.now() + 1_000)).not.toBe(
      "",
    );
  });

  it("omits a reaped child while retaining the selected observer", async () => {
    const child = execFile(process.execPath, ["-e", ""], { env: {} });
    await once(child, "close");
    expect(child).toMatchObject({ exitCode: 0, pid: expect.any(Number) });
    const rows = await readCodexAppServerProcessSnapshot(undefined, [child.pid!]);
    expect(rows.map((row) => row.pid)).toEqual([process.pid]);
  });

  it.for(["snapshot", "tree", "command"] as const)(
    "preserves the native owner's deadline failure for %s",
    async (kind) => {
      const deadline = performance.now() - 1;
      const inspected =
        kind === "command"
          ? readCodexAppServerProcessCommand(observedProcess, deadline)
          : readCodexAppServerProcessSnapshot(
              deadline,
              [process.pid],
              kind === "tree" ? [process.pid] : undefined,
            );
      await expect(inspected).rejects.toMatchObject({
        name: "ProcessInspectionError",
        reason: "deadline",
      });
    },
  );

  it("preserves unavailable selected identity errors", async () => {
    await expect(readCodexAppServerProcessSnapshot(undefined, [-1])).rejects.toMatchObject({
      name: "ProcessInspectionError",
      reason: "unavailable",
    });
  });
});
