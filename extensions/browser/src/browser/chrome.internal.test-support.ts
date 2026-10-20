import type { Mock } from "vitest";

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
