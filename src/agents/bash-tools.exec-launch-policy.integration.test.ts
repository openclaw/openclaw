import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runClaudeCliNodeCommand } from "../node-host/invoke-agent-cli-claude.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import type { ProcessSupervisor } from "../process/supervisor/types.js";
import { createAgentToolExecutionBudget } from "./agent-tool-source-execution-guard.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { runExecFixture } from "./bash-tools.exec-fixture.test-support.js";

const boundary = vi.hoisted(() => ({
  supervisor: undefined as ProcessSupervisor | undefined,
  before: () => {},
  after: () => {},
  nativeLaunches: 0,
  retainedLaunchAttempted: false,
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function trackLaunch<Args extends unknown[], Result>(launch: (...args: Args) => Promise<Result>) {
  return async (...args: Args) => {
    boundary.before();
    const result = await launch(...args);
    boundary.nativeLaunches += 1;
    boundary.after();
    return result;
  };
}

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => boundary.supervisor,
}));
vi.mock("../process/spawn-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../process/spawn-utils.js")>();
  return { ...actual, spawnAndWait: trackLaunch(actual.spawnAndWait) };
});
vi.mock("../process/terminal-pty.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../process/terminal-pty.js")>();
  return { ...actual, spawnTerminalPty: trackLaunch(actual.spawnTerminalPty) };
});
vi.mock("../process/spawn-broker/relay-integration.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../process/spawn-broker/relay-integration.js")>();
  return {
    ...actual,
    createServiceChildControlSender: (
      ...params: Parameters<typeof actual.createServiceChildControlSender>
    ) => {
      const send = actual.createServiceChildControlSender(...params);
      const launch = trackLaunch(send);
      return (...args: Parameters<typeof send>) => {
        if (args[0].type !== "launch") {
          return send(...args);
        }
        boundary.retainedLaunchAttempted = true;
        return launch(...args);
      };
    },
  };
});

describe.runIf(process.platform !== "win32")("launch policy and construction authority", () => {
  let root: string;
  let supervisor: ReturnType<typeof createProcessSupervisor>;
  const exec = (command: string, usePty: boolean, assertCurrent?: () => void) =>
    runExecFixture({
      command,
      execCommand: command,
      workdir: root,
      env: { PATH: "/usr/bin:/bin", HOME: root },
      usePty,
      timeoutSec: 10,
      assertCurrent,
    });
  beforeEach(() => {
    root = tempDirs.make("exec-launch-policy-");
    supervisor = createProcessSupervisor();
    boundary.supervisor = supervisor;
    boundary.before = () => {};
    boundary.after = () => {};
    boundary.nativeLaunches = 0;
    boundary.retainedLaunchAttempted = false;
    vi.stubEnv("OPENCLAW_SERVICE_MARKER", "");
    vi.stubEnv("OPENCLAW_EXEC_SHELL_SNAPSHOT", "0");
    vi.stubEnv("SHELL", "/bin/bash");
  });
  afterEach(async () => {
    try {
      // A refusal before native launch must not leave cleanup uncertified at close.
      await supervisor.shutdown();
    } finally {
      resetProcessRegistryForTests();
      vi.unstubAllEnvs();
    }
  });

  const routes = ["Gateway child", "Gateway retained child", "Gateway PTY", "Claude node"];
  it.each(
    routes.flatMap((route) =>
      (["before", "after"] as const).map((timing) => [route, timing] as const),
    ),
  )("applies %s policy revocation %s native launch", async (route, timing) => {
    if (route === "Gateway retained child") {
      vi.stubEnv("OPENCLAW_SERVICE_MARKER", "launch-policy-fixture");
    }
    let allowed = true;
    boundary[timing] = () => {
      allowed = false;
    };
    const assertCurrent = () => {
      if (!allowed) {
        throw new Error("exec approval changed before execution");
      }
    };
    const marker = path.join(root, "completed");
    const script = path.join(root, "command.cjs");
    fs.writeFileSync(
      script,
      'require("node:fs").writeFileSync("completed", "yes"); process.stdout.write("completed\\n");',
    );
    const env = { PATH: "/usr/bin:/bin", HOME: root };
    if (route === "Claude node") {
      let progress = "";
      const result = await runClaudeCliNodeCommand({
        client: {
          request: async <T>(method: string, params?: unknown) => {
            if (method === "node.invoke.progress") {
              progress += (params as { chunk: string }).chunk;
            }
            return {} as T;
          },
        },
        frame: { id: "launch-policy", nodeId: "fixture", command: "agent.cli.claude.run.v1" },
        request: { argv: ["-p"], idleTimeoutMs: 5_000, timeoutMs: 10_000 },
        argv: [process.execPath, script],
        cwd: root,
        env,
        timeoutMs: 10_000,
        assertCurrent,
      });
      expect(result.success).toBe(timing === "after");
      expect(progress).toBe(timing === "after" ? "completed\n" : "");
      if (timing === "before") {
        expect(result.error).toContain("exec approval changed before execution");
      }
    } else {
      const command = `'${process.execPath}' '${script}'`;
      const pending = exec(command, route === "Gateway PTY", assertCurrent);
      if (timing === "before") {
        await expect(pending).rejects.toThrow(/^exec approval changed before execution$/);
        if (route === "Gateway retained child") {
          // The retained relay refuses at its launch frame; its anchor's startup-error
          // receipt certifies cleanup, so the shutdown join in afterEach stays clean.
          // Other routes reach the relay only where the host owns their process tree.
          expect(boundary.retainedLaunchAttempted).toBe(true);
        }
      } else {
        const handle = await pending;
        const result = await handle.promise;
        expect(result.status).toBe("completed");
        expect(result.aggregated.trim()).toBe("completed");
      }
    }
    expect(boundary.nativeLaunches).toBe(timing === "after" ? 1 : 0);
    expect(fs.existsSync(marker)).toBe(timing === "after");
  });

  it.each([
    { usePty: false, retained: false },
    { usePty: false, retained: true },
    { usePty: true, retained: false },
  ])(
    "still rejects retired source authority after native launch (PTY=$usePty, retained=$retained)",
    async ({ usePty, retained }) => {
      if (retained) {
        vi.stubEnv("OPENCLAW_SERVICE_MARKER", "launch-policy-fixture");
      }
      let current = true;
      boundary.after = () => {
        current = false;
      };
      const controller = new AbortController();
      const budget = createAgentToolExecutionBudget({
        signal: controller.signal,
        abort: (error) => controller.abort(error),
        isCurrent: () => current,
      });
      await expect(budget.run(() => exec("/bin/cat", usePty))).rejects.toThrow(
        "execution scope is no longer active",
      );
      expect(boundary.nativeLaunches).toBe(1);
    },
  );
});
