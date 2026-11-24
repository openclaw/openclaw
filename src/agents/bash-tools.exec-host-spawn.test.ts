import { afterEach, expect, it, vi } from "vitest";
import { createMainThreadStallMonitor, getMainThreadTaskName } from "../infra/main-thread-stall.js";
import { prepareHostExecSpawn } from "./bash-tools.exec-host-spawn.js";

vi.mock("./shell-utils.js", async (original) => ({
  ...(await original<typeof import("./shell-utils.js")>()),
  getShellConfig: async () => ({ shell: "/bin/bash", args: ["-c"] }),
}));
vi.mock("./shell-snapshot.js", async (original) => ({
  ...(await original<typeof import("./shell-snapshot.js")>()),
  maybeWrapCommandWithShellSnapshot: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

it.skipIf(Boolean(process.versions.bun))(
  "attributes a blocked snapshot preparation continuation and restores the caller's context",
  async () => {
    const { maybeWrapCommandWithShellSnapshot } = await import("./shell-snapshot.js");
    let now = 0;
    const monitor = createMainThreadStallMonitor(() => now);
    monitor.setEventLoopSampling(true);
    vi.mocked(maybeWrapCommandWithShellSnapshot).mockImplementation(async ({ command }) => {
      await Promise.resolve();
      expect(getMainThreadTaskName()).toBe("exec:spawn-prepare");
      now += 1_200;
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
      expect(monitor.drain().stalls).toContainEqual(
        expect.objectContaining({ task: "exec:spawn-prepare", elapsedMs: 1_200 }),
      );
    } finally {
      monitor.stop();
    }
  },
);
