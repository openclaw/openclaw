import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const noop = () => {};
let lifecycleHandler:
  | ((evt: { stream?: string; runId: string; data?: { phase?: string } }) => void)
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
vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: announceSpy,
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: vi.fn(() => new Map()),
  saveSubagentRegistryToDisk: vi.fn(() => {}),
}));

describe("subagent registry steer restarts", () => {
  let mod: typeof import("./subagent-registry.js");

  beforeAll(async () => {
    mod = await import("./subagent-registry.js");
  });

  const flushAnnounce = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  afterEach(async () => {
    announceSpy.mockReset();
    announceSpy.mockResolvedValue(true);
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

    const announce = (announceSpy.mock.calls[0]?.[0] ?? {}) as { childRunId?: string };
    expect(announce.childRunId).toBe("run-new");
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
      expect(mod.listSubagentRunsForRequester("agent:main:main")[0]?.cleanupCompletedAt).toBeTypeOf(
        "number",
      );
    } finally {
      if (originalCallGateway) {
        callGateway.mockImplementation(originalCallGateway);
      }
      vi.useRealTimers();
    }
  });
});
