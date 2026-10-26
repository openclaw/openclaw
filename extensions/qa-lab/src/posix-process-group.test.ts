import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  inspectLinuxProcessGroup,
  isQaPosixProcessGroupAlive,
  signalQaPosixProcessGroup,
} from "./posix-process-group.js";
import { inspectLinuxProcessGroupStats as inspectStats } from "./posix-process-stat.js";

const procFs = vi.hoisted(() => ({ readFileSync: vi.fn(), readdirSync: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const overrides = {
    readFileSync: procFs.readFileSync.mockImplementation(actual.readFileSync),
    readdirSync: procFs.readdirSync.mockImplementation(actual.readdirSync),
  };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

afterEach(() => vi.restoreAllMocks());

beforeEach(() => vi.spyOn(process, "platform", "get").mockReturnValue("linux"));

function mockProcMembers(names: string[]) {
  procFs.readdirSync.mockReturnValueOnce(names.map((name) => ({ name, isDirectory: () => true })));
}

it("uses canonical death evidence only for members of the requested group", () => {
  const isDead = vi.fn(() => true);
  const stats = ["123 (leader) Z 1 123", "124 (helper (worker)) X 1 123", "125 (x) S 1 999"];
  const inspection = inspectStats(123, stats, isDead);
  expect(inspection).toEqual({
    alive: false,
    diagnostics:
      'pgid=123 members=[pid=123 state=Z command="leader", pid=124 state=X command="helper (worker)"]',
  });
  expect(isDead.mock.calls).toEqual([[123], [124]]);
});

it("bounds process group diagnostics", () => {
  const stats = Array.from({ length: 300 }, (_, i) => `${i + 1} (worker) S 1 123`);
  const inspection = inspectStats(123, stats, () => false);

  expect(inspection.alive).toBe(true);
  expect(inspection.diagnostics.length).toBeLessThanOrEqual(2_048);
  expect(inspection.diagnostics).toMatch(/\.\.\.$/u);
});

it("reports unreadable /proc state as inconclusive", () => {
  mockProcMembers(["123", "999"]);
  procFs.readFileSync.mockReturnValueOnce("123 (leader) Z 1 123").mockImplementationOnce(() => {
    throw Object.assign(new Error("stat read failed"), { code: "EACCES" });
  });
  expect(inspectLinuxProcessGroup(123)).toBeNull();
});

it.each([
  [2, true],
  [1, false],
])("zombie threads=%s alive=%s", (threads, alive) => {
  vi.spyOn(process, "kill").mockImplementation(() => true);
  mockProcMembers(["123"]);
  procFs.readFileSync
    .mockClear()
    .mockReturnValueOnce("123 (leader) Z 1 123")
    .mockReturnValueOnce(`State:\tZ\nThreads:\t${threads}\n`);

  expect(isQaPosixProcessGroupAlive(123)).toBe(alive);
  expect(procFs.readFileSync).toHaveBeenCalledWith("/proc/123/status", "utf8");
});

it.each(["empty", "unreadable"])("re-probes an inconclusive %s snapshot", (snapshot) => {
  const inspection = snapshot === "empty" ? inspectStats(123, [], () => true) : null;
  let present = true;
  vi.spyOn(process, "kill").mockImplementation(() => {
    if (!present) {
      throw Object.assign(new Error("group reaped"), { code: "ESRCH" });
    }
    return true;
  });

  // The last zombie is reaped between the existence probe and the /proc scan.
  expect(
    isQaPosixProcessGroupAlive(123, () => {
      present = false;
      return inspection;
    }),
  ).toBe(false);
  present = true;
  expect(isQaPosixProcessGroupAlive(123, () => inspection)).toBe(true);
});

it.each(["ESRCH", "EPERM"])("preserves the group signal contract on %s", (code) => {
  const failure = Object.assign(new Error("group signal failed"), { code });
  const processKill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw failure;
  });

  expect(signalQaPosixProcessGroup(123, "SIGKILL")).toBe(code === "ESRCH" ? undefined : failure);
  expect(processKill.mock.calls).toEqual([[-123, "SIGKILL"]]);
});
