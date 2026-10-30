import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getSpawnBroker } from "../process/spawn-broker/context.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => supervisor,
}));

let supervisor: ReturnType<typeof createProcessSupervisor>;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  supervisor = createProcessSupervisor();
});
afterEach(async () => {
  await supervisor.shutdown();
  resetProcessRegistryForTests();
});

it.skipIf(process.platform === "win32")(
  "recovers from NUL input and releases every completed exec group while the session stays open",
  async () => {
    const cwd = tempDirs.make("exec-group-cleanup-");
    const fixture = path.join(cwd, "command.cjs");
    await fs.writeFile(
      fixture,
      `const { spawn, execFileSync } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
  stdio: ["ignore", "ignore", "ignore", 3],
});
child.unref();
child.once("spawn", () => {
  const grandparent = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(process.ppid)], { encoding: "utf8" }).trim());
  process.stdout.write(JSON.stringify([child.pid, process.ppid, grandparent]));
});
`,
    );
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const pids: number[] = [];
    await withEnvAsync(
      {
        OPENCLAW_SERVICE_MARKER: "exec-group-cleanup-test",
        OPENCLAW_STATE_DIR: path.join(cwd, "state"),
        OPENCLAW_HOME: cwd,
        OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
        SHELL: "/bin/sh",
      },
      async () => {
        const exec = createExecTool({
          host: "gateway",
          mode: "full",
          ask: "off",
          allowBackground: false,
          notifyOnExit: false,
          scopeKey: "agent:main:exec-group-cleanup",
          cwd,
        });
        await expect(exec.execute("invalid", { command: "printf bad\0command" })).rejects.toThrow(
          /NUL bytes|null bytes/,
        );
        const corrected = await exec.execute("corrected", {
          command: "printf '<%s>\\n' '' '\\0'\ncat <<'EOF'\nheredoc\\0\nEOF",
        });
        expect(corrected.details).toMatchObject({
          status: "completed",
          exitCode: 0,
          aggregated: "<>\n<\\0>\nheredoc\\0",
        });
        for (let call = 0; call < 5; call += 1) {
          const result = await exec.execute(`exec-${call}`, {
            command: `exec ${quote(process.execPath)} ${quote(fixture)}`,
          });
          expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
          if (result.details.status !== "completed") {
            throw new Error("exec did not complete");
          }
          const group: number[] = JSON.parse(result.details.aggregated);
          expect(group).toHaveLength(3);
          expect(group.every((pid) => Number.isSafeInteger(pid) && pid > 1)).toBe(true);
          // The direct native owner has a shared caller, not an owned relay above it.
          const hosts = new Set([process.pid, getSpawnBroker()?.pid]);
          pids.push(...group.filter((pid) => !hosts.has(pid)));
        }
        // Completed output remains available without retaining the process group.
        expect(pids.filter(isPidAlive)).toEqual([]);
        await supervisor.shutdown();
      },
    );
  },
);
