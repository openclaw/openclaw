import { afterEach, expect, it, vi } from "vitest";
import { createMainThreadStallMonitor, getMainThreadTaskName } from "../infra/main-thread-stall.js";
import { prepareHostExecSpawn } from "./bash-tools.exec-host-spawn.js";

vi.mock("./shell-utils.js", async (original) => ({
  ...(await original<typeof import("./shell-utils.js")>()),
  getShellConfig: () => ({ shell: "/bin/bash", args: ["-c"], commandTransport: "argv" }),
}));
vi.mock("./shell-snapshot.js", async (original) => ({
  ...(await original<typeof import("./shell-snapshot.js")>()),
  maybeWrapCommandWithShellSnapshot: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

it("carries the preparation label across a snapshot wait and restores the caller's context", async () => {
  const { maybeWrapCommandWithShellSnapshot } = await import("./shell-snapshot.js");
  const monitor = createMainThreadStallMonitor();
  vi.mocked(maybeWrapCommandWithShellSnapshot).mockImplementation(async ({ command }) => {
    await Promise.resolve();
    expect(getMainThreadTaskName()).toBe("exec:spawn-prepare");
    return command;
  });
  try {
    const prepared = await prepareHostExecSpawn({
      command: "printf synthetic",
      workdir: "/synthetic/workspace",
      env: {},
      usePty: false,
    });
    expect(prepared.argv).toEqual(["/bin/bash", "-c", "printf synthetic"]);
    expect(getMainThreadTaskName()).toBeUndefined();
  } finally {
    monitor.stop();
  }
});
