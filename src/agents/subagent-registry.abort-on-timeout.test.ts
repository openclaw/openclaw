import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const noop = () => {};
let lifecycleHandler:
  | ((evt: { stream?: string; runId: string; data?: { phase?: string } }) => void)
  | undefined;

const callGatewaySpy = vi.fn(async (opts: unknown) => {
  const request = opts as { method?: string };
  if (request.method === "agent.wait") {
    // Simulate a timeout response from the gateway.
    return { status: "timeout" };
  }
  return {};
});

vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewaySpy(...args),
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn((handler: typeof lifecycleHandler) => {
    lifecycleHandler = handler;
    return noop;
  }),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agents: { defaults: { subagents: { archiveAfterMinutes: 0 }, timeoutSeconds: 60 } },
  })),
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => ({
    "agent:main:subagent:child-timeout": { sessionId: "session-abc" },
  })),
  resolveAgentIdFromSessionKey: vi.fn(() => "main"),
  resolveStorePath: vi.fn(() => "/tmp/test-store"),
}));

const abortSpy = vi.fn(() => true);
vi.mock("./pi-embedded.js", () => ({
  abortEmbeddedPiRun: (...args: unknown[]) => abortSpy(...args),
}));

const announceSpy = vi.fn(async () => true);
vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: (...args: unknown[]) => announceSpy(...args),
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: vi.fn(() => new Map()),
  saveSubagentRegistryToDisk: vi.fn(() => {}),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: { error: vi.fn() },
}));

describe("subagent abort on timeout", () => {
  let mod: typeof import("./subagent-registry.js");

  beforeAll(async () => {
    mod = await import("./subagent-registry.js");
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    callGatewaySpy.mockReset();
    callGatewaySpy.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      return {};
    });
    abortSpy.mockReset();
    abortSpy.mockReturnValue(true);
    announceSpy.mockReset();
    announceSpy.mockResolvedValue(true);
    mod.resetSubagentRegistryForTests({ persist: false });
  });

  it("aborts the child run when wait times out", async () => {
    mod.registerSubagentRun({
      runId: "run-timeout-1",
      childSessionKey: "agent:main:subagent:child-timeout",
      requesterSessionKey: "main",
      requesterDisplayKey: "main",
      task: "long running task",
      cleanup: "keep",
    });

    // Wait for the waitForSubagentCompletion to fire and get timeout.
    await vi.advanceTimersByTimeAsync(100);

    // Should have called abortEmbeddedPiRun with the child's sessionId.
    expect(abortSpy).toHaveBeenCalledWith("session-abc");

    // Announce flow should have been triggered with timeout outcome.
    expect(announceSpy).toHaveBeenCalled();
    const announceArgs = announceSpy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(announceArgs?.outcome).toEqual({ status: "timeout" });
  });

  it("does not abort when wait completes successfully", async () => {
    callGatewaySpy.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent.wait") {
        return { status: "ok", startedAt: Date.now(), endedAt: Date.now() };
      }
      return {};
    });

    mod.registerSubagentRun({
      runId: "run-ok-1",
      childSessionKey: "agent:main:subagent:child-timeout",
      requesterSessionKey: "main",
      requesterDisplayKey: "main",
      task: "quick task",
      cleanup: "keep",
    });

    await vi.advanceTimersByTimeAsync(100);

    // Should NOT have called abort.
    expect(abortSpy).not.toHaveBeenCalled();

    // Announce should still fire with ok status.
    expect(announceSpy).toHaveBeenCalled();
    const announceArgs = announceSpy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(announceArgs?.outcome).toEqual({ status: "ok" });
  });
});
