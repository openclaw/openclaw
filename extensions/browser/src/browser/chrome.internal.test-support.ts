import fs from "node:fs";
import { vi, type Mock } from "vitest";

/** Full-Chrome fixtures have no lockless headless-shell profile writers. */
export function createChromeInternalProcessMock(
  actual: typeof import("node:child_process"),
  execFileSyncMock: Mock,
  spawnMock: Mock,
) {
  const execFileSync = (...args: Parameters<typeof actual.execFileSync>) => {
    if (args[0] === "ps" && Array.isArray(args[1]) && args[1].includes("pid=,command=")) {
      // This fixture models full Chrome processes, not lockless shell writers.
      return "";
    }
    const mock = execFileSyncMock.getMockImplementation();
    return mock ? mock(...args) : actual.execFileSync(...args);
  };
  return {
    ...actual,
    default: { ...actual, execFileSync },
    execFileSync,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
}

export function stubBrowserExecutableAndPrefs(
  preferences: "present" | "missing",
  executablePath?: string,
) {
  vi.spyOn(fs, "existsSync").mockImplementation((p) => {
    const value = String(p);
    const isExecutable = executablePath
      ? value === executablePath
      : value.includes("Google Chrome") ||
        value.includes("google-chrome") ||
        value.includes("/usr/bin/chromium");
    const isPreferences = value.endsWith("Local State") || value.endsWith("Preferences");
    return isExecutable || (preferences === "present" && isPreferences);
  });
}
