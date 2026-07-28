import { afterEach, describe, expect, it, vi } from "vitest";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { isBackgroundExecSessionActive } from "./bash-process-control.js";
import {
  addSession,
  getActiveBackgroundExecSessionCount,
  getSession,
  markBackgrounded,
  markExited,
} from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createProcessTool } from "./bash-tools.process.js";

describe("background exec process control", () => {
  afterEach(() => {
    resetProcessRegistryForTests();
  });

  it("does not report missing, foreground, or exited sessions as active", () => {
    const session = createProcessSessionFixture({ id: "process-control-lifecycle" });

    expect(isBackgroundExecSessionActive(session.id)).toBe(false);

    addSession(session);
    expect(isBackgroundExecSessionActive(session.id)).toBe(false);

    markBackgrounded(session);
    expect(isBackgroundExecSessionActive(session.id)).toBe(true);

    markExited(session, 0, null, "completed");
    expect(isBackgroundExecSessionActive(session.id)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "keeps a removed supervised child active until its real SIGTERM exit",
    async () => {
      const sessionId = "process-control-live-sigterm";
      const supervisor = getProcessSupervisor();
      let output = "";
      const run = await supervisor.spawn({
        mode: "child",
        backendId: "process-control-test",
        runId: sessionId,
        sessionId,
        argv: [
          process.execPath,
          "-e",
          [
            'process.on("SIGTERM", () => {',
            '  process.stdout.write("SIGTERM\\n");',
            "});",
            'process.on("SIGUSR1", () => process.exit(0));',
            'process.stdout.write("ready\\n");',
            "setInterval(() => {}, 1_000);",
          ].join("\n"),
        ],
        stdinMode: "pipe-closed",
        timeoutMs: 10_000,
        onStdout: (chunk) => {
          output += chunk;
        },
      });
      const session = createProcessSessionFixture({
        id: sessionId,
        command: "controlled SIGTERM child",
        pid: run.pid,
      });
      addSession(session);
      markBackgrounded(session);
      let childReleased = false;
      const releaseChild = () => {
        if (childReleased || run.pid === undefined) {
          return;
        }
        childReleased = true;
        process.kill(run.pid, "SIGUSR1");
      };

      try {
        await vi.waitFor(() => expect(output).toContain("ready\n"), {
          interval: 10,
          timeout: 2_000,
        });
        expect(isBackgroundExecSessionActive(sessionId)).toBe(true);

        const result = await createProcessTool().execute("remove-live-child", {
          action: "remove",
          sessionId,
        });

        expect(result.content).toEqual([
          {
            type: "text",
            text: `Removed session ${sessionId} (termination requested).`,
          },
        ]);
        expect(getSession(sessionId)).toBeUndefined();

        await vi.waitFor(() => expect(output).toContain("SIGTERM\n"), {
          interval: 10,
          timeout: 2_000,
        });
        expect(supervisor.getRecord(sessionId)?.state).toBe("exiting");
        expect(getActiveBackgroundExecSessionCount()).toBe(1);
        expect(isBackgroundExecSessionActive(sessionId)).toBe(true);

        if (run.pid === undefined) {
          throw new Error("supervised child did not expose a process ID");
        }
        releaseChild();

        const exit = await run.wait();
        expect(exit.reason).toBe("manual-cancel");
        expect(exit.exitCode).toBe(0);
        markExited(session, exit.exitCode, exit.exitSignal, "killed", exit.reason);

        expect(isBackgroundExecSessionActive(sessionId)).toBe(false);
        expect(getActiveBackgroundExecSessionCount()).toBe(0);
      } finally {
        releaseChild();
        supervisor.cancel(sessionId, "manual-cancel");
        const exit = await run.wait();
        if (!session.exited) {
          markExited(session, exit.exitCode, exit.exitSignal, "killed", exit.reason);
        }
      }
    },
  );
});
