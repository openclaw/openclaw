import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { createSpawnBrokerHost } from "../process/spawn-broker/host.js";
import { isPidDefinitelyDead } from "../shared/pid-alive.js";
import { maybeWrapCommandWithShellSnapshot } from "./shell-snapshot.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.skipIf(process.platform === "win32" || Boolean(process.versions.bun))(
  "shell snapshot broker deadlines",
  () => {
    it("cancels capture before its PID arrives and cleans up the late shell", async () => {
      const home = tempDirs.make("openclaw-snapshot-broker-deadline-");
      vi.stubEnv("HOME", home);
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, "state"));
      vi.stubEnv("OPENCLAW_EXEC_SHELL_SNAPSHOT", "1");
      const host = createSpawnBrokerHost();
      await host.ready();
      const spawn = vi.spyOn(host, "spawn");
      process.kill(host.pid!, "SIGSTOP");
      try {
        const command = "printf original";
        await expect(
          withTestTimeout(
            runWithSpawnBroker(host, () =>
              maybeWrapCommandWithShellSnapshot({
                command,
                shell: "/bin/bash",
                shellArgs: ["-c"],
                cwd: home,
                env: {},
              }),
            ),
            7_000,
            "capture did not honor its five-second deadline",
          ),
        ).resolves.toBe(command);
        expect(spawn).toHaveBeenCalledOnce();
        const child = spawn.mock.results[0]!.value;
        expect(child.pid).toBeUndefined();
        expect(child.killed).toBe(true);
        process.kill(host.pid!, "SIGCONT");
        await withTestTimeout(child.waitForClose(), 5_000, "late capture was not reaped");
        expect(isPidDefinitelyDead(child.pid!)).toBe(true);
      } finally {
        process.kill(host.pid!, "SIGCONT");
        await host.close();
      }
    });
  },
);
