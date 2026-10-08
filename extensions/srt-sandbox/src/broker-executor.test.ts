import { existsSync, readFileSync } from "node:fs";
import { resolvePreferredOpenClawTmpDir, tempWorkspaceSync } from "openclaw/plugin-sdk/temp-path";
import { afterEach, describe, expect, it } from "vitest";
import { findLinuxProcessByArgv0 } from "./process-proof.test-helpers.js";
import { ScopeChildReaper } from "./scope-reaper.js";
import { SessionBroker } from "./session-broker.js";

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "real broker command descendant custody",
  () => {
    const cleanup: Array<() => void> = [];
    afterEach(() => {
      for (const dispose of cleanup.splice(0).toReversed()) {
        dispose();
      }
    });

    function fixture() {
      const workspace = tempWorkspaceSync({
        rootDir: resolvePreferredOpenClawTmpDir(),
        prefix: "srt-broker-proof-",
      });
      cleanup.push(() => workspace.cleanup());
      const reaper = new ScopeChildReaper();
      cleanup.push(() => reaper.dispose());
      const broker = new SessionBroker({
        reaper,
        writableRoots: [workspace.dir],
        policy: { allowedDomains: [] },
        cwd: workspace.dir,
        binShell: "/bin/bash",
        rpcTimeoutMs: 5000,
      });
      cleanup.push(() => broker.dispose());
      return { broker, workspace };
    }

    it.each([0, 7])(
      "sweeps a redirected background descendant before returning shell exit %i",
      async (code) => {
        const { broker, workspace } = fixture();
        const marker = workspace.path("child");
        const result = await broker.exec({
          script: `bash -c 'exec -a ${JSON.stringify(marker)} sleep 60' >/dev/null 2>&1 & echo $!; (exit ${code})`,
        });
        const descendant = Number(result.stdout.toString().trim());
        try {
          expect(result.code).toBe(code);
          await expect
            .poll(
              () =>
                process.platform === "linux"
                  ? findLinuxProcessByArgv0(marker) !== undefined
                  : alive(descendant),
              { timeout: 2000 },
            )
            .toBe(false);
        } finally {
          const pid = process.platform === "linux" ? findLinuxProcessByArgv0(marker) : descendant;
          if (pid !== undefined && alive(pid)) {
            process.kill(pid, "SIGKILL");
          }
        }
      },
    );

    it("enforces timeout even when the guest kills accessible sibling watchers", async () => {
      const { broker, workspace } = fixture();
      const pidFile = workspace.path("pid");
      const marker = workspace.path("child");
      const result = await broker.exec({
        script: `for p in $(ps -axo pid=,ppid= | awk -v parent="$PPID" '$2 == parent {print $1}'); do if [ "$p" != "$$" ]; then kill -KILL "$p" 2>/dev/null || true; fi; done; if kill -KILL "$PPID" 2>/dev/null; then echo parent-killed; else echo parent-protected; fi; bash -c 'exec -a ${JSON.stringify(marker)} sleep 60' >/dev/null 2>&1 & echo $! > ${JSON.stringify(pidFile)}; wait`,
        timeoutMs: 1500,
      });
      expect(result).toMatchObject({ code: 124, timedOut: true });
      if (process.platform === "darwin") {
        expect(result.stdout.toString()).toContain("parent-protected");
      } else {
        // Linux guest parents are inside the PID namespace; killing them
        // cannot disable the host's enforced timeout and custody owner.
        expect(result.stdout.toString()).toMatch(/parent-(killed|protected)/);
      }
      expect(existsSync(pidFile)).toBe(true);
      const descendant = Number(readFileSync(pidFile, "utf8").trim());
      try {
        await expect
          .poll(
            () =>
              process.platform === "linux"
                ? findLinuxProcessByArgv0(marker) !== undefined
                : alive(descendant),
            { timeout: 2000 },
          )
          .toBe(false);
      } finally {
        const pid = process.platform === "linux" ? findLinuxProcessByArgv0(marker) : descendant;
        if (pid !== undefined && alive(pid)) {
          process.kill(pid, "SIGKILL");
        }
      }
    });
  },
);

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
