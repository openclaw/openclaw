import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { assertMxcReadiness, warnMxcHostPrepIfNeeded } from "../src/readiness.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalNodeVersion = Object.getOwnPropertyDescriptor(process.versions, "node")!;
function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
}
function setNodeVersion(version: string) {
  Object.defineProperty(process.versions, "node", { ...originalNodeVersion, value: version });
}
beforeEach(() => {
  setPlatform("win32");
  setNodeVersion("24.21.0");
  vi.mocked(execFileSync).mockReset();
});
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  Object.defineProperty(process.versions, "node", originalNodeVersion);
  vi.restoreAllMocks();
});

const SYSTEM32 = path.win32.join(
  process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
  "System32",
);
const ICACLS = path.win32.join(SYSTEM32, "icacls.exe");
const NATIVE_ENV = { MXC_BIN_DIR: "C:\\mxc\\bin", MXC_FFI_DIR: "C:\\mxc\\bin\\x64" };

function probeOutput(result: Record<string, unknown>): string {
  return JSON.stringify({ probe: { warnings: [], probes: {}, ...result } });
}

// Only the plugin launcher, run with the pinned native environment, answers --probe.
function mockProbe(params: { probe?: string | Error; systemDriveAcl?: string } = {}) {
  const probe = params.probe ?? probeOutput({ tier: "base-container" });
  const systemDriveAcl =
    params.systemDriveAcl ?? "C:\\ BUILTIN\\Administrators:(OI)(CI)(F)\n    S-1-15-2-1:(R)\n";
  const exec = vi.mocked(execFileSync).mockImplementation((command, args = [], options) => {
    if (
      command === process.execPath &&
      String(args[0]).endsWith("mxc-spawn-launcher.mjs") &&
      args[1] === "--probe"
    ) {
      const env = (options as { env?: Record<string, string> } | undefined)?.env;
      if (env?.MXC_FFI_DIR !== NATIVE_ENV.MXC_FFI_DIR || env.MXC_BIN_DIR !== NATIVE_ENV.MXC_BIN_DIR) {
        throw new Error("probe ran without the pinned native environment");
      }
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

    expect(() => assertMxcReadiness({ nativeEnv: NATIVE_ENV })).not.toThrow();
    expect(exec).not.toHaveBeenCalled();
  });

  test("accepts a base-container host without an isolation notice", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    mockProbe({ probe: probeOutput({ tier: "base-container" }) });

    expect(() => assertMxcReadiness({ nativeEnv: NATIVE_ENV })).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  test.each(["appcontainer-dacl", "appcontainer-bfs"])(
    "accepts the %s tier and discloses that it runs without LPAC",
    (tier) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      mockProbe({ probe: probeOutput({ tier }) });

      expect(() => assertMxcReadiness({ nativeEnv: NATIVE_ENV })).not.toThrow();
      expect(warn).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledOnce();
      expect(info.mock.calls[0]?.[0]).toMatch(
        new RegExp(`${tier} isolation tier.*regular AppContainer.*ALL APPLICATION PACKAGES`, "u"),
      );
    },
  );

  test("reports MXC tier degradation warnings without blocking activation", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockProbe({
      probe: probeOutput({
        tier: "base-container",
        warnings: ["DACL deny augmentation is unavailable"],
      }),
    });

    expect(() => assertMxcReadiness({ nativeEnv: NATIVE_ENV })).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(
      /base-container isolation tier: DACL deny augmentation is unavailable/u,
    );
  });

  test.each(["24.18.0", "25.9.0", "26.7.0"])(
    "rejects Node.js %s, which MXC SDK 1.0 cannot run commands on, before probing",
    (version) => {
      setNodeVersion(version);
      const exec = mockProbe();

      expect(() => assertMxcReadiness({ nativeEnv: NATIVE_ENV })).toThrow(
        `requires Node.js 24.21.0 or newer within Node.js 24, or 26.8.0 or newer on Windows, and the Gateway runs Node.js ${version}`,
      );
      expect(exec).not.toHaveBeenCalled();
    },
  );

  test.each(["26.8.0", "27.0.0"])("accepts Node.js %s", (version) => {
    setNodeVersion(version);
    mockProbe();

    expect(() => assertMxcReadiness({ nativeEnv: NATIVE_ENV })).not.toThrow();
  });

  test("rejects hosts where MXC cannot select an isolation tier", () => {
    mockProbe({
      probe: probeOutput({
        error: "DACL fallback required but fallback.allowDaclMutation is false",
      }),
    });

    expect(() => assertMxcReadiness({ nativeEnv: NATIVE_ENV })).toThrow(
      /cannot select an isolation tier on this host \(DACL fallback required.*MXC 1\.0 release layout/u,
    );
  });

  test("rejects an unsupported tier even if the probe returns success", () => {
    mockProbe({
      probe: probeOutput({ tier: "none", error: "isolation unavailable" }),
    });

    expect(() => assertMxcReadiness({ nativeEnv: NATIVE_ENV })).toThrow(
      /host check returned an unexpected result/u,
    );
  });

  test("rejects hosts where the MXC probe cannot run", () => {
    mockProbe({ probe: new Error("Command failed: mxc-spawn-launcher.mjs --probe") });

    expect(() => assertMxcReadiness({ nativeEnv: NATIVE_ENV })).toThrow(
      /host check failed: Command failed.*C:\\mxc\\bin\\x64.*unset plugins\.entries\.mxc\.config\.mxcBinaryPath/u,
    );
  });

  test("rejects a probe that does not report JSON", () => {
    mockProbe({ probe: "Error: MXC native component is missing" });

    expect(() => assertMxcReadiness({ nativeEnv: NATIVE_ENV })).toThrow(
      /host check did not return JSON.*unset plugins\.entries\.mxc\.config\.mxcBinaryPath/u,
    );
  });

  test("probes with the configured native components", () => {
    mockProbe();

    expect(() =>
      assertMxcReadiness({
        nativeEnv: { MXC_BIN_DIR: "C:\\override", MXC_FFI_DIR: "C:\\override\\x64" },
      }),
    ).toThrow(/host check failed: probe ran without the pinned native environment/u);
  });

  test("does not gate activation on system-drive preparation", () => {
    mockProbe({ systemDriveAcl: "C:\\ BUILTIN\\Administrators:(OI)(CI)(F)\n" });

    expect(() => assertMxcReadiness({ nativeEnv: NATIVE_ENV })).not.toThrow();
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
