import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectLinuxProcessGroup,
  isQaPosixProcessGroupAlive,
  signalQaPosixProcessGroup,
} from "./posix-process-group.js";
import { inspectLinuxProcessGroupStats } from "./posix-process-stat.js";

const procFs = vi.hoisted(() => ({ readFileSync: vi.fn(), readdirSync: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const overrides = {
    readFileSync: procFs.readFileSync.mockImplementation(actual.readFileSync),
    readdirSync: procFs.readdirSync.mockImplementation(actual.readdirSync),
  };
  return {
    ...actual,
    ...overrides,
    default: { ...actual, ...overrides },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POSIX process group inspection", () => {
  it("uses canonical death evidence only for members of the requested group", () => {
    const isDead = vi.fn(() => true);
    expect(
      inspectLinuxProcessGroupStats(
        123,
        [
          "123 (leader) Z 1 123 123 0 -1 0",
          "124 (helper (worker)) X 1 123 123 0 -1 0",
          "125 (unrelated) S 1 999 999 0 -1 0",
        ],
        isDead,
      ),
    ).toEqual({
      alive: false,
      diagnostics:
        'pgid=123 members=[pid=123 state=Z command="leader", pid=124 state=X command="helper (worker)"]',
    });
    expect(isDead.mock.calls).toEqual([[123], [124]]);
  });

  it("bounds process group diagnostics", () => {
    const stats = Array.from(
      { length: 300 },
      (_, index) => `${index + 1} (${`worker-${index}`.padEnd(32, "x")}) S 1 123 123 0 -1 0`,
    );

    const inspection = inspectLinuxProcessGroupStats(123, stats, () => false);

    expect(inspection.alive).toBe(true);
    expect(inspection.diagnostics.length).toBeLessThanOrEqual(2_048);
    expect(inspection.diagnostics).toMatch(/\.\.\.$/u);
  });

  it.each(["EACCES"])(
    "distinguishes a vanished /proc member from unreadable state (%s)",
    (code) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      vi.spyOn(process, "kill").mockImplementation(() => true);
      procFs.readdirSync.mockReturnValueOnce([
        { name: "123", isDirectory: () => true },
        { name: "999", isDirectory: () => true },
      ]);
      procFs.readFileSync
        .mockReturnValueOnce("123 (leader) Z 1 123 123 0 -1 0")
        .mockImplementationOnce(() => {
          throw Object.assign(new Error("stat read failed"), { code });
        });
      if (code !== "EACCES") {
        procFs.readFileSync.mockReturnValueOnce("State:\tZ\nThreads:\t1\n");
      }

      const inspection = inspectLinuxProcessGroup(123);
      if (code === "EACCES") {
        expect(inspection).toBeNull();
      } else {
        expect(inspection?.alive).toBe(false);
      }
    },
  );

  it.each([
    { status: "State:\tZ\nThreads:\t2\n", alive: true },
    { status: "State:\tZ\nThreads:\t1\n", alive: false },
  ])("preserves cleanup until all threads have exited ($status)", ({ status, alive }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(process, "kill").mockImplementation(() => true);
    procFs.readdirSync.mockReturnValueOnce([{ name: "123", isDirectory: () => true }]);
    procFs.readFileSync
      .mockClear()
      .mockReturnValueOnce("123 (leader) Z 1 123 123 0 -1 0")
      .mockReturnValueOnce(status);

    expect(isQaPosixProcessGroupAlive(123)).toBe(alive);
    expect(procFs.readFileSync).toHaveBeenCalledWith("/proc/123/status", "utf8");
  });

  it.each(["empty"])(
    "confirms a group reaped during an %s Linux snapshot is stopped",
    (snapshot) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      let reaped = false;
      vi.spyOn(process, "kill").mockImplementation(() => {
        if (reaped) {
          throw Object.assign(new Error("group reaped"), { code: "ESRCH" });
        }
        return true;
      });

      expect(
        isQaPosixProcessGroupAlive(123, () => {
          reaped = true;
          return snapshot === "empty" ? inspectLinuxProcessGroupStats(123, [], () => true) : null;
        }),
      ).toBe(false);
    },
  );

  it.each(["ESRCH", "EPERM"])("preserves the group signal contract on %s", (code) => {
    const failure = Object.assign(new Error("group signal failed"), { code });
    const processKill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw failure;
    });

    expect(signalQaPosixProcessGroup(123, "SIGKILL")).toBe(code === "ESRCH" ? undefined : failure);
    expect(processKill.mock.calls).toEqual([[-123, "SIGKILL"]]);
  });
});
