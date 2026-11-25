// Qa Lab tests cover Windows system tool path resolution.
import { describe, expect, it, vi } from "vitest";
import { resolveQaWindowsPowerShellExePath, runQaWindowsTaskkill } from "./windows-system-tools.js";

describe("qa-lab windows system tools", () => {
  it("resolves PowerShell from a trusted SystemRoot", () => {
    expect(resolveQaWindowsPowerShellExePath({ SystemRoot: "D:\\Windows\\" })).toBe(
      "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });

  it("force-kills a process tree when graceful taskkill fails", () => {
    const runCommand = vi
      .fn()
      .mockReturnValueOnce({ status: 1 })
      .mockReturnValueOnce({ status: 0 });

    expect(
      runQaWindowsTaskkill({
        pid: 12345,
        signal: "SIGTERM",
        env: { SystemRoot: "D:\\Windows" },
        runCommand,
      }),
    ).toBe(true);
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      "D:\\Windows\\System32\\taskkill.exe",
      ["/PID", "12345", "/T"],
      { stdio: "ignore", windowsHide: true, timeout: 5_000 },
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      "D:\\Windows\\System32\\taskkill.exe",
      ["/PID", "12345", "/T", "/F"],
      { stdio: "ignore", windowsHide: true, timeout: 5_000 },
    );
  });

  it("falls back to the default Windows root when env roots are unsafe", () => {
    const runCommand = vi.fn().mockReturnValue({ status: 0 });
    expect(
      runQaWindowsTaskkill({
        pid: 12345,
        signal: "SIGKILL",
        env: { SystemRoot: "C:\\tmp;C:\\bad" },
        runCommand,
      }),
    ).toBe(true);
    expect(runCommand).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/PID", "12345", "/T", "/F"],
      { stdio: "ignore", windowsHide: true, timeout: 5_000 },
    );
  });
});
