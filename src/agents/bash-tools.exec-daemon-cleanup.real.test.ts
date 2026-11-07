import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";
import { createAgentCleanupScope } from "./run-cleanup-timeout.js";

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => supervisor,
}));

const supervisor = createProcessSupervisor();
afterEach(() => resetProcessRegistryForTests());

it.skipIf(process.platform === "win32")(
  "preserves the real root exit when an escaped daemon retains its lineage pipe",
  async ({ onTestFinished }) => {
    // Cleanup callbacks run in reverse order: stop the daemon before removing its PID file.
    const tempDirs = useAutoCleanupTempDirTracker(onTestFinished);
    const cwd = tempDirs.make("exec-daemon-cleanup-");
    const pidFile = path.join(cwd, "daemon.pid");
    const fixture = path.join(cwd, "command.cjs");
    await fs.writeFile(
      fixture,
      `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
  detached: true,
  stdio: ["ignore", "ignore", "ignore", 3],
});
child.unref();
child.once("spawn", () => {
  fs.writeFileSync(process.argv[2], String(child.pid));
  process.stdout.write("daemon started");
  process.exitCode = 3;
});
`,
    );
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const cleanupScope = createAgentCleanupScope();
    const releaseScope = supervisor.acquireScopeCleanup("exec-daemon-cleanup-test", {
      processTree: "required-all",
    });
    onTestFinished(async () => {
      const pid = Number(await fs.readFile(pidFile, "utf8").catch(() => ""));
      if (Number.isSafeInteger(pid) && pid > 1) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            throw error;
          }
        }
      }
      await releaseScope().catch(() => {});
      await supervisor.shutdown().catch(() => {});
    });
    await withEnvAsync(
      {
        OPENCLAW_SERVICE_MARKER: "exec-daemon-cleanup-test",
        OPENCLAW_STATE_DIR: path.join(cwd, "state"),
        OPENCLAW_HOME: cwd,
        OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
        SHELL: "/bin/sh",
      },
      async () => {
        const result = await cleanupScope.run(async () => {
          const run = await runExecProcess({
            command:
              "exec " + quote(process.execPath) + " " + quote(fixture) + " " + quote(pidFile),
            workdir: cwd,
            env: { PATH: process.env.PATH ?? "", HOME: cwd },
            usePty: false,
            warnings: [],
            maxOutput: 2000,
            pendingMaxOutput: 2000,
            notifyOnExit: false,
            timeoutSec: 15,
            scopeKey: "exec-daemon-cleanup-test",
          });
          const outcome = await run.promise;
          expect(run.session.finalizationFailed).toBe(true);
          return outcome;
        });
        expect(result).toMatchObject({ status: "completed", exitCode: 3 });
        expect(result.aggregated).toContain("daemon started");
        expect(result.aggregated).toContain("could not confirm");
        expect(cleanupScope.outcome).toBe("uncertain");
        await expect(releaseScope()).rejects.toThrow();
        await expect(supervisor.shutdown()).rejects.toThrow();
      },
    );
  },
  20_000,
);
