import { existsSync, readFileSync } from "node:fs";
import { resolvePreferredOpenClawTmpDir, tempWorkspaceSync } from "openclaw/plugin-sdk/temp-path";
import { afterEach, describe, expect, it } from "vitest";
import { ScopeChildReaper } from "./scope-reaper.js";
import { SessionBroker } from "./session-broker.js";

describe.skipIf(process.platform !== "darwin")("real broker command descendant custody", () => {
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
      const { broker } = fixture();
      const result = await broker.exec({
        script: `sleep 60 >/dev/null 2>&1 & echo $!; (exit ${code})`,
      });
      const descendant = Number(result.stdout.toString().trim());
      try {
        expect(result.code).toBe(code);
        await expect.poll(() => alive(descendant), { timeout: 2000 }).toBe(false);
      } finally {
        if (alive(descendant)) {
          process.kill(descendant, "SIGKILL");
        }
      }
    },
  );

  it("enforces timeout even when the guest kills accessible sibling watchers", async () => {
    const { broker, workspace } = fixture();
    const pidFile = workspace.path("pid");
    const result = await broker.exec({
      script: `for p in $(ps -axo pid=,ppid= | awk -v parent="$PPID" '$2 == parent {print $1}'); do if [ "$p" != "$$" ]; then kill -KILL "$p" 2>/dev/null || true; fi; done; if kill -KILL "$PPID" 2>/dev/null; then echo parent-killed; else echo parent-protected; fi; sleep 60 >/dev/null 2>&1 & echo $! > ${JSON.stringify(pidFile)}; wait`,
      timeoutMs: 1500,
    });
    expect(result).toMatchObject({ code: 124, timedOut: true });
    expect(result.stdout.toString()).toContain("parent-protected");
    expect(existsSync(pidFile)).toBe(true);
    const descendant = Number(readFileSync(pidFile, "utf8").trim());
    try {
      await expect.poll(() => alive(descendant), { timeout: 2000 }).toBe(false);
    } finally {
      if (alive(descendant)) {
        process.kill(descendant, "SIGKILL");
      }
    }
  });
});

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
