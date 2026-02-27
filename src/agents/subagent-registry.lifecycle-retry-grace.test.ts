import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  callGateway: vi.fn(async (request: unknown) => {
    const method = (request as { method?: string }).method;
    if (method === "agent.wait") {
      // Keep wait unresolved from the RPC path so lifecycle fallback logic is exercised.
      return { status: "pending" };
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

const announceSpy = vi.fn(async () => true);
vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: announceSpy,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: vi.fn(() => new Map()),
  saveSubagentRegistryToDisk: vi.fn(() => {}),
}));

describe("subagent registry lifecycle error grace", () => {
  let mod: typeof import("./subagent-registry.js");

  beforeAll(async () => {
    mod = await import("./subagent-registry.js");
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    announceSpy.mockClear();
    lifecycleHandler = undefined;
    mod.resetSubagentRegistryForTests({ persist: false });
    vi.useRealTimers();
  });

  const flushAsync = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  it("ignores transient lifecycle errors when run retries and then ends successfully", async () => {
    mod.registerSubagentRun({
      runId: "run-transient-error",
      childSessionKey: "agent:main:subagent:transient-error",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "transient error test",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });

    lifecycleHandler?.({
      stream: "lifecycle",
      runId: "run-transient-error",
      data: { phase: "error", error: "rate limit", endedAt: 1_000 },
    });
    await flushAsync();
    expect(announceSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(14_999);
    expect(announceSpy).not.toHaveBeenCalled();

    lifecycleHandler?.({
      stream: "lifecycle",
      runId: "run-transient-error",
      data: { phase: "start", startedAt: 1_050 },
    });
    await flushAsync();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(announceSpy).not.toHaveBeenCalled();

    lifecycleHandler?.({
      stream: "lifecycle",
      runId: "run-transient-error",
      data: { phase: "end", endedAt: 1_250 },
    });
    await flushAsync();

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const announceCalls = announceSpy.mock.calls as unknown as Array<Array<unknown>>;
    const first = (announceCalls[0]?.[0] ?? {}) as {
      outcome?: { status?: string; error?: string };
    };
    expect(first.outcome?.status).toBe("ok");
  });

  it("announces error when lifecycle error remains terminal after grace window", async () => {
    mod.registerSubagentRun({
      runId: "run-terminal-error",
      childSessionKey: "agent:main:subagent:terminal-error",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "terminal error test",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });

    lifecycleHandler?.({
      stream: "lifecycle",
      runId: "run-terminal-error",
      data: { phase: "error", error: "fatal failure", endedAt: 2_000 },
    });
    await flushAsync();
    expect(announceSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15_000);
    await flushAsync();

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const announceCalls = announceSpy.mock.calls as unknown as Array<Array<unknown>>;
    const first = (announceCalls[0]?.[0] ?? {}) as {
      outcome?: { status?: string; error?: string };
    };
    expect(first.outcome?.status).toBe("error");
    expect(first.outcome?.error).toBe("fatal failure");
  });
});
