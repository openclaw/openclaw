import fs from "node:fs/promises";
import os from "node:os";
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
const memoryOwner = vi.hoisted(() => ({ resetBudget: () => {} }));
vi.mock("../shared/global-singleton.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/global-singleton.js")>();
  return {
    ...actual,
    resolveGlobalSingleton: (...args: Parameters<typeof actual.resolveGlobalSingleton>) => {
      const owner = actual.resolveGlobalSingleton(...args);
      if (args[0] === Symbol.for("openclaw.hostExecMemory") && owner && typeof owner === "object") {
        memoryOwner.resetBudget = () => {
          Object.assign(owner, { budget: undefined });
        };
      }
      return owner;
    },
  };
});

let supervisor: ReturnType<typeof createProcessSupervisor>;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  supervisor = createProcessSupervisor();
});
afterEach(async () => {
  await supervisor.shutdown();
  memoryOwner.resetBudget();
  resetProcessRegistryForTests();
  vi.restoreAllMocks();
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

it.skipIf(process.platform !== "linux")(
  "completes host exec above the former per-command quarter while shared capacity is unused",
  async () => {
    vi.spyOn(os, "totalmem").mockReturnValue(1024 ** 3);
    vi.spyOn(process, "constrainedMemory").mockReturnValue(1024 ** 3);
    vi.spyOn(process.memoryUsage, "rss").mockReturnValue(0);
    const cwd = tempDirs.make("exec-shared-memory-");
    const fixture = path.join(cwd, "command.cjs");
    await fs.writeFile(
      fixture,
      `const allocation = Buffer.alloc(320 * 1024 ** 2, 1);
setTimeout(() => process.stdout.write(allocation[0] === 1 ? "memory-fit" : "corrupt"), 1500);
`,
    );
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await withEnvAsync(
      {
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
          cwd,
        });
        const result = await exec.execute("memory", {
          command: `exec ${quote(process.execPath)} ${quote(fixture)}`,
          timeoutSeconds: 10,
        });
        expect(result.details).toMatchObject({
          status: "completed",
          exitCode: 0,
          aggregated: "memory-fit",
        });
      },
    );
  },
);
