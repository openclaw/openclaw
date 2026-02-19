import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const noop = () => {};

// Capture the lifecycle listener callback so tests can simulate agent events.
let lifecycleListener: ((evt: Record<string, unknown>) => void) | null = null;

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({
    status: "ok",
    startedAt: 1000,
    endedAt: 2000,
  })),
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn((cb: (evt: Record<string, unknown>) => void) => {
    lifecycleListener = cb;
    return noop;
  }),
}));

const announceSpy = vi.fn(async () => true);
vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: (...args: Parameters<typeof announceSpy>) => announceSpy(...args),
}));

const triggerSpy = vi.fn(async () => {});
vi.mock("../hooks/internal-hooks.js", () => ({
  triggerInternalHook: (...args: Parameters<typeof triggerSpy>) => triggerSpy(...args),
  createInternalHookEvent: vi.fn(
    (type: string, action: string, sessionKey: string, context: Record<string, unknown>) => ({
      type,
      action,
      sessionKey,
      context,
      timestamp: new Date(),
      messages: [],
    }),
  ),
}));

describe("subagent:complete hook event", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycleListener = null;
  });

  afterEach(async () => {
    // Clean up registry state between tests.
    const mod = await import("./subagent-registry.js");
    mod.resetSubagentRegistryForTests();
  });

  function makeEntry(overrides?: Record<string, unknown>) {
    return {
      runId: "run-hook-1",
      childSessionKey: "agent:main:subagent:hook-test",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "summarize docs",
      cleanup: "keep" as const,
      label: "doc-summary",
      ...overrides,
    };
  }

  it("fires subagent:complete via lifecycle end event", async () => {
    // Make agent.wait return a non-terminal status so the lifecycle path fires first.
    const callMod = await import("../gateway/call.js");
    (callMod.callGateway as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "pending",
    });

    const mod = await import("./subagent-registry.js");
    mod.registerSubagentRun(makeEntry());

    // Give the async waitForSubagentCompletion a chance to resolve (with "pending").
    await new Promise((r) => setTimeout(r, 0));

    // No hook should have fired yet since agent.wait returned "pending".
    expect(triggerSpy).not.toHaveBeenCalled();

    // Simulate lifecycle end event.
    expect(lifecycleListener).toBeTruthy();
    lifecycleListener!({
      runId: "run-hook-1",
      stream: "lifecycle",
      data: { phase: "end", endedAt: 5000 },
    });

    // Allow fire-and-forget promises to settle.
    await new Promise((r) => setTimeout(r, 0));

    expect(triggerSpy).toHaveBeenCalledTimes(1);
    const event = (triggerSpy.mock.calls[0] as unknown[])[0] as {
      type: string;
      action: string;
      sessionKey: string;
      context: Record<string, unknown>;
    };
    expect(event.type).toBe("subagent");
    expect(event.action).toBe("complete");
    expect(event.sessionKey).toBe("agent:main:main");
    expect(event.context.runId).toBe("run-hook-1");
    expect(event.context.childSessionKey).toBe("agent:main:subagent:hook-test");
    expect(event.context.label).toBe("doc-summary");
    expect(event.context.task).toBe("summarize docs");
    expect((event.context.outcome as { status: string }).status).toBe("ok");
  });

  it("fires subagent:complete via agent.wait path", async () => {
    const mod = await import("./subagent-registry.js");
    mod.registerSubagentRun(makeEntry({ runId: "run-wait-1" }));

    // The agent.wait call is fired on register. Let it resolve.
    await new Promise((r) => setTimeout(r, 0));

    expect(triggerSpy).toHaveBeenCalled();
    const event = (triggerSpy.mock.calls[0] as unknown[])[0] as {
      type: string;
      action: string;
      context: Record<string, unknown>;
    };
    expect(event.type).toBe("subagent");
    expect(event.action).toBe("complete");
    expect(event.context.runId).toBe("run-wait-1");
    expect(event.context.startedAt).toBe(1000);
    expect(event.context.endedAt).toBe(2000);
    expect(event.context.runtimeMs).toBe(1000);
    expect((event.context.outcome as { status: string }).status).toBe("ok");
  });

  it("emits exactly once when both lifecycle and agent.wait resolve", async () => {
    const mod = await import("./subagent-registry.js");
    mod.registerSubagentRun(makeEntry({ runId: "run-dedup-1" }));

    // agent.wait resolves first.
    await new Promise((r) => setTimeout(r, 0));

    const countAfterWait = triggerSpy.mock.calls.length;
    expect(countAfterWait).toBe(1);

    // Now simulate lifecycle end for the SAME runId.
    if (lifecycleListener) {
      lifecycleListener({
        runId: "run-dedup-1",
        stream: "lifecycle",
        data: { phase: "end", endedAt: 9000 },
      });
    }
    await new Promise((r) => setTimeout(r, 0));

    // Should still be exactly 1 call total (dedup guard).
    expect(triggerSpy).toHaveBeenCalledTimes(countAfterWait);
  });

  it("includes error field in outcome for error events", async () => {
    // Make callGateway return an error status.
    const callMod = await import("../gateway/call.js");
    (callMod.callGateway as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "error",
      startedAt: 100,
      endedAt: 200,
      error: "OOM killed",
    });

    const mod = await import("./subagent-registry.js");
    mod.registerSubagentRun(makeEntry({ runId: "run-err-1" }));

    await new Promise((r) => setTimeout(r, 0));

    expect(triggerSpy).toHaveBeenCalled();
    const event = (triggerSpy.mock.calls[0] as unknown[])[0] as {
      context: Record<string, unknown>;
    };
    const outcome = event.context.outcome as { status: string; error?: string };
    expect(outcome.status).toBe("error");
    expect(outcome.error).toBe("OOM killed");
  });

  it("includes error field via lifecycle error event", async () => {
    const mod = await import("./subagent-registry.js");
    mod.registerSubagentRun(makeEntry({ runId: "run-err-lc" }));

    // Let agent.wait settle first without triggering (we'll mock it to not resolve).
    // Actually, agent.wait will resolve immediately with default mock. Clear the hook call.
    await new Promise((r) => setTimeout(r, 0));
    // The dedup guard already fired for this run via agent.wait. Use a fresh run.
    mod.resetSubagentRegistryForTests();
    triggerSpy.mockClear();

    // Use a new entry where agent.wait doesn't resolve successfully.
    const callMod = await import("../gateway/call.js");
    (callMod.callGateway as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "pending",
    });

    mod.registerSubagentRun(makeEntry({ runId: "run-err-lc2" }));
    await new Promise((r) => setTimeout(r, 0));

    // agent.wait returned "pending", so no hook yet.
    expect(triggerSpy).not.toHaveBeenCalled();

    // Simulate lifecycle error event.
    lifecycleListener!({
      runId: "run-err-lc2",
      stream: "lifecycle",
      data: { phase: "error", endedAt: 3000, error: "timeout exceeded" },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(triggerSpy).toHaveBeenCalledTimes(1);
    const event = (triggerSpy.mock.calls[0] as unknown[])[0] as {
      context: Record<string, unknown>;
    };
    const outcome = event.context.outcome as { status: string; error?: string };
    expect(outcome.status).toBe("error");
    expect(outcome.error).toBe("timeout exceeded");
  });

  it("includes all expected payload fields", async () => {
    const mod = await import("./subagent-registry.js");
    mod.registerSubagentRun(makeEntry({ runId: "run-shape-1" }));

    await new Promise((r) => setTimeout(r, 0));

    expect(triggerSpy).toHaveBeenCalled();
    const event = (triggerSpy.mock.calls[0] as unknown[])[0] as {
      type: string;
      action: string;
      sessionKey: string;
      context: Record<string, unknown>;
    };

    // Top-level event fields.
    expect(event.type).toBe("subagent");
    expect(event.action).toBe("complete");
    expect(event.sessionKey).toBe("agent:main:main");

    // Context payload fields.
    const ctx = event.context;
    expect(ctx).toHaveProperty("childSessionKey");
    expect(ctx).toHaveProperty("runId");
    expect(ctx).toHaveProperty("label");
    expect(ctx).toHaveProperty("task");
    expect(ctx).toHaveProperty("outcome");
    expect(ctx).toHaveProperty("startedAt");
    expect(ctx).toHaveProperty("endedAt");
    expect(ctx).toHaveProperty("runtimeMs");

    // Verify types.
    expect(typeof ctx.runId).toBe("string");
    expect(typeof ctx.childSessionKey).toBe("string");
    expect(typeof ctx.startedAt).toBe("number");
    expect(typeof ctx.endedAt).toBe("number");
    expect(typeof ctx.runtimeMs).toBe("number");
  });

  it("does not fire hook for unregistered runIds", async () => {
    // Import module to ensure listener is attached.
    const mod = await import("./subagent-registry.js");
    mod.registerSubagentRun(makeEntry({ runId: "run-registered" }));
    await new Promise((r) => setTimeout(r, 0));
    triggerSpy.mockClear();

    // Emit lifecycle event for an unknown runId.
    if (lifecycleListener) {
      lifecycleListener({
        runId: "run-unknown-xyz",
        stream: "lifecycle",
        data: { phase: "end", endedAt: 9999 },
      });
    }
    await new Promise((r) => setTimeout(r, 0));

    // No hook should fire for the unknown runId.
    expect(triggerSpy).not.toHaveBeenCalled();
  });
});
