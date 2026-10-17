import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
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

it.skipIf(process.platform === "win32")(
  "keeps parent timers responsive and reaps the inspector when a command read blocks",
  async () => {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [
          "--import",
          path.resolve("scripts/tsx.mjs"),
          fileURLToPath(
            new URL(
              "./test-support/transport-process-blocked-command.test-support.mjs",
              import.meta.url,
            ),
          ),
        ],
        { timeout: 10_000 },
        (error: Error | null, output: string) => (error ? reject(error) : resolve(output)),
      );
    });
    const result = JSON.parse(stdout);
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
  "inspects procfs identities, commands and full trees despite filesystem worker starvation",
  async () => {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [
          "--import",
          path.resolve("scripts/tsx.mjs"),
          fileURLToPath(
            new URL(
              "./test-support/transport-process-starvation.test-support.mjs",
              import.meta.url,
            ),
          ),
          ...(process.platform === "linux" ? [] : ["--fixture-procfs"]),
        ],
        { env: { ...process.env, UV_THREADPOOL_SIZE: "1" }, timeout: 15_000 },
        (error: Error | null, output: string) => (error ? reject(error) : resolve(output)),
      );
    });
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

it.for(["snapshot", "command"] as const)(
  "normalizes synchronous inspector launch denial for %s",
  async (kind, ctx) => {
    ctx.onTestFinished(() => {
      vi.restoreAllMocks();
    });
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
  },
);

describe("Codex procfs command inspector", () => {
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
  ])("binds empty-command startup readiness to the same live process: %s", async (mode, ctx) => {
    ctx.onTestFinished(() => {
      procfs.readFile.mockReset();
      vi.useRealTimers();
      vi.restoreAllMocks();
    });
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    // Synthetic reads and their deadline timer share one clock despite host scheduling.
    // The inspection deadline runs on the monotonic clock (performance.now), so a
    // wall-clock rewind cannot stretch it; advance the monotonic clock to the deadline
    // to exercise the deadline-exceeded path.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let monotonicNowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => monotonicNowMs);
    const deadline = performance.now() + 250;
    const bootId = "00000000-0000-0000-0000-000000000001";
    let commandReads = 0;
    procfs.readFile.mockImplementation((file) => {
      if (file === "/proc/sys/kernel/random/boot_id") {
        return bootId;
      }
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
      if (commandReads && (mode === "gone" || mode === "permission")) {
        throw Object.assign(new Error("identity unavailable"), {
          code: mode === "gone" ? "ENOENT" : "EACCES",
        });
      }
      if (commandReads && mode === "malformed") {
        return "";
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
        reason:
          mode === "empty" ? "deadline" : mode === "permission" ? "permission" : "unavailable",
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
  ])(
    "reads command identity without authorizing absent or unreadable processes: %j",
    async (fixture, ctx) => {
      ctx.onTestFinished(() => {
        procfs.readFile.mockReset();
        vi.restoreAllMocks();
      });
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      procfs.readFile.mockImplementation((file) => {
        expect(file).toBe(`/proc/${process.pid}/cmdline`);
        if (fixture.code) {
          throw Object.assign(new Error("command unavailable"), { code: fixture.code });
        }
        return fixture.input!;
      });

      const inspected = readCodexAppServerProcessCommand(
        observedProcess,
        performance.now() + 1_000,
      );
      await expect(inspected).rejects.toMatchObject({ reason: fixture.reason });
      if (fixture.reason !== "permission") {
        await expect(inspected).rejects.not.toThrow("permissions");
      }
      if (fixture.reason === "deadline") {
        await expect(inspected).rejects.toThrow("deadline");
      }
      procfs.readFile.mockClear();
      await expect(
        readCodexAppServerProcessCommand(observedProcess, performance.now() - 1),
      ).rejects.toMatchObject({ reason: "deadline" });
      expect(procfs.readFile).not.toHaveBeenCalled();
    },
  );
});

describe("Codex procfs process inspector", () => {
  it.for(["command at limit", "command overflow", "snapshot overflow"])(
    "keeps selected procfs reads within the inspection byte budget: %s",
    async (mode, ctx) => {
      ctx.onTestFinished(() => {
        procfs.readFile.mockReset();
        vi.restoreAllMocks();
      });
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      const maxBytes = 8 * 1024 * 1024;
      procfs.readFile.mockImplementation((file) => {
        if (file === "/proc/sys/kernel/random/boot_id") {
          return "00000000-0000-0000-0000-000000000001";
        }
        if (file.endsWith("/cmdline")) {
          return "x".repeat(maxBytes + Number(mode === "command overflow"));
        }
        const pid = file === `/proc/${process.pid}/stat` ? process.pid : process.pid + 1;
        const stat = `${pid} (worker) S ${process.ppid} ${pid}${" 0".repeat(14)} 1 0 12345\n`;
        return pid === process.pid ? stat.padEnd(maxBytes - 10, " ") : stat;
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

  it.for(["2", "9007199254740992"])(
    "requires explicit thread evidence before classifying a zombie leader: %s",
    async (threads, ctx) => {
      ctx.onTestFinished(() => {
        procfs.readFile.mockReset();
        vi.restoreAllMocks();
      });
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      procfs.readFile.mockImplementation((file) => {
        if (file === "/proc/sys/kernel/random/boot_id") {
          return "00000000-0000-0000-0000-000000000001";
        }
        expect(file).toBe(`/proc/${process.pid}/stat`);
        return `${process.pid} (worker) Z ${process.ppid} ${process.pid}${" 0".repeat(14)} ${threads} 0 12345\n`;
      });
      const snapshot = readCodexAppServerProcessSnapshot(undefined, [process.pid]);
      if (threads === "1" || threads === "2") {
        await expect(snapshot).resolves.toEqual([
          { ...observedProcess, state: threads === "1" ? "Z" : "Zl" },
        ]);
      } else {
        await expect(snapshot).rejects.toMatchObject({ reason: "unavailable" });
      }
    },
  );

  it.for(["ESRCH", "EACCES", "exiting"] as const)(
    "distinguishes vanished or exiting neighbors from unreadable state: %s",
    async (code, ctx) => {
      ctx.onTestFinished(() => {
        procfs.readFile.mockReset();
        procfs.readdir.mockReset();
        vi.restoreAllMocks();
      });
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      const bootId = "00000000-0000-0000-0000-000000000001";
      const neighborPid = process.pid + 1;
      procfs.readdir.mockReturnValue([String(process.pid), String(neighborPid)]);
      procfs.readFile.mockImplementation((file) => {
        if (file === "/proc/sys/kernel/random/boot_id") {
          return bootId;
        }
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
        await expect(snapshot).resolves.toEqual([
          {
            pid: process.pid,
            ppid: process.ppid,
            pgid: process.pid,
            state: "S",
            startedAt: `${bootId}:12345`,
          },
        ]);
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
    const pid = await new Promise<number>((resolve, reject) => {
      const child = execFile(process.execPath, ["-e", ""], { env: {} }, (error) => {
        if (error) {
          reject(error);
        } else if (child.pid === undefined) {
          reject(new Error("Child PID is unavailable"));
        } else {
          resolve(child.pid);
        }
      });
    });
    const rows = await readCodexAppServerProcessSnapshot(undefined, [pid]);
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
