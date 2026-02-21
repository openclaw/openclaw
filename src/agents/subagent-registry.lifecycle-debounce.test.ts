import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the lifecycle event handler registered by ensureListener().
let capturedEventHandler: ((evt: unknown) => void) | null = null;

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (req: unknown) => {
    const typed = req as { method?: string };
    // Simulate embedded run: agent.wait returns non-terminal status so
    // waitForSubagentCompletion exits early without competing with the
    // lifecycle listener path.
    if (typed.method === "agent.wait") {
      return { status: "pending" };
    }
    return {};
  }),
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn((handler: (evt: unknown) => void) => {
    capturedEventHandler = handler;
    return () => {
      capturedEventHandler = null;
    };
  }),
}));

const announceSpy = vi.fn(async (_params: unknown) => true);
vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: (arg: unknown) => announceSpy(arg),
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: vi.fn(() => new Map()),
  saveSubagentRegistryToDisk: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agents: {
      defaults: {
        subagents: { archiveAfterMinutes: 60 },
      },
    },
  })),
}));

vi.mock("./timeout.js", () => ({
  resolveAgentTimeoutMs: vi.fn(() => 60_000),
}));

vi.mock("../utils/delivery-context.js", () => ({
  normalizeDeliveryContext: vi.fn((ctx: unknown) => ctx),
}));

describe("subagent lifecycle debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1000 });
    vi.clearAllMocks();
    capturedEventHandler = null;
  });

  afterEach(async () => {
    // Reset modules first while fake timers are still active so any
    // pending debounce timers are cleared deterministically before
    // switching back to real timers.
    vi.resetModules();
    vi.useRealTimers();
  });

  async function setupAndRegister(overrides?: { runId?: string }) {
    const mod = await import("./subagent-registry.js");
    mod.registerSubagentRun({
      runId: overrides?.runId ?? "run-retry",
      childSessionKey: "agent:main:subagent:test",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "test task",
      cleanup: "keep",
    });
    // Flush microtasks so waitForSubagentCompletion resolves (mocked as pending).
    await vi.advanceTimersByTimeAsync(0);
    return mod;
  }

  it("does not trigger announce immediately on first lifecycle end event", async () => {
    await setupAndRegister();

    // Simulate first attempt's agent_end
    capturedEventHandler?.({
      runId: "run-retry",
      stream: "lifecycle",
      data: { phase: "end", endedAt: 100 },
    });

    // Announce should NOT fire immediately
    await vi.advanceTimersByTimeAsync(0);
    expect(announceSpy).not.toHaveBeenCalled();
  });

  it("triggers announce after debounce when no retry starts", async () => {
    await setupAndRegister();

    // Simulate single attempt ending
    capturedEventHandler?.({
      runId: "run-retry",
      stream: "lifecycle",
      data: { phase: "end", endedAt: 5000 },
    });

    // Advance past debounce window (3 seconds)
    await vi.advanceTimersByTimeAsync(3_500);

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const params = announceSpy.mock.calls[0]?.[0] as { endedAt?: number };
    expect(params.endedAt).toBe(5000);
  });

  it("cancels pending announce when retry starts and announces with final data", async () => {
    await setupAndRegister();

    // First attempt ends (error at API level, but lifecycle phase is "end")
    capturedEventHandler?.({
      runId: "run-retry",
      stream: "lifecycle",
      data: { phase: "end", endedAt: 100 },
    });

    // Advance 1 second (within debounce window)
    await vi.advanceTimersByTimeAsync(1_000);
    expect(announceSpy).not.toHaveBeenCalled();

    // Retry starts — should cancel the pending timer
    capturedEventHandler?.({
      runId: "run-retry",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 200 },
    });

    // Retry completes with real output
    capturedEventHandler?.({
      runId: "run-retry",
      stream: "lifecycle",
      data: { phase: "end", endedAt: 60_000 },
    });

    // Still within new debounce window
    await vi.advanceTimersByTimeAsync(1_000);
    expect(announceSpy).not.toHaveBeenCalled();

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(3_000);

    // NOW announce should fire with the RETRY's data
    expect(announceSpy).toHaveBeenCalledTimes(1);
    const params = announceSpy.mock.calls[0]?.[0] as {
      endedAt?: number;
      outcome?: { status: string };
    };
    expect(params.endedAt).toBe(60_000);
    expect(params.outcome?.status).toBe("ok");
  });

  it("preserves original startedAt across retry phase start events", async () => {
    await setupAndRegister();

    // The registration sets startedAt = Date.now() (1000 with these fake timers).
    // First attempt start (should NOT overwrite the registration startedAt)
    capturedEventHandler?.({
      runId: "run-retry",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 500 },
    });

    // First attempt end
    capturedEventHandler?.({
      runId: "run-retry",
      stream: "lifecycle",
      data: { phase: "end", endedAt: 1000 },
    });

    // Retry start (should NOT overwrite startedAt)
    capturedEventHandler?.({
      runId: "run-retry",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 2000 },
    });

    // Retry end
    capturedEventHandler?.({
      runId: "run-retry",
      stream: "lifecycle",
      data: { phase: "end", endedAt: 30_000 },
    });

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(3_500);

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const params = announceSpy.mock.calls[0]?.[0] as { startedAt?: number };
    // startedAt should be the original registration time (1000), not overwritten
    // by subsequent lifecycle start events (500 or 2000).
    expect(params.startedAt).toBe(1000);
  });

  it("triggers immediately on run-level phase error without debounce", async () => {
    await setupAndRegister();

    // Simulate run-level error (emitted from agent-runner-execution.ts catch)
    capturedEventHandler?.({
      runId: "run-retry",
      stream: "lifecycle",
      data: { phase: "error", endedAt: 500, error: "run failed" },
    });

    // Should trigger immediately without waiting for debounce
    await vi.advanceTimersByTimeAsync(0);
    expect(announceSpy).toHaveBeenCalledTimes(1);
    const params = announceSpy.mock.calls[0]?.[0] as {
      outcome?: { status: string; error?: string };
    };
    expect(params.outcome?.status).toBe("error");
    expect(params.outcome?.error).toBe("run failed");
  });

  it("announce fires only once even with multiple rapid end events", async () => {
    await setupAndRegister();

    // Multiple rapid end events (e.g., both lifecycle listener and agent.wait)
    capturedEventHandler?.({
      runId: "run-retry",
      stream: "lifecycle",
      data: { phase: "end", endedAt: 1000 },
    });
    capturedEventHandler?.({
      runId: "run-retry",
      stream: "lifecycle",
      data: { phase: "end", endedAt: 2000 },
    });

    await vi.advanceTimersByTimeAsync(3_500);

    // Only one announce call (beginSubagentCleanup guard prevents second)
    expect(announceSpy).toHaveBeenCalledTimes(1);
    // Uses the latest endedAt
    const params = announceSpy.mock.calls[0]?.[0] as { endedAt?: number };
    expect(params.endedAt).toBe(2000);
  });
});
