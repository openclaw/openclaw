import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawnSync: spawnSyncMock };
});

import { readProcessTreeCpuMs, readProcessTreeRssBytes } from "./process-tree-cpu.js";

beforeEach(() => vi.spyOn(process, "platform", "get").mockReturnValue("win32"));

function processEntry(overrides: Record<string, string | number> = {}) {
  return {
    ProcessId: 100,
    ParentProcessId: 50,
    KernelModeTime: "20000",
    UserModeTime: 30_000,
    WorkingSetSize: "1048576",
    ...overrides,
  };
}

function useSnapshot(value: unknown) {
  spawnSyncMock.mockReturnValue({ status: 0, stdout: JSON.stringify(value) });
}

function expectMetrics(pid: number, cpu: number | null, rss: number | null) {
  expect([readProcessTreeCpuMs(pid), readProcessTreeRssBytes(pid)]).toEqual([cpu, rss]);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  spawnSyncMock.mockReset();
});

describe("readProcessTreeCpuMs on Windows", () => {
  it("parses single-process Windows CPU and RSS counters", () => {
    useSnapshot(processEntry());
    expectMetrics(100, 5, 1_048_576);
  });

  it("parses process tree CPU and RSS metrics through the trusted PowerShell path", () => {
    vi.stubEnv("SystemRoot", "D:\\Windows");
    useSnapshot([
      processEntry({ KernelModeTime: "10000", UserModeTime: "20000", WorkingSetSize: "1000" }),
      processEntry({
        ProcessId: 101,
        ParentProcessId: 100,
        KernelModeTime: "30000",
        UserModeTime: "40000",
        WorkingSetSize: "2000",
      }),
    ]);
    expectMetrics(100, 10, 3_000);
    expectMetrics(101, 7, 2_000);
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe(
      path.win32.join("D:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    );
    expect(spawnSyncMock.mock.calls[0]?.[2]).toEqual({
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
  });

  it("rejects non-decimal Windows process counters", () => {
    useSnapshot(
      processEntry({ KernelModeTime: "0x10", UserModeTime: "30000", WorkingSetSize: "0x1000" }),
    );
    expectMetrics(100, null, null);
  });

  it("skips Windows process entries with non-decimal process ids", () => {
    useSnapshot(processEntry({ ProcessId: "0x64" }));
    expectMetrics(100, null, null);
  });

  it("rejects malformed Windows process snapshots", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: "not json",
    });

    expectMetrics(100, null, null);
  });
});
