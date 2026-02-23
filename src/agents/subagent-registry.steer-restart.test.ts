import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const noop = () => {};
let lifecycleHandler:
  | ((evt: {
      stream?: string;
      runId: string;
      data?: {
        phase?: string;
        startedAt?: number;
        endedAt?: number;
        aborted?: boolean;
        error?: string;
      };
    }) => void)
  | undefined;

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (opts: unknown) => {
    const request = opts as { method?: string };
    if (request.method === "agent.wait") {
      return { status: "timeout" };
    }
    return {};
  }),
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn((handler: typeof lifecycleHandler) => {
    lifecycleHandler = handler;
    return noop;
  }),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
  })),
}));

const announceSpy = vi.fn(async (_params: unknown) => true);
const runSubagentEndedHookMock = vi.fn(async (_event?: unknown, _ctx?: unknown) => {});
vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: announceSpy,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => ({
    hasHooks: (hookName: string) => hookName === "subagent_ended",
    runSubagentEnded: runSubagentEndedHookMock,
  })),
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: vi.fn(() => new Map()),
  saveSubagentRegistryToDisk: vi.fn(() => {}),
}));

describe("subagent registry steer restarts", () => {
  let mod: typeof import("./subagent-registry.js");
  type RegisterSubagentRunInput = Parameters<typeof mod.registerSubagentRun>[0];

  beforeAll(async () => {
    mod = await import("./subagent-registry.js");
  });

  const flushAnnounce = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  const withPendingAgentWait = async <T>(run: () => Promise<T>): Promise<T> => {
    const callGateway = vi.mocked((await import("../gateway/call.js")).callGateway);
    const originalCallGateway = callGateway.getMockImplementation();
    callGateway.mockImplementation(async (request: unknown) => {
      const typed = request as { method?: string };
      if (typed.method === "agent.wait") {
        return new Promise<unknown>(() => undefined);
      }
      if (originalCallGateway) {
        return originalCallGateway(request as Parameters<typeof callGateway>[0]);
      }
      return {};
    });

    try {
      return await run();
    } finally {
      if (originalCallGateway) {
        callGateway.mockImplementation(originalCallGateway);
      }
    }
  };

  const createDeferredAnnounceResolver = (): ((value: boolean) => void) => {
    let resolveAnnounce!: (value: boolean) => void;
    announceSpy.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveAnnounce = resolve;
        }),
    );
    return (value: boolean) => {
      resolveAnnounce(value);
    };
  };

  const registerCompletionModeRun = (
    runId: string,
    childSessionKey: string,
    task: string,
    options: Partial<Pick<RegisterSubagentRunInput, "spawnMode">> = {},
  ): void => {
    mod.registerSubagentRun({
      runId,
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: {
        channel: "discord",
        to: "channel:123",
        accountId: "work",
      },
      task,
      cleanup: "keep",
      expectsCompletionMessage: true,
      ...options,
    });
  };

  afterEach(async () => {
    announceSpy.mockClear();
    announceSpy.mockResolvedValue(true);
    runSubagentEndedHookMock.mockClear();
    lifecycleHandler = undefined;
    mod.resetSubagentRegistryForTests({ persist: false });
  });

  it("suppresses announce for interrupted runs and only announces the replacement run", async () => {
    mod.registerSubagentRun({
      runId: "run-old",
      childSessionKey: "agent:main:subagent:steer",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "initial task",
      cleanup: "keep",
    });

    const previous = mod.listSubagentRunsForRequester("agent:main:main")[0];
    expect(previous?.runId).toBe("run-old");

    const marked = mod.markSubagentRunForSteerRestart("run-old");
    expect(marked).toBe(true);

    lifecycleHandler?.({
      stream: "lifecycle",
      runId: "run-old",
      data: { phase: "end" },
    });

    await flushAnnounce();
    expect(announceSpy).not.toHaveBeenCalled();
    expect(runSubagentEndedHookMock).not.toHaveBeenCalled();

    const replaced = mod.replaceSubagentRunAfterSteer({
      previousRunId: "run-old",
      nextRunId: "run-new",
      fallback: previous,
    });
    expect(replaced).toBe(true);

    const runs = mod.listSubagentRunsForRequester("agent:main:main");
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe("run-new");

    lifecycleHandler?.({
      stream: "lifecycle",
      runId: "run-new",
      data: { phase: "end" },
    });

    await flushAnnounce();
    expect(announceSpy).toHaveBeenCalledTimes(1);
    expect(runSubagentEndedHookMock).toHaveBeenCalledTimes(1);
    expect(runSubagentEndedHookMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-new",
      }),
      expect.objectContaining({
        runId: "run-new",
      }),
    );

    const announce = (announceSpy.mock.calls[0]?.[0] ?? {}) as { childRunId?: string };
    expect(announce.childRunId).toBe("run-new");
  });

  it("defers subagent_ended hook for completion-mode runs until announce delivery resolves", async () => {
    await withPendingAgentWait(async () => {
      const resolveAnnounce = createDeferredAnnounceResolver();
      registerCompletionModeRun(
        "run-completion-delayed",
        "agent:main:subagent:completion-delayed",
        "completion-mode task",
      );

      lifecycleHandler?.({
        stream: "lifecycle",
        runId: "run-completion-delayed",
        data: { phase: "end" },
      });

      await flushAnnounce();
      expect(runSubagentEndedHookMock).not.toHaveBeenCalled();

      resolveAnnounce(true);
      await flushAnnounce();

      expect(runSubagentEndedHookMock).toHaveBeenCalledTimes(1);
      expect(runSubagentEndedHookMock).toHaveBeenCalledWith(
        expect.objectContaining({
          targetSessionKey: "agent:main:subagent:completion-delayed",
          reason: "subagent-complete",
          sendFarewell: true,
        }),
        expect.objectContaining({
          runId: "run-completion-delayed",
          requesterSessionKey: "agent:main:main",
        }),
      );
    });
  });

  it("does not emit subagent_ended on completion for persistent session-mode runs", async () => {
    await withPendingAgentWait(async () => {
      const resolveAnnounce = createDeferredAnnounceResolver();
      registerCompletionModeRun(
        "run-persistent-session",
        "agent:main:subagent:persistent-session",
        "persistent session task",
        { spawnMode: "session" },
      );

      lifecycleHandler?.({
        stream: "lifecycle",
        runId: "run-persistent-session",
        data: { phase: "end" },
      });

      await flushAnnounce();
      expect(runSubagentEndedHookMock).not.toHaveBeenCalled();

      resolveAnnounce(true);
      await flushAnnounce();

      expect(runSubagentEndedHookMock).not.toHaveBeenCalled();
      const run = mod.listSubagentRunsForRequester("agent:main:main")[0];
      expect(run?.runId).toBe("run-persistent-session");
      expect(run?.cleanupCompletedAt).toBeTypeOf("number");
      expect(run?.endedHookEmittedAt).toBeUndefined();
    });
  });

  it("clears announce retry state when replacing after steer restart", () => {
    mod.registerSubagentRun({
      runId: "run-retry-reset-old",
      childSessionKey: "agent:main:subagent:retry-reset",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "retry reset",
      cleanup: "keep",
    });

    const previous = mod.listSubagentRunsForRequester("agent:main:main")[0];
    expect(previous?.runId).toBe("run-retry-reset-old");
    if (previous) {
      previous.announceRetryCount = 2;
      previous.lastAnnounceRetryAt = Date.now();
    }

    const replaced = mod.replaceSubagentRunAfterSteer({
      previousRunId: "run-retry-reset-old",
      nextRunId: "run-retry-reset-new",
      fallback: previous,
    });
    expect(replaced).toBe(true);

    const runs = mod.listSubagentRunsForRequester("agent:main:main");
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe("run-retry-reset-new");
    expect(runs[0].announceRetryCount).toBeUndefined();
    expect(runs[0].lastAnnounceRetryAt).toBeUndefined();
  });

  it("clears terminal lifecycle state when replacing after steer restart", async () => {
    mod.registerSubagentRun({
      runId: "run-terminal-state-old",
      childSessionKey: "agent:main:subagent:terminal-state",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "terminal state",
      cleanup: "keep",
    });

    const previous = mod.listSubagentRunsForRequester("agent:main:main")[0];
    expect(previous?.runId).toBe("run-terminal-state-old");
    if (previous) {
      previous.endedHookEmittedAt = Date.now();
      previous.endedReason = "subagent-complete";
      previous.endedAt = Date.now();
      previous.outcome = { status: "ok" };
    }

    const replaced = mod.replaceSubagentRunAfterSteer({
      previousRunId: "run-terminal-state-old",
      nextRunId: "run-terminal-state-new",
      fallback: previous,
    });
    expect(replaced).toBe(true);

    const runs = mod.listSubagentRunsForRequester("agent:main:main");
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe("run-terminal-state-new");
    expect(runs[0].endedHookEmittedAt).toBeUndefined();
    expect(runs[0].endedReason).toBeUndefined();

    lifecycleHandler?.({
      stream: "lifecycle",
      runId: "run-terminal-state-new",
      data: { phase: "end" },
    });

    await flushAnnounce();
    expect(runSubagentEndedHookMock).toHaveBeenCalledTimes(1);
    expect(runSubagentEndedHookMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-terminal-state-new",
      }),
      expect.objectContaining({
        runId: "run-terminal-state-new",
      }),
    );
  });

  it("restores announce for a finished run when steer replacement dispatch fails", async () => {
    mod.registerSubagentRun({
      runId: "run-failed-restart",
      childSessionKey: "agent:main:subagent:failed-restart",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "initial task",
      cleanup: "keep",
    });

    expect(mod.markSubagentRunForSteerRestart("run-failed-restart")).toBe(true);

    lifecycleHandler?.({
      stream: "lifecycle",
      runId: "run-failed-restart",
      data: { phase: "end" },
    });

    await flushAnnounce();
    expect(announceSpy).not.toHaveBeenCalled();

    expect(mod.clearSubagentRunSteerRestart("run-failed-restart")).toBe(true);
    await flushAnnounce();

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const announce = (announceSpy.mock.calls[0]?.[0] ?? {}) as { childRunId?: string };
    expect(announce.childRunId).toBe("run-failed-restart");
  });

  it("marks killed runs terminated and inactive", async () => {
    const childSessionKey = "agent:main:subagent:killed";

    mod.registerSubagentRun({
      runId: "run-killed",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "kill me",
      cleanup: "keep",
    });

    expect(mod.isSubagentSessionRunActive(childSessionKey)).toBe(true);
    const updated = mod.markSubagentRunTerminated({
      childSessionKey,
      reason: "manual kill",
    });
    expect(updated).toBe(1);
    expect(mod.isSubagentSessionRunActive(childSessionKey)).toBe(false);

    const run = mod.listSubagentRunsForRequester("agent:main:main")[0];
    expect(run?.outcome).toEqual({ status: "error", error: "manual kill" });
    expect(run?.cleanupHandled).toBe(true);
    expect(typeof run?.cleanupCompletedAt).toBe("number");
    expect(runSubagentEndedHookMock).toHaveBeenCalledWith(
      {
        targetSessionKey: childSessionKey,
        targetKind: "subagent",
        reason: "subagent-killed",
        sendFarewell: true,
        accountId: undefined,
        runId: "run-killed",
        endedAt: expect.any(Number),
        outcome: "killed",
        error: "manual kill",
      },
      {
        runId: "run-killed",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
      },
    );
  });

  it("retries deferred parent cleanup after a descendant announces", async () => {
    let parentAttempts = 0;
    announceSpy.mockImplementation(async (params: unknown) => {
      const typed = params as { childRunId?: string };
      if (typed.childRunId === "run-parent") {
        parentAttempts += 1;
        return parentAttempts >= 2;
      }
      return true;
    });

    mod.registerSubagentRun({
      runId: "run-parent",
      childSessionKey: "agent:main:subagent:parent",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "parent task",
      cleanup: "keep",
    });
    mod.registerSubagentRun({
      runId: "run-child",
      childSessionKey: "agent:main:subagent:parent:subagent:child",
      requesterSessionKey: "agent:main:subagent:parent",
      requesterDisplayKey: "parent",
      task: "child task",
      cleanup: "keep",
    });

    lifecycleHandler?.({
      stream: "lifecycle",
      runId: "run-parent",
      data: { phase: "end" },
    });
    await flushAnnounce();

    lifecycleHandler?.({
      stream: "lifecycle",
      runId: "run-child",
      data: { phase: "end" },
    });
    await flushAnnounce();

    const childRunIds = announceSpy.mock.calls.map(
      (call) => ((call[0] ?? {}) as { childRunId?: string }).childRunId,
    );
    expect(childRunIds.filter((id) => id === "run-parent")).toHaveLength(2);
    expect(childRunIds.filter((id) => id === "run-child")).toHaveLength(1);
  });

  it("retries completion-mode announce delivery with backoff and then gives up after retry limit", async () => {
    await withPendingAgentWait(async () => {
      vi.useFakeTimers();
      try {
        announceSpy.mockResolvedValue(false);

        mod.registerSubagentRun({
          runId: "run-completion-retry",
          childSessionKey: "agent:main:subagent:completion",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "completion retry",
          cleanup: "keep",
          expectsCompletionMessage: true,
        });

        lifecycleHandler?.({
          stream: "lifecycle",
          runId: "run-completion-retry",
          data: { phase: "end" },
        });

        await vi.advanceTimersByTimeAsync(0);
        expect(announceSpy).toHaveBeenCalledTimes(1);
        expect(mod.listSubagentRunsForRequester("agent:main:main")[0]?.announceRetryCount).toBe(1);

        await vi.advanceTimersByTimeAsync(999);
        expect(announceSpy).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(announceSpy).toHaveBeenCalledTimes(2);
        expect(mod.listSubagentRunsForRequester("agent:main:main")[0]?.announceRetryCount).toBe(2);

        await vi.advanceTimersByTimeAsync(1_999);
        expect(announceSpy).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(announceSpy).toHaveBeenCalledTimes(3);
        expect(mod.listSubagentRunsForRequester("agent:main:main")[0]?.announceRetryCount).toBe(3);

        await vi.advanceTimersByTimeAsync(4_001);
        expect(announceSpy).toHaveBeenCalledTimes(3);
        expect(
          mod.listSubagentRunsForRequester("agent:main:main")[0]?.cleanupCompletedAt,
        ).toBeTypeOf("number");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("emits subagent_ended when completion cleanup expires with active descendants", async () => {
    announceSpy.mockResolvedValue(false);

    mod.registerSubagentRun({
      runId: "run-parent-expiry",
      childSessionKey: "agent:main:subagent:parent-expiry",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "parent completion expiry",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });
    mod.registerSubagentRun({
      runId: "run-child-active",
      childSessionKey: "agent:main:subagent:parent-expiry:subagent:child-active",
      requesterSessionKey: "agent:main:subagent:parent-expiry",
      requesterDisplayKey: "parent-expiry",
      task: "child still running",
      cleanup: "keep",
    });

    lifecycleHandler?.({
      stream: "lifecycle",
      runId: "run-parent-expiry",
      data: {
        phase: "end",
        startedAt: Date.now() - 7 * 60_000,
        endedAt: Date.now() - 6 * 60_000,
      },
    });

    await flushAnnounce();

    const parentHookCall = runSubagentEndedHookMock.mock.calls.find((call) => {
      const event = call[0] as { runId?: string; reason?: string };
      return event.runId === "run-parent-expiry" && event.reason === "subagent-complete";
    });
    expect(parentHookCall).toBeDefined();
    const parent = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-parent-expiry");
    expect(parent?.cleanupCompletedAt).toBeTypeOf("number");
  });
});
