// Qa Lab tests cover Windows process tree sampling command selection.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: spawnSyncMock,
  };
});

import { readProcessTreeCpuMs } from "./process-tree-cpu.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  spawnSyncMock.mockReset();
});

describe("readProcessTreeCpuMs on Windows", () => {
  it("uses the trusted Windows PowerShell path", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("SystemRoot", "D:\\Windows");
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify([
        {
          ProcessId: 100,
          ParentProcessId: 50,
          KernelModeTime: "10000",
          UserModeTime: "20000",
          WorkingSetSize: "1000",
        },
        {
          ProcessId: 101,
          ParentProcessId: 100,
          KernelModeTime: "30000",
          UserModeTime: "40000",
          WorkingSetSize: "2000",
        },
      ]),
    });

    expect(readProcessTreeCpuMs(100)).toBe(10);
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe(
      path.win32.join("D:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    );
  });
});
