import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.restoreAllMocks();
});

const ICACLS = path.win32.join(
  process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
  "System32",
  "icacls.exe",
);
const MXC_EXE = "C:\\mxc\\bin\\x64\\wxc-exec.exe";
const unpreparedAcl = "C:\\ BUILTIN\\Administrators:(OI)(CI)(F)\n";
const assertReady = () => assertMxcReadiness({ executablePath: MXC_EXE });
const expectWarning = (message: RegExp) =>
  expect(vi.mocked(console.warn).mock.calls).toEqual([[expect.stringMatching(message)]]);

function mockProbe(
  params: { probe?: string | Record<string, unknown>; systemDriveAcl?: string } = {},
) {
  const probe = params.probe ?? { tier: "base-container" };
  const systemDriveAcl = params.systemDriveAcl ?? `${unpreparedAcl}    S-1-15-2-1:(R)\n`;
  return vi.mocked(execFileSync).mockImplementation((command, args = []) => {
    if (command === MXC_EXE && args[0] === "--probe") {
      return typeof probe === "string" ? probe : JSON.stringify(probe);
    }
    if (command === ICACLS) {
      return systemDriveAcl;
    }
    throw new Error(`spawn ${command} ENOENT`);
  });
}

test.each([
  ["readiness", assertReady],
  ["host preparation", warnMxcHostPrepIfNeeded],
] as const)("%s is a no-op on non-Windows platforms", (_name, check) => {
  setPlatform("linux");
  const exec = mockProbe();
  expect(check).not.toThrow();
  expect(exec).not.toHaveBeenCalled();
  expect(console.warn).not.toHaveBeenCalled();
});

test("reports tier degradation without requiring system-drive preparation", () => {
  mockProbe({
    systemDriveAcl: unpreparedAcl,
    probe: {
      tier: "appcontainer-dacl",
      warnings: ["BaseContainer API is not present on this host"],
    },
  });

  expect(assertReady).not.toThrow();
  expectWarning(/appcontainer-dacl isolation tier: BaseContainer API is not present/u);
});

test.each([
  [
    { error: "DACL fallback required but fallback.allowDaclMutation is false" },
    /cannot select an isolation tier on this host \(DACL fallback required.*--probe for host details/u,
  ],
  [
    { tier: "none", error: "isolation unavailable" },
    /host check returned an unexpected result.*--probe for host details/u,
  ],
  [
    "wxc-exec: unknown option --probe",
    /host check did not return JSON.*older executor.*unset plugins\.entries\.mxc\.config\.mxcBinaryPath/u,
  ],
] as const)("rejects probe %j", (probe, error) => {
  mockProbe({ probe });
  expect(assertReady).toThrow(error);
});
test("warns when the system drive lacks AppContainer ACEs", () => {
  mockProbe({ systemDriveAcl: unpreparedAcl });

  warnMxcHostPrepIfNeeded();
  expectWarning(/prepare-system-drive/u);
});
