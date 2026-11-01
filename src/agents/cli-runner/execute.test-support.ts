import { beforeEach, vi } from "vitest";
import * as sessionEventHandoff from "../../auto-reply/reply/session-event-handoff.js";
import * as processSupervisor from "../../process/supervisor/index.js";
import type { ProcessSupervisor, RunExit } from "../../process/supervisor/types.js";
import { withTestRunAdmission } from "../admitted-run-context.test-support.js";
import { createRunExit } from "../bash-tools.exec-runtime.test-support.js";
import type { PreparedCliRunContext } from "./types.js";

/** Encloses a logical test run, including retries, in the admission preparation normally owns. */
export function wrapPreparedCliRunWithTestAdmission<Args extends unknown[], T>(
  run: (context: PreparedCliRunContext, ...args: Args) => Promise<T>,
): (context: PreparedCliRunContext, ...args: Args) => Promise<T> {
  return async (context, ...args) => {
    const original = context.params.admittedRunContext;
    return await withTestRunAdmission(context.params, async (admitted) => {
      context.params.admittedRunContext = admitted;
      try {
        return await run(context, ...args);
      } finally {
        context.params.admittedRunContext = original;
      }
    });
  };
}

export const supervisorSpawnMock = vi.fn<ProcessSupervisor["spawn"]>();
export const enqueueSessionEventMock = vi.fn<typeof sessionEventHandoff.enqueueSessionEventForHost>(
  () => ({
    id: "cli-watchdog-event",
    accepted: Promise.resolve({ ok: true }),
    cancel: () => true,
    settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
  }),
);

beforeEach(({ onTestFinished }) => {
  const spies = [
    vi.spyOn(processSupervisor, "getProcessSupervisor").mockImplementation(() => {
      const activeRuns = new Map<string, Awaited<ReturnType<ProcessSupervisor["spawn"]>>>();
      return {
        acquireScopeCleanup: vi.fn(() => {
          throw new Error("CLI execution fixture does not own a cleanup scope");
        }),
        spawn: async (params: Parameters<ProcessSupervisor["spawn"]>[0]) => {
          const pending = { stdout: params.onStdout, stderr: params.onStderr };
          const forward = (stream: keyof typeof pending) => {
            const callback = pending[stream];
            return (
              callback &&
              ((chunk: string) => {
                pending[stream] = undefined;
                callback(chunk);
              })
            );
          };
          const managedRun = await supervisorSpawnMock({
            ...params,
            ...(params.mode === "child" && params.resolveArgs
              ? { argv: [...params.argv, ...params.resolveArgs()] }
              : {}),
            onStdout: forward("stdout"),
            onStderr: forward("stderr"),
          });
          if (!managedRun) {
            throw new Error("supervisorSpawnMock returned no managed run (consumed or reset mock)");
          }
          activeRuns.set(params.runId ?? managedRun.runId, managedRun);
          const wait = managedRun.wait;
          return {
            ...managedRun,
            wait: async () => {
              const exit = await wait();
              if (params.captureOutput === false) {
                for (const stream of ["stdout", "stderr"] as const) {
                  if (exit[stream]) {
                    pending[stream]?.(exit[stream]);
                  }
                }
              }
              return exit;
            },
          };
        },
        cancel: vi.fn((runId: string, reason?: Parameters<ProcessSupervisor["cancel"]>[1]) => {
          activeRuns.get(runId)?.cancel(reason);
        }),
        cancelScope: vi.fn(),
      };
    }),
    vi
      .spyOn(sessionEventHandoff, "captureSessionEventTargetForHost")
      .mockImplementation(async (agentId, sessionKey) => ({
        agentId,
        sessionKey,
        sessionId: sessionKey,
        generation: "test",
      })),
    vi
      .spyOn(sessionEventHandoff, "enqueueSessionEventForHost")
      .mockImplementation(enqueueSessionEventMock),
  ];
  onTestFinished(() => spies.forEach((spy) => spy.mockRestore()));
});

type MockRunExit = Omit<RunExit, "oomScoreWrapperSelected">;

export function createManagedRun(exit: MockRunExit, pid = 1234) {
  return {
    activity: { resultSettled: true, lastOutputAtMs: Date.now() },
    runId: "run-supervisor",
    pid,
    startedAtMs: Date.now(),
    stdin: undefined,
    wait: vi.fn<() => Promise<MockRunExit>>().mockResolvedValue(exit),
    cancel: vi.fn<() => void>(),
  } satisfies Awaited<ReturnType<ProcessSupervisor["spawn"]>>;
}

export function createSuccessfulProcessExit(): MockRunExit {
  return createRunExit({ durationMs: 50 });
}
