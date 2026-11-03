import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { isProcessAlive } from "../../../test/scripts/live-process-fixture.test-support.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { execCommand } from "./exec.js";

const cleanupPids = new Set<number>();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function forceKillPid(pid: number): void {
  if (!isProcessAlive(pid)) {
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
      stdio: "ignore",
      timeout: 5_000,
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process exited between the liveness check and cleanup.
  }
}

describe("execCommand process-tree cleanup", () => {
  afterEach(() => {
    for (const pid of cleanupPids) {
      forceKillPid(pid);
    }
    cleanupPids.clear();
  });

  it("returns an exit result for a missing executable", async () => {
    const command = join(tempDirs.make("openclaw-exec-missing-"), "absent-command");
    await expect(execCommand(command, [], process.cwd())).resolves.toMatchObject({
      code: 1,
      killed: false,
      stdout: "",
      stderr: "",
    });
  });

  it.each([2 ** 31, Number.MAX_SAFE_INTEGER])(
    "allows a command to finish with a long timeout of %s ms",
    async (timeout) => {
      await expect(
        execCommand(process.execPath, ["-e", 'process.stdout.write("completed")'], process.cwd(), {
          timeout,
        }),
      ).resolves.toMatchObject({ stdout: "completed", stderr: "", code: 0, killed: false });
    },
  );

  it.runIf(process.platform !== "win32")(
    "returns the root tail while background work survives, then joins scope custody",
    async () => {
      let backgroundPid = 0;
      let anchorPid = 0;
      let settled = false;
      const descendant =
        "process.send('ready'); process.disconnect(); setTimeout(() => process.stdout.write('TAIL\\n'), 25); setInterval(() => {}, 1000)";
      const parent = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit','ipc']}); child.once('message',()=>process.stdout.write(child.pid+'\\nHEAD\\n',()=>process.exit(0)));`;
      await withCommandProcessScope(
        async () => {
          const result = await execCommand(process.execPath, ["-e", parent], process.cwd());
          backgroundPid = Number(result.stdout.split("\n")[0]);
          cleanupPids.add(backgroundPid);
          expect(result).toMatchObject({ code: 0, killed: false });
          expect(result.stdout).toContain("HEAD\nTAIL\n");
          expect(isProcessAlive(backgroundPid)).toBe(true);
          expect(isProcessAlive(anchorPid)).toBe(true);
          expect(settled).toBe(false);
        },
        undefined,
        {
          reserve: () => ({
            spawned: ({ pid }) => {
              anchorPid = pid;
              cleanupPids.add(pid);
            },
            settled: () => {
              settled = true;
            },
          }),
        },
      );
      expect(settled).toBe(true);
      expect(isProcessAlive(backgroundPid)).toBe(false);
      expect(isProcessAlive(anchorPid)).toBe(false);
    },
  );

  it("does not resolve cancellation while a SIGTERM-resistant descendant is alive", async ({
    signal,
  }) => {
    const readyPath = join(tempDirs.make("openclaw-exec-tree-"), "ready.json");
    const descendantScript = [
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parentScript = [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: "ignore", windowsHide: true });`,
      `child.once("spawn", () => fs.writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ parentPid: process.pid, childPid: child.pid })));`,
      "child.once('error', () => process.exit(1));",
      "setInterval(() => {}, 1000);",
    ].join("\n");

    const controller = new AbortController();
    const resultPromise = execCommand(process.execPath, ["-e", parentScript], process.cwd(), {
      signal: controller.signal,
    });
    const { parentPid, childPid } = await vi.waitFor(
      () =>
        JSON.parse(readFileSync(readyPath, "utf8")) as {
          parentPid: number;
          childPid: number;
        },
      { timeout: 3_000, interval: 25 },
    );
    cleanupPids.add(parentPid);
    cleanupPids.add(childPid);
    controller.abort();

    await expect(resultPromise).resolves.toMatchObject({ killed: true });
    // The product joins its termination controller, but foreign descendants expose no
    // child handle here; observe final OS extinction without another wall-clock budget.
    while (isProcessAlive(parentPid) || isProcessAlive(childPid)) {
      await delay(10, undefined, { signal }).catch((error: unknown) => {
        throw new Error("Timed out waiting for parent and descendant to exit", { cause: error });
      });
    }
    expect(isProcessAlive(parentPid)).toBe(false);
    expect(isProcessAlive(childPid)).toBe(false);
  }, 12_000);
});
