import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { assertMxcReadiness, warnMxcHostPrepIfNeeded } from "../src/readiness.js";

const SYSTEM32 = path.win32.join(
  process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
  "System32",
);
const ICACLS = path.win32.join(SYSTEM32, "icacls.exe");
const SC_EXE = path.win32.join(SYSTEM32, "sc.exe");

// Fake host whose only possibly-installed service is IsolationSession; querying any
// other name (such as the retired IsoEnvBroker) fails like `sc.exe` error 1060.
function depsFor(params: {
  isolationSession: "missing" | "running" | "stopped";
  systemDriveAcl?: string;
}) {
  const systemDriveAcl =
    params.systemDriveAcl ?? "C:\\ BUILTIN\\Administrators:(OI)(CI)(F)\n    S-1-15-2-1:(R)\n";
  const exec = vi.fn((command: string, args: readonly string[] = []) => {
    if (command === SC_EXE) {
      if (
        args[0] !== "query" ||
        args[1] !== "IsolationSession" ||
        params.isolationSession === "missing"
      ) {
        throw new Error("The specified service does not exist as an installed service.");
      }
      return params.isolationSession === "stopped"
        ? "STATE              : 1  STOPPED"
        : "STATE              : 4  RUNNING";
    }
    if (command === ICACLS) {
      return systemDriveAcl;
    }
    throw new Error(`unexpected command: ${command}`);
  }) as unknown as typeof execFileSync;
  return { execFileSync: exec };
}

describe("assertMxcReadiness", () => {
  test("is a no-op on non-Windows platforms", () => {
    const deps = depsFor({ isolationSession: "missing" });

    expect(() => assertMxcReadiness({ platform: "linux", deps })).not.toThrow();
    expect(deps.execFileSync).not.toHaveBeenCalled();
  });

  test("accepts an installed IsolationSession service (system-drive prep is advisory, not gated)", () => {
    const deps = depsFor({ isolationSession: "running" });

    expect(() => assertMxcReadiness({ platform: "win32", deps })).not.toThrow();
  });

  test("accepts an installed but stopped (demand-started) IsolationSession service", () => {
    const deps = depsFor({ isolationSession: "stopped" });

    expect(() => assertMxcReadiness({ platform: "win32", deps })).not.toThrow();
  });

  test("rejects Windows hosts when IsolationSession is not installed", () => {
    const deps = depsFor({ isolationSession: "missing" });

    expect(() => assertMxcReadiness({ platform: "win32", deps })).toThrow(
      /IsolationSession service is not installed/u,
    );
  });

  test("does NOT throw when system drive lacks AppContainer ACEs (advisory only)", () => {
    const deps = depsFor({
      isolationSession: "running",
      systemDriveAcl: "C:\\ BUILTIN\\Administrators:(OI)(CI)(F)\n",
    });

    expect(() => assertMxcReadiness({ platform: "win32", deps })).not.toThrow();
  });
});

describe("warnMxcHostPrepIfNeeded", () => {
  test("is a no-op on non-Windows platforms", () => {
    const warn = vi.fn();
    const deps = depsFor({ isolationSession: "running" });

    warnMxcHostPrepIfNeeded({ platform: "linux", deps, warn });
    expect(warn).not.toHaveBeenCalled();
  });

  test("warns when the system drive lacks AppContainer ACEs", () => {
    const warn = vi.fn();
    const deps = depsFor({
      isolationSession: "running",
      systemDriveAcl: "C:\\ BUILTIN\\Administrators:(OI)(CI)(F)\n",
    });

    warnMxcHostPrepIfNeeded({ platform: "win32", deps, warn });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/prepare-system-drive/u);
  });

  test("stays silent when the system drive is prepared (SID form)", () => {
    const warn = vi.fn();
    const deps = depsFor({ isolationSession: "running" });

    warnMxcHostPrepIfNeeded({ platform: "win32", deps, warn });
    expect(warn).not.toHaveBeenCalled();
  });

  test("stays silent when the system drive is prepared (display-name form)", () => {
    const warn = vi.fn();
    const deps = depsFor({
      isolationSession: "running",
      systemDriveAcl: "C:\\ APPLICATION PACKAGES:(R)\n    BUILTIN\\Administrators:(F)\n",
    });

    warnMxcHostPrepIfNeeded({ platform: "win32", deps, warn });
    expect(warn).not.toHaveBeenCalled();
  });
});
