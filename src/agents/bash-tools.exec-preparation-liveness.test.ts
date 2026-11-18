import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { createDiagnosticToolExecutionLiveness } from "../infra/diagnostic-tool-execution-liveness.js";
import * as childAdapter from "../process/supervisor/adapters/child.js";
import * as processSupervisor from "../process/supervisor/index.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import { createSessionControllerWatchdog } from "../sessions/session-controller.watchdog.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetProcessRegistryForTests();
});

it.each([1800, 0, null])(
  "preserves the exec preparation allowance for timeout %s",
  async (timeoutSec) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(10);
    // Keep the supervisor monotonic clock on the same virtual timeline.
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    const supervisor = createProcessSupervisor();
    vi.spyOn(processSupervisor, "getProcessSupervisor").mockReturnValue(supervisor);
    const completed = createDeferredCore<{ code: number | null; signal: NodeJS.Signals | null }>();
    const kill = vi.fn((signal?: NodeJS.Signals) =>
      completed.resolve({ code: null, signal: signal ?? "SIGTERM" }),
    );
    const adapter: Awaited<ReturnType<typeof childAdapter.createChildAdapter>>["adapter"] = {
      supportsRawOutput: true,
      onStdout: () => undefined,
      onStderr: () => undefined,
      onExit: () => undefined,
      onError: () => undefined,
      wait: () => completed.promise,
      kill,
      dispose: () => undefined,
    };
    vi.spyOn(childAdapter, "createChildAdapter").mockResolvedValue({
      adapter,
      ready: Promise.resolve(),
    });
    const preparing = createDeferredCore();
    const preparation = createDeferredCore();
    const watchdog = createSessionControllerWatchdog({
      startedAtMs: 10,
      isCurrent: () => true,
      readPhase: () => "active",
      requestStop: () => "settled",
      expireCleanup: () => "settled",
    });
    const attempt = watchdog.attachAttempt({ assertCurrent() {} });
    const liveness = createDiagnosticToolExecutionLiveness(undefined, {
      attempt,
      toolCallId: "prepare",
      toolName: "exec",
    });
    const pending = liveness.run(() =>
      runExecProcess({
        command: "synthetic command",
        workdir: process.cwd(),
        env: {},
        usePty: false,
        warnings: [],
        maxOutput: 1000,
        pendingMaxOutput: 1000,
        notifyOnExit: false,
        timeoutSec,
        sandbox: {
          containerName: "synthetic-sandbox",
          workspaceDir: process.cwd(),
          containerWorkdir: "/workspace",
          buildExecSpec: async () => {
            preparing.resolve();
            await preparation.promise;
            return {
              argv: ["synthetic-child"],
              env: {},
              cwd: process.cwd(),
              stdinMode: "pipe-closed",
            };
          },
        },
      }),
    );
    try {
      await preparing.promise;
      expect(liveness.view.deadlineAtMs).toBe(timeoutSec ? 1_800_010 : undefined);
      expect(watchdog.decide(900_011).action).toBe(timeoutSec ? "warn" : "stop");
      if (timeoutSec) {
        expect(watchdog.decide(2_700_011).action).toBe("stop");
      }
      vi.setSystemTime(1_000_010);
      preparation.resolve();
      const handle = await pending;
      expect(liveness.view.deadlineAtMs).toBe(timeoutSec ? 2_800_010 : undefined);
      if (timeoutSec) {
        expect(watchdog.decide(2_700_011).action).toBe("warn");
        await vi.advanceTimersByTimeAsync(1_800_001);
        expect((await handle.promise).timedOut).toBe(true);
        expect(kill).toHaveBeenCalledWith("SIGTERM");
      } else {
        handle.kill();
        await handle.promise;
      }
    } finally {
      preparation.resolve();
      completed.resolve({ code: null, signal: "SIGTERM" });
      const settled = await pending.catch(() => undefined);
      await settled?.promise;
      liveness.close();
      watchdog.close();
      await supervisor.shutdown();
    }
  },
);
