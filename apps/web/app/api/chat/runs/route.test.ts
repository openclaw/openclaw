import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/active-runs", () => ({
  getActiveRun: vi.fn(),
}));

vi.mock("@/lib/subagent-registry", () => ({
  listSubagentsForRequesterSession: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({
  resolveActiveAgentId: vi.fn(() => "main"),
}));

vi.mock("@/app/api/web-sessions/shared", () => ({
  readIndex: vi.fn(() => []),
  resolveSessionKey: vi.fn((sessionId: string, fallbackAgentId: string) => `agent:${fallbackAgentId}:web:${sessionId}`),
}));

describe("GET /api/chat/runs", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns active parent runs plus subagents mapped back to their parent web session", async () => {
    const { getActiveRun } = await import("@/lib/active-runs");
    const { listSubagentsForRequesterSession } = await import("@/lib/subagent-registry");
    const { readIndex } = await import("@/app/api/web-sessions/shared");

    vi.mocked(readIndex).mockReturnValue([
      { id: "parent-1", title: "Parent 1", createdAt: 1, updatedAt: 1, messageCount: 2 },
      { id: "parent-2", title: "Parent 2", createdAt: 1, updatedAt: 1, messageCount: 3 },
    ] as never);

    vi.mocked(getActiveRun).mockImplementation(((sessionId: string) => {
      if (sessionId === "parent-1") {
        return { status: "running" };
      }
      if (sessionId === "parent-2") {
        return { status: "waiting-for-subagents" };
      }
      return undefined;
    }) as never);

    vi.mocked(listSubagentsForRequesterSession).mockImplementation(((requesterSessionKey: string) => {
      if (requesterSessionKey === "agent:main:web:parent-1") {
        return [
          {
            runId: "run-1",
            childSessionKey: "agent:chat-slot-main-1:subagent:child-1",
            requesterSessionKey,
            task: "Collect facts",
            label: "Fact finding",
            status: "running",
            createdAt: 10,
          },
        ];
      }
      if (requesterSessionKey === "agent:main:web:parent-2") {
        return [
          {
            runId: "run-2",
            childSessionKey: "agent:chat-slot-main-2:subagent:child-2",
            requesterSessionKey,
            task: "Summarize",
            status: "completed",
            createdAt: 20,
            endedAt: 30,
          },
        ];
      }
      return [];
    }) as never);

    const { GET } = await import("./route.js");
    const res = await GET();
    const json = await res.json();

    expect(json.parentRuns).toEqual([
      { sessionId: "parent-1", status: "running" },
      { sessionId: "parent-2", status: "waiting-for-subagents" },
    ]);
    expect(json.subagents).toEqual([
      {
        childSessionKey: "agent:chat-slot-main-1:subagent:child-1",
        parentSessionId: "parent-1",
        runId: "run-1",
        task: "Collect facts",
        label: "Fact finding",
        status: "running",
        startedAt: 10,
        endedAt: undefined,
      },
      {
        childSessionKey: "agent:chat-slot-main-2:subagent:child-2",
        parentSessionId: "parent-2",
        runId: "run-2",
        task: "Summarize",
        label: undefined,
        status: "completed",
        startedAt: 20,
        endedAt: 30,
      },
    ]);
  });
});
