import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/active-runs", () => ({
  abortRun: vi.fn(() => false),
  getActiveRun: vi.fn(),
}));

vi.mock("@/lib/subagent-registry", () => ({
  listSubagentsForRequesterSession: vi.fn(() => []),
}));

vi.mock("@/lib/workspace", () => ({
  resolveActiveAgentId: vi.fn(() => "main"),
}));

vi.mock("@/app/api/web-sessions/shared", () => ({
  resolveSessionKey: vi.fn((sessionId: string, fallbackAgentId: string) => `agent:${fallbackAgentId}:web:${sessionId}`),
}));

vi.mock("@/lib/telemetry", () => ({
  trackServer: vi.fn(),
}));

describe("POST /api/chat/stop", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("stops a parent session and all active child subagents when cascadeChildren is enabled (prevents orphan background work)", async () => {
    const { abortRun, getActiveRun } = await import("@/lib/active-runs");
    const { listSubagentsForRequesterSession } = await import("@/lib/subagent-registry");

    vi.mocked(getActiveRun).mockImplementation(((runKey: string) => {
      if (runKey === "parent-1") {
        return { status: "waiting-for-subagents" };
      }
      if (runKey === "agent:chat-slot-main-1:subagent:child-1") {
        return { status: "running" };
      }
      if (runKey === "agent:chat-slot-main-2:subagent:child-2") {
        return { status: "completed" };
      }
      return undefined;
    }) as never);

    vi.mocked(listSubagentsForRequesterSession).mockReturnValue([
      {
        runId: "run-1",
        childSessionKey: "agent:chat-slot-main-1:subagent:child-1",
        requesterSessionKey: "agent:main:web:parent-1",
        task: "Collect facts",
        status: "running",
      },
      {
        runId: "run-2",
        childSessionKey: "agent:chat-slot-main-2:subagent:child-2",
        requesterSessionKey: "agent:main:web:parent-1",
        task: "Already done",
        status: "completed",
      },
    ] as never);

    vi.mocked(abortRun).mockReturnValue(true);

    const { POST } = await import("./route.js");
    const req = new Request("http://localhost/api/chat/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "parent-1",
        cascadeChildren: true,
      }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(abortRun).toHaveBeenCalledWith("parent-1");
    expect(abortRun).toHaveBeenCalledWith("agent:chat-slot-main-1:subagent:child-1");
    expect(abortRun).not.toHaveBeenCalledWith("agent:chat-slot-main-2:subagent:child-2");
    expect(json).toEqual({ aborted: true, abortedChildren: 1 });
  });

  it("stops only the requested subagent session when sessionKey is provided", async () => {
    const { abortRun, getActiveRun } = await import("@/lib/active-runs");
    const { listSubagentsForRequesterSession } = await import("@/lib/subagent-registry");

    vi.mocked(getActiveRun).mockImplementation(((runKey: string) => {
      if (runKey === "agent:chat-slot-main-1:subagent:child-1") {
        return { status: "running" };
      }
      return undefined;
    }) as never);
    vi.mocked(abortRun).mockReturnValue(true);

    const { POST } = await import("./route.js");
    const req = new Request("http://localhost/api/chat/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionKey: "agent:chat-slot-main-1:subagent:child-1",
      }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(abortRun).toHaveBeenCalledWith("agent:chat-slot-main-1:subagent:child-1");
    expect(listSubagentsForRequesterSession).not.toHaveBeenCalled();
    expect(json).toEqual({ aborted: true, abortedChildren: 0 });
  });
});
