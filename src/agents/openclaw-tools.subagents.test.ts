import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSubagentRunForTests,
  listSubagentRunsForRequester,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";

function createStubTool(name: string) {
  return {
    name,
    description: `${name} stub`,
    parameters: { type: "object", properties: {} },
    execute: vi.fn(async () => ({ output: name })),
  };
}

function mockToolFactory(name: string) {
  return () => createStubTool(name);
}

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      session: {
        mainKey: "main",
        scope: "per-sender",
        agentToAgent: { maxPingPongTurns: 2 },
      },
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: true },
      },
    }),
    resolveGatewayPort: () => 18789,
  };
});

vi.mock("./tools/agents-list-tool.js", () => ({
  createAgentsListTool: mockToolFactory("agents_list_stub"),
}));
vi.mock("./tools/cron-tool.js", () => ({
  createCronTool: mockToolFactory("cron_stub"),
}));
vi.mock("./tools/gateway-tool.js", () => ({
  createGatewayTool: mockToolFactory("gateway_stub"),
}));
vi.mock("./tools/image-generate-tool.js", () => ({
  createImageGenerateTool: mockToolFactory("image_generate_stub"),
}));
vi.mock("./tools/message-tool.js", () => ({
  createMessageTool: mockToolFactory("message_stub"),
}));
vi.mock("./tools/nodes-tool.js", () => ({
  createNodesTool: mockToolFactory("nodes_stub"),
}));
vi.mock("./tools/pdf-tool.js", () => ({
  createPdfTool: mockToolFactory("pdf_stub"),
}));
vi.mock("./tools/session-status-tool.js", () => ({
  createSessionStatusTool: mockToolFactory("session_status_stub"),
}));
vi.mock("./tools/sessions-history-tool.js", () => ({
  createSessionsHistoryTool: mockToolFactory("sessions_history_stub"),
}));
vi.mock("./tools/sessions-list-tool.js", () => ({
  createSessionsListTool: mockToolFactory("sessions_list_stub"),
}));
vi.mock("./tools/sessions-send-tool.js", () => ({
  createSessionsSendTool: mockToolFactory("sessions_send_stub"),
}));
vi.mock("./tools/sessions-spawn-tool.js", () => ({
  createSessionsSpawnTool: mockToolFactory("sessions_spawn_stub"),
}));
vi.mock("./tools/sessions-yield-tool.js", () => ({
  createSessionsYieldTool: mockToolFactory("sessions_yield_stub"),
}));
vi.mock("./tools/tts-tool.js", () => ({
  createTtsTool: mockToolFactory("tts_stub"),
}));

import { __testing as subagentControlTesting } from "./subagent-control.js";
import { createSubagentsTool } from "./tools/subagents-tool.js";

let sessionStoreLoadModule: typeof import("../config/sessions/store-load.js");

function getSubagentsTool(agentSessionKey = "agent:main:main") {
  return createSubagentsTool({ agentSessionKey });
}

describe("subagents tool", () => {
  beforeAll(async () => {
    sessionStoreLoadModule = await import("../config/sessions/store-load.js");
  });

  beforeEach(() => {
    callGatewayMock.mockClear();
    subagentControlTesting.setDepsForTest({
      callGateway: (opts: unknown) => callGatewayMock(opts),
    });
  });

  it("uses number (not integer) in subagents schema for Gemini compatibility", () => {
    const tool = getSubagentsTool();
    const schema = tool.parameters as { properties?: Record<string, unknown> };
    const recentMinutes = schema.properties?.recentMinutes as { type?: unknown } | undefined;
    expect(recentMinutes?.type).toBe("number");
  });

  it("subagents lists active and recent runs", async () => {
    resetSubagentRegistryForTests();
    const now = Date.now();
    addSubagentRunForTests({
      runId: "run-active",
      childSessionKey: "agent:main:subagent:active",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "investigate auth",
      cleanup: "keep",
      createdAt: now - 2 * 60_000,
      startedAt: now - 2 * 60_000,
    });
    addSubagentRunForTests({
      runId: "run-child",
      childSessionKey: "agent:main:subagent:active:subagent:child",
      requesterSessionKey: "agent:main:subagent:active",
      requesterDisplayKey: "subagent:active",
      task: "child worker",
      cleanup: "keep",
      createdAt: now - 60_000,
      startedAt: now - 60_000,
    });
    addSubagentRunForTests({
      runId: "run-recent",
      childSessionKey: "agent:main:subagent:recent",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "summarize findings",
      cleanup: "keep",
      createdAt: now - 15 * 60_000,
      startedAt: now - 14 * 60_000,
      endedAt: now - 5 * 60_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-old",
      childSessionKey: "agent:main:subagent:old",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "old completed run",
      cleanup: "keep",
      createdAt: now - 90 * 60_000,
      startedAt: now - 89 * 60_000,
      endedAt: now - 80 * 60_000,
      outcome: { status: "ok" },
    });

    const tool = getSubagentsTool();

    const result = await tool.execute("call-subagents-list", { action: "list" });
    const details = result.details as {
      status?: string;
      active?: Array<{ runId?: string; childSessions?: string[] }>;
      recent?: unknown[];
      text?: string;
    };
    expect(details.status).toBe("ok");
    expect(details.active).toHaveLength(1);
    expect(details.active?.[0]).toMatchObject({
      runId: "run-active",
      childSessions: ["agent:main:subagent:active:subagent:child"],
    });
    expect(details.recent).toHaveLength(1);
    expect(details.text).toContain("active subagents:");
    expect(details.text).toContain("recent (last 30m):");
  });

  it("subagents list keeps ended orchestrators active while descendants are pending", async () => {
    resetSubagentRegistryForTests();
    const now = Date.now();
    addSubagentRunForTests({
      runId: "run-orchestrator-ended",
      childSessionKey: "agent:main:subagent:orchestrator-ended",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "orchestrate child workers",
      cleanup: "keep",
      createdAt: now - 5 * 60_000,
      startedAt: now - 5 * 60_000,
      endedAt: now - 4 * 60_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-orchestrator-child-active",
      childSessionKey: "agent:main:subagent:orchestrator-ended:subagent:child",
      requesterSessionKey: "agent:main:subagent:orchestrator-ended",
      requesterDisplayKey: "subagent:orchestrator-ended",
      task: "child worker still running",
      cleanup: "keep",
      createdAt: now - 60_000,
      startedAt: now - 60_000,
    });

    const tool = getSubagentsTool();

    const result = await tool.execute("call-subagents-list-orchestrator", { action: "list" });
    const details = result.details as {
      status?: string;
      active?: Array<{ runId?: string; status?: string; pendingDescendants?: number }>;
      recent?: Array<{ runId?: string }>;
      text?: string;
    };

    expect(details.status).toBe("ok");
    expect(details.active).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "run-orchestrator-ended",
          status: "active (waiting on 1 child)",
          pendingDescendants: 1,
        }),
      ]),
    );
    expect(details.recent?.find((entry) => entry.runId === "run-orchestrator-ended")).toBeFalsy();
    expect(details.text).toContain("active (waiting on 1 child)");
  });

  it("subagents list does not double-count restarted descendants on one child session", async () => {
    resetSubagentRegistryForTests();
    const now = Date.now();
    const parentKey = "agent:main:subagent:orchestrator-restarted-child";
    const childKey = `${parentKey}:subagent:worker`;
    addSubagentRunForTests({
      runId: "run-orchestrator-ended-restarted",
      childSessionKey: parentKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "orchestrate restarted child worker",
      cleanup: "keep",
      createdAt: now - 5 * 60_000,
      startedAt: now - 5 * 60_000,
      endedAt: now - 4 * 60_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-restarted-child-stale",
      childSessionKey: childKey,
      requesterSessionKey: parentKey,
      requesterDisplayKey: parentKey,
      task: "stale child run",
      cleanup: "keep",
      createdAt: now - 90_000,
      startedAt: now - 90_000,
      endedAt: now - 70_000,
      cleanupCompletedAt: undefined,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-restarted-child-current",
      childSessionKey: childKey,
      requesterSessionKey: parentKey,
      requesterDisplayKey: parentKey,
      task: "current child run",
      cleanup: "keep",
      createdAt: now - 60_000,
      startedAt: now - 60_000,
    });

    const tool = getSubagentsTool();

    const result = await tool.execute("call-subagents-list-restarted-child", { action: "list" });
    const details = result.details as {
      status?: string;
      active?: Array<{ runId?: string; status?: string; pendingDescendants?: number }>;
      text?: string;
    };

    expect(details.status).toBe("ok");
    expect(details.active).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "run-orchestrator-ended-restarted",
          status: "active (waiting on 1 child)",
          pendingDescendants: 1,
        }),
      ]),
    );
    expect(details.text).toContain("active (waiting on 1 child)");
    expect(details.text).not.toContain("active (waiting on 2 children)");
  });

  it("subagents list does not keep childSessions attached to a stale older parent", async () => {
    resetSubagentRegistryForTests();
    const now = Date.now();
    const oldParentKey = "agent:main:subagent:old-parent";
    const newParentKey = "agent:main:subagent:new-parent";
    const childKey = "agent:main:subagent:shared-child";

    addSubagentRunForTests({
      runId: "run-old-parent",
      childSessionKey: oldParentKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "old parent task",
      cleanup: "keep",
      createdAt: now - 10_000,
      startedAt: now - 9_000,
    });
    addSubagentRunForTests({
      runId: "run-new-parent",
      childSessionKey: newParentKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "new parent task",
      cleanup: "keep",
      createdAt: now - 8_000,
      startedAt: now - 7_000,
    });
    addSubagentRunForTests({
      runId: "run-shared-child-stale-parent",
      childSessionKey: childKey,
      requesterSessionKey: oldParentKey,
      requesterDisplayKey: oldParentKey,
      controllerSessionKey: oldParentKey,
      task: "shared child stale parent",
      cleanup: "keep",
      createdAt: now - 6_000,
      startedAt: now - 5_000,
      endedAt: now - 4_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-shared-child-current-parent",
      childSessionKey: childKey,
      requesterSessionKey: newParentKey,
      requesterDisplayKey: newParentKey,
      controllerSessionKey: newParentKey,
      task: "shared child current parent",
      cleanup: "keep",
      createdAt: now - 2_000,
      startedAt: now - 1_500,
    });

    const tool = getSubagentsTool();

    const result = await tool.execute("call-subagents-list-stale-parent", { action: "list" });
    const details = result.details as {
      status?: string;
      active?: Array<{
        runId?: string;
        childSessions?: string[];
        pendingDescendants?: number;
        status?: string;
      }>;
    };

    expect(details.status).toBe("ok");
    const oldParent = details.active?.find((entry) => entry.runId === "run-old-parent");
    const newParent = details.active?.find((entry) => entry.runId === "run-new-parent");
    expect(oldParent).toMatchObject({
      runId: "run-old-parent",
      pendingDescendants: 0,
      status: "running",
    });
    expect(oldParent?.childSessions).toBeUndefined();
    expect(newParent).toMatchObject({
      runId: "run-new-parent",
      childSessions: [childKey],
      pendingDescendants: 1,
      status: "active (waiting on 1 child)",
    });
  });

  it("subagents list dedupes stale rows for the same child session", async () => {
    resetSubagentRegistryForTests();
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:list-dedupe-worker";
    addSubagentRunForTests({
      runId: "run-list-current",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current worker label",
      cleanup: "keep",
      createdAt: now - 60_000,
      startedAt: now - 60_000,
    });
    addSubagentRunForTests({
      runId: "run-list-stale",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stale worker label",
      cleanup: "keep",
      createdAt: now - 120_000,
      startedAt: now - 120_000,
      endedAt: now - 90_000,
      outcome: { status: "ok" },
    });

    const tool = getSubagentsTool();

    const result = await tool.execute("call-subagents-list-dedupe", { action: "list" });
    const details = result.details as {
      status?: string;
      total?: number;
      active?: Array<{ runId?: string }>;
      recent?: Array<{ runId?: string }>;
      text?: string;
    };

    expect(details.status).toBe("ok");
    expect(details.total).toBe(1);
    expect(details.active).toEqual([
      expect.objectContaining({
        runId: "run-list-current",
      }),
    ]);
    expect(details.recent?.find((entry) => entry.runId === "run-list-stale")).toBeFalsy();
    expect(details.text).toContain("current worker label");
    expect(details.text).not.toContain("stale worker label");
  });

  it("subagents list usage separates io tokens from prompt/cache", async () => {
    resetSubagentRegistryForTests();
    const now = Date.now();
    addSubagentRunForTests({
      runId: "run-usage-active",
      childSessionKey: "agent:main:subagent:usage-active",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "wait and check weather",
      cleanup: "keep",
      createdAt: now - 2 * 60_000,
      startedAt: now - 2 * 60_000,
    });

    const loadSessionStoreSpy = vi
      .spyOn(sessionStoreLoadModule, "loadSessionStore")
      .mockImplementation(() => ({
        "agent:main:subagent:usage-active": {
          sessionId: "session-usage-active",
          updatedAt: now,
          modelProvider: "anthropic",
          model: "claude-opus-4-6",
          inputTokens: 12,
          outputTokens: 1000,
          totalTokens: 197000,
        },
      }));

    try {
      const tool = getSubagentsTool();

      const result = await tool.execute("call-subagents-list-usage", { action: "list" });
      const details = result.details as {
        status?: string;
        text?: string;
      };
      expect(details.status).toBe("ok");
      expect(details.text).toMatch(/tokens 1(\.0)?k \(in 12 \/ out 1(\.0)?k\)/);
      expect(details.text).toContain("prompt/cache 197k");
      expect(details.text).not.toContain("1.0k io");
    } finally {
      loadSessionStoreSpy.mockRestore();
    }
  });

  it("subagents steer sends guidance to a running run", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-steer-1" };
      }
      return {};
    });
    addSubagentRunForTests({
      runId: "run-steer",
      childSessionKey: "agent:main:subagent:steer",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "prepare release notes",
      cleanup: "keep",
      createdAt: Date.now() - 60_000,
      startedAt: Date.now() - 60_000,
    });

    const loadSessionStoreSpy = vi
      .spyOn(sessionStoreLoadModule, "loadSessionStore")
      .mockImplementation(() => ({
        "agent:main:subagent:steer": {
          sessionId: "child-session-steer",
          updatedAt: Date.now(),
        },
      }));

    try {
      const tool = getSubagentsTool();

      const result = await tool.execute("call-subagents-steer", {
        action: "steer",
        target: "1",
        message: "skip changelog and focus on tests",
      });
      const details = result.details as { status?: string; runId?: string; text?: string };
      expect(details.status).toBe("accepted");
      expect(details.runId).toBe("run-steer-1");
      expect(details.text).toContain("steered");
      const steerWaitIndex = callGatewayMock.mock.calls.findIndex(
        (call) =>
          (call[0] as { method?: string; params?: { runId?: string } }).method === "agent.wait" &&
          (call[0] as { method?: string; params?: { runId?: string } }).params?.runId ===
            "run-steer",
      );
      expect(steerWaitIndex).toBeGreaterThanOrEqual(0);
      const steerRunIndex = callGatewayMock.mock.calls.findIndex(
        (call) => (call[0] as { method?: string }).method === "agent",
      );
      expect(steerRunIndex).toBeGreaterThan(steerWaitIndex);
      expect(callGatewayMock.mock.calls[steerWaitIndex]?.[0]).toMatchObject({
        method: "agent.wait",
        params: { runId: "run-steer", timeoutMs: 5_000 },
        timeoutMs: 7_000,
      });
      expect(callGatewayMock.mock.calls[steerRunIndex]?.[0]).toMatchObject({
        method: "agent",
        params: {
          lane: "subagent",
          sessionKey: "agent:main:subagent:steer",
          sessionId: "child-session-steer",
          timeout: 0,
        },
      });

      const trackedRuns = listSubagentRunsForRequester("agent:main:main");
      expect(trackedRuns).toHaveLength(1);
      expect(trackedRuns[0].runId).toBe("run-steer-1");
      expect(trackedRuns[0].childSessionKey).toBe("agent:main:subagent:steer");
    } finally {
      loadSessionStoreSpy.mockRestore();
    }
  });

  it("subagents numeric targets follow active-first list ordering", async () => {
    resetSubagentRegistryForTests();
    addSubagentRunForTests({
      runId: "run-active",
      childSessionKey: "agent:main:subagent:active",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "active task",
      cleanup: "keep",
      createdAt: Date.now() - 120_000,
      startedAt: Date.now() - 120_000,
    });
    addSubagentRunForTests({
      runId: "run-recent",
      childSessionKey: "agent:main:subagent:recent",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "recent task",
      cleanup: "keep",
      createdAt: Date.now() - 30_000,
      startedAt: Date.now() - 30_000,
      endedAt: Date.now() - 10_000,
      outcome: { status: "ok" },
    });

    const tool = getSubagentsTool();

    const result = await tool.execute("call-subagents-kill-order", {
      action: "kill",
      target: "1",
    });
    const details = result.details as { status?: string; runId?: string; text?: string };
    expect(details.status).toBe("ok");
    expect(details.runId).toBe("run-active");
    expect(details.text).toContain("killed");
  });

  it("subagents numeric targets treat ended orchestrators waiting on children as active", async () => {
    resetSubagentRegistryForTests();
    const now = Date.now();
    addSubagentRunForTests({
      runId: "run-orchestrator-ended",
      childSessionKey: "agent:main:subagent:orchestrator-ended",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "orchestrator",
      cleanup: "keep",
      createdAt: now - 90_000,
      startedAt: now - 90_000,
      endedAt: now - 60_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-leaf-active",
      childSessionKey: "agent:main:subagent:orchestrator-ended:subagent:leaf",
      requesterSessionKey: "agent:main:subagent:orchestrator-ended",
      requesterDisplayKey: "subagent:orchestrator-ended",
      task: "leaf",
      cleanup: "keep",
      createdAt: now - 30_000,
      startedAt: now - 30_000,
    });
    addSubagentRunForTests({
      runId: "run-running",
      childSessionKey: "agent:main:subagent:running",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "running",
      cleanup: "keep",
      createdAt: now - 20_000,
      startedAt: now - 20_000,
    });

    const tool = getSubagentsTool();

    const list = await tool.execute("call-subagents-list-order-waiting", {
      action: "list",
    });
    const listDetails = list.details as {
      active?: Array<{ runId?: string; status?: string }>;
    };
    expect(listDetails.active).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "run-orchestrator-ended",
          status: "active (waiting on 1 child)",
        }),
      ]),
    );

    const result = await tool.execute("call-subagents-kill-order-waiting", {
      action: "kill",
      target: "1",
    });
    const details = result.details as { status?: string; runId?: string };
    expect(details.status).toBe("ok");
    expect(details.runId).toBe("run-running");
  });

  it("subagents kill stops a running run", async () => {
    resetSubagentRegistryForTests();
    addSubagentRunForTests({
      runId: "run-kill",
      childSessionKey: "agent:main:subagent:kill",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "long running task",
      cleanup: "keep",
      createdAt: Date.now() - 60_000,
      startedAt: Date.now() - 60_000,
    });

    const tool = getSubagentsTool();

    const result = await tool.execute("call-subagents-kill", {
      action: "kill",
      target: "1",
    });
    const details = result.details as { status?: string; text?: string };
    expect(details.status).toBe("ok");
    expect(details.text).toContain("killed");
  });

  it("subagents kill-all cascades through ended parents to active descendants", async () => {
    resetSubagentRegistryForTests();
    const now = Date.now();
    const endedParentKey = "agent:main:subagent:parent-ended";
    const activeChildKey = "agent:main:subagent:parent-ended:subagent:worker";
    addSubagentRunForTests({
      runId: "run-parent-ended",
      childSessionKey: endedParentKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "orchestrator",
      cleanup: "keep",
      createdAt: now - 120_000,
      startedAt: now - 120_000,
      endedAt: now - 60_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-worker-active",
      childSessionKey: activeChildKey,
      requesterSessionKey: endedParentKey,
      requesterDisplayKey: endedParentKey,
      task: "leaf worker",
      cleanup: "keep",
      createdAt: now - 30_000,
      startedAt: now - 30_000,
    });

    const tool = getSubagentsTool();

    const result = await tool.execute("call-subagents-kill-all-cascade-ended", {
      action: "kill",
      target: "all",
    });
    const details = result.details as { status?: string; killed?: number; text?: string };
    expect(details.status).toBe("ok");
    expect(details.killed).toBe(1);
    expect(details.text).toContain("killed 1 subagent");

    const descendants = listSubagentRunsForRequester(endedParentKey);
    const worker = descendants.find((entry) => entry.runId === "run-worker-active");
    expect(worker?.endedAt).toBeTypeOf("number");
  });
});
