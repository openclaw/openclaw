import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { assertMxcReadiness, warnMxcHostPrepIfNeeded } from "../src/readiness.js";

const SYSTEM32 = path.win32.join(
  process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
  "System32",
);
const ICACLS = path.win32.join(SYSTEM32, "icacls.exe");
const MXC_EXE = "C:\\mxc\\bin\\x64\\wxc-exec.exe";

function probeOutput(result: Record<string, unknown>): string {
  return JSON.stringify({ warnings: [], probes: {}, ...result });
}

// Fake host: `probe` is what `wxc-exec --probe` prints for MXC_EXE (or the error it
// throws). Every other executable, including sc.exe, is missing.
function depsFor(params: { probe?: string | Error; systemDriveAcl?: string } = {}) {
  const probe = params.probe ?? probeOutput({ tier: "base-container" });
  const systemDriveAcl =
    params.systemDriveAcl ?? "C:\\ BUILTIN\\Administrators:(OI)(CI)(F)\n    S-1-15-2-1:(R)\n";
  const exec = vi.fn((command: string, args: readonly string[] = []) => {
    if (command === MXC_EXE && args[0] === "--probe") {
      if (probe instanceof Error) {
        throw probe;
      }
      return probe;
    }
    if (command === ICACLS) {
      return systemDriveAcl;
    }
    throw new Error(`spawn ${command} ENOENT`);
  }) as unknown as typeof execFileSync;
  return { execFileSync: exec };
}

describe("assertMxcReadiness", () => {
  test("is a no-op on non-Windows platforms", () => {
    const deps = depsFor({ probe: new Error("probe must not run") });

    expect(() =>
      assertMxcReadiness({ executablePath: MXC_EXE, platform: "linux", deps }),
    ).not.toThrow();
    expect(deps.execFileSync).not.toHaveBeenCalled();
  });

  test.each(["base-container", "appcontainer-bfs", "appcontainer-dacl"])(
    "accepts a host where MXC selects the %s tier",
    (tier) => {
      const warn = vi.fn();
      const deps = depsFor({ probe: probeOutput({ tier }) });

      expect(() =>
        assertMxcReadiness({ executablePath: MXC_EXE, platform: "win32", deps, warn }),
      ).not.toThrow();
      expect(warn).not.toHaveBeenCalled();
    },
  );

  test("reports MXC tier degradation warnings without blocking activation", () => {
    const warn = vi.fn();
    const deps = depsFor({
      probe: probeOutput({
        tier: "appcontainer-dacl",
        warnings: ["BaseContainer API is not present on this host"],
      }),
    });

    expect(() =>
      assertMxcReadiness({ executablePath: MXC_EXE, platform: "win32", deps, warn }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(
      /appcontainer-dacl isolation tier: BaseContainer API is not present/u,
    );
  });

  test("rejects hosts where MXC cannot select an isolation tier", () => {
    const deps = depsFor({
      probe: probeOutput({
        error: "DACL fallback required but fallback.allowDaclMutation is false",
      }),
    });

    expect(() => assertMxcReadiness({ executablePath: MXC_EXE, platform: "win32", deps })).toThrow(
      /cannot select an isolation tier on this host \(DACL fallback required.*--probe for host details/u,
    );
  });

  test("rejects hosts where the MXC probe cannot run", () => {
    const deps = depsFor({ probe: new Error("Command failed: wxc-exec.exe --probe") });

    expect(() => assertMxcReadiness({ executablePath: MXC_EXE, platform: "win32", deps })).toThrow(
      /host probe failed: Command failed/u,
    );
  });

  test("rejects a probe that does not report JSON", () => {
    const deps = depsFor({ probe: "wxc-exec: unknown option --probe" });

    expect(() => assertMxcReadiness({ executablePath: MXC_EXE, platform: "win32", deps })).toThrow(
      /host probe did not return JSON/u,
    );
  });

  test("probes the configured executor instead of another MXC binary", () => {
    const deps = depsFor();

    expect(() =>
      assertMxcReadiness({
        executablePath: "C:\\override\\wxc-exec.exe",
        platform: "win32",
        deps,
      }),
    ).toThrow(/host probe failed: spawn C:\\override\\wxc-exec\.exe ENOENT/u);
  });

  test("does not gate activation on system-drive preparation", () => {
    const deps = depsFor({ systemDriveAcl: "C:\\ BUILTIN\\Administrators:(OI)(CI)(F)\n" });

    expect(() =>
      assertMxcReadiness({ executablePath: MXC_EXE, platform: "win32", deps }),
    ).not.toThrow();
  });
});

describe("warnMxcHostPrepIfNeeded", () => {
  test("is a no-op on non-Windows platforms", () => {
    const warn = vi.fn();
    const deps = depsFor();

    warnMxcHostPrepIfNeeded({ platform: "linux", deps, warn });
    expect(warn).not.toHaveBeenCalled();
  });

  test("warns when the system drive lacks AppContainer ACEs", () => {
    const warn = vi.fn();
    const deps = depsFor({
      systemDriveAcl: "C:\\ BUILTIN\\Administrators:(OI)(CI)(F)\n",
    });

    warnMxcHostPrepIfNeeded({ platform: "win32", deps, warn });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/prepare-system-drive/u);
  });

  test("stays silent when the system drive is prepared (SID form)", () => {
    const warn = vi.fn();
    const deps = depsFor();

    warnMxcHostPrepIfNeeded({ platform: "win32", deps, warn });
    expect(warn).not.toHaveBeenCalled();
  });

  test("stays silent when the system drive is prepared (display-name form)", () => {
    const warn = vi.fn();
    const deps = depsFor({
      systemDriveAcl: "C:\\ APPLICATION PACKAGES:(R)\n    BUILTIN\\Administrators:(F)\n",
    });

    warnMxcHostPrepIfNeeded({ platform: "win32", deps, warn });
    expect(warn).not.toHaveBeenCalled();
  });
});
