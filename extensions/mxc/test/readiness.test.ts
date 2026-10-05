import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { assertMxcReadiness, warnMxcHostPrepIfNeeded } from "../src/readiness.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
}
beforeEach(() => {
  setPlatform("win32");
  vi.mocked(execFileSync).mockReset();
});
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.restoreAllMocks();
});

const SYSTEM32 = path.win32.join(
  process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
  "System32",
);
const ICACLS = path.win32.join(SYSTEM32, "icacls.exe");
const MXC_EXE = "C:\\mxc\\bin\\x64\\wxc-exec.exe";

function probeOutput(result: Record<string, unknown>): string {
  return JSON.stringify({ warnings: [], probes: {}, ...result });
}

// The fake has no sc.exe: only the selected MXC executable answers --probe.
function mockProbe(params: { probe?: string | Error; systemDriveAcl?: string } = {}) {
  const probe = params.probe ?? probeOutput({ tier: "base-container" });
  const systemDriveAcl =
    params.systemDriveAcl ?? "C:\\ BUILTIN\\Administrators:(OI)(CI)(F)\n    S-1-15-2-1:(R)\n";
  const exec = vi.mocked(execFileSync).mockImplementation((command, args = []) => {
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
  });
  return exec;
}

describe("assertMxcReadiness", () => {
  test("is a no-op on non-Windows platforms", () => {
    setPlatform("linux");
    const exec = mockProbe({ probe: new Error("probe must not run") });

    expect(() => assertMxcReadiness({ executablePath: MXC_EXE })).not.toThrow();
    expect(exec).not.toHaveBeenCalled();
  });

  test.each(["base-container", "appcontainer-bfs", "appcontainer-dacl"])(
    "accepts a host where MXC selects the %s tier",
    (tier) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockProbe({ probe: probeOutput({ tier }) });

      expect(() => assertMxcReadiness({ executablePath: MXC_EXE })).not.toThrow();
      expect(warn).not.toHaveBeenCalled();
    },
  );

  test("reports MXC tier degradation warnings without blocking activation", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockProbe({
      probe: probeOutput({
        tier: "appcontainer-dacl",
        warnings: ["BaseContainer API is not present on this host"],
      }),
    });

    expect(() => assertMxcReadiness({ executablePath: MXC_EXE })).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(
      /appcontainer-dacl isolation tier: BaseContainer API is not present/u,
    );
  });

  test("rejects hosts where MXC cannot select an isolation tier", () => {
    mockProbe({
      probe: probeOutput({
        error: "DACL fallback required but fallback.allowDaclMutation is false",
      }),
    });

    expect(() => assertMxcReadiness({ executablePath: MXC_EXE })).toThrow(
      /cannot select an isolation tier on this host \(DACL fallback required.*--probe for host details/u,
    );
  });

  test("rejects an unsupported tier even if the probe returns success", () => {
    mockProbe({
      probe: probeOutput({ tier: "none", error: "isolation unavailable" }),
    });

    expect(() => assertMxcReadiness({ executablePath: MXC_EXE })).toThrow(
      /host probe returned an unexpected result.*--probe for host details/u,
    );
  });

  test("rejects hosts where the MXC probe cannot run", () => {
    mockProbe({ probe: new Error("Command failed: wxc-exec.exe --probe") });

    expect(() => assertMxcReadiness({ executablePath: MXC_EXE })).toThrow(
      /host probe failed: Command failed.*older executor.*unset plugins\.entries\.mxc\.config\.mxcBinaryPath/u,
    );
  });

  test("rejects a probe that does not report JSON", () => {
    mockProbe({ probe: "wxc-exec: unknown option --probe" });

    expect(() => assertMxcReadiness({ executablePath: MXC_EXE })).toThrow(
      /host probe did not return JSON.*older executor.*unset plugins\.entries\.mxc\.config\.mxcBinaryPath/u,
    );
  });

  test("probes the configured executor instead of another MXC binary", () => {
    mockProbe();

    expect(() =>
      assertMxcReadiness({
        executablePath: "C:\\override\\wxc-exec.exe",
      }),
    ).toThrow(/host probe failed: spawn C:\\override\\wxc-exec\.exe ENOENT/u);
  });

  test("does not gate activation on system-drive preparation", () => {
    mockProbe({ systemDriveAcl: "C:\\ BUILTIN\\Administrators:(OI)(CI)(F)\n" });

    expect(() => assertMxcReadiness({ executablePath: MXC_EXE })).not.toThrow();
  });
});

describe("warnMxcHostPrepIfNeeded", () => {
  test("is a no-op on non-Windows platforms", () => {
    setPlatform("linux");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockProbe();

    warnMxcHostPrepIfNeeded();
    expect(warn).not.toHaveBeenCalled();
  });

  test("warns when the system drive lacks AppContainer ACEs", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockProbe({
      systemDriveAcl: "C:\\ BUILTIN\\Administrators:(OI)(CI)(F)\n",
    });

    warnMxcHostPrepIfNeeded();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/prepare-system-drive/u);
  });

  test("stays silent when the system drive is prepared (SID form)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockProbe();

    warnMxcHostPrepIfNeeded();
    expect(warn).not.toHaveBeenCalled();
  });

  test("stays silent when the system drive is prepared (display-name form)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockProbe({
      systemDriveAcl: "C:\\ APPLICATION PACKAGES:(R)\n    BUILTIN\\Administrators:(F)\n",
    });

    warnMxcHostPrepIfNeeded();
    expect(warn).not.toHaveBeenCalled();
  });
});
