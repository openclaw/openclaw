import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "./subagent-registry.mocks.shared.js";

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
  })),
}));

vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn(async () => true),
  buildSubagentSystemPrompt: vi.fn(() => "test prompt"),
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: vi.fn(() => new Map()),
  saveSubagentRegistryToDisk: vi.fn(() => {}),
}));

let subagentRegistry: typeof import("./subagent-registry.js");

describe("subagent registry nested agent tracking", () => {
  beforeAll(async () => {
    subagentRegistry = await import("./subagent-registry.js");
  });

  afterEach(() => {
    subagentRegistry.resetSubagentRegistryForTests({ persist: false });
  });

  it("listSubagentRunsForRequester returns children of the requesting session", async () => {
    const { registerSubagentRun, listSubagentRunsForRequester } = subagentRegistry;

    // Main agent spawns a depth-1 orchestrator
    registerSubagentRun({
      runId: "run-orch",
      childSessionKey: "agent:main:subagent:orch-uuid",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "orchestrate something",
      cleanup: "keep",
      label: "orchestrator",
    });

    // Depth-1 orchestrator spawns a depth-2 leaf
    registerSubagentRun({
      runId: "run-leaf",
      childSessionKey: "agent:main:subagent:orch-uuid:subagent:leaf-uuid",
      requesterSessionKey: "agent:main:subagent:orch-uuid",
      requesterDisplayKey: "subagent:orch-uuid",
      task: "do leaf work",
      cleanup: "keep",
      label: "leaf",
    });

    // Main sees its direct child (the orchestrator)
    const mainRuns = listSubagentRunsForRequester("agent:main:main");
    expect(mainRuns).toHaveLength(1);
    expect(mainRuns[0].runId).toBe("run-orch");

    // Orchestrator sees its direct child (the leaf)
    const orchRuns = listSubagentRunsForRequester("agent:main:subagent:orch-uuid");
    expect(orchRuns).toHaveLength(1);
    expect(orchRuns[0].runId).toBe("run-leaf");

    // Leaf has no children
    const leafRuns = listSubagentRunsForRequester(
      "agent:main:subagent:orch-uuid:subagent:leaf-uuid",
    );
    expect(leafRuns).toHaveLength(0);
  });

  it("announce uses requesterSessionKey to route to the correct parent", async () => {
    const { registerSubagentRun } = subagentRegistry;
    // Register a sub-sub-agent whose parent is a sub-agent
    registerSubagentRun({
      runId: "run-subsub",
      childSessionKey: "agent:main:subagent:orch:subagent:child",
      requesterSessionKey: "agent:main:subagent:orch",
      requesterDisplayKey: "subagent:orch",
      task: "nested task",
      cleanup: "keep",
      label: "nested-leaf",
    });

    // When announce fires for the sub-sub-agent, it should target the sub-agent (depth-1),
    // NOT the main session. The registry entry's requesterSessionKey ensures this.
    // We verify the registry entry has the correct requesterSessionKey.
    const { listSubagentRunsForRequester } = subagentRegistry;
    const orchRuns = listSubagentRunsForRequester("agent:main:subagent:orch");
    expect(orchRuns).toHaveLength(1);
    expect(orchRuns[0].requesterSessionKey).toBe("agent:main:subagent:orch");
    expect(orchRuns[0].childSessionKey).toBe("agent:main:subagent:orch:subagent:child");
  });

  it("countActiveRunsForSession only counts active children of the specific session", async () => {
    const { registerSubagentRun, countActiveRunsForSession } = subagentRegistry;

    // Main spawns orchestrator (active)
    registerSubagentRun({
      runId: "run-orch-active",
      childSessionKey: "agent:main:subagent:orch1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "orchestrate",
      cleanup: "keep",
    });

    // Orchestrator spawns two leaves
    registerSubagentRun({
      runId: "run-leaf-1",
      childSessionKey: "agent:main:subagent:orch1:subagent:leaf1",
      requesterSessionKey: "agent:main:subagent:orch1",
      requesterDisplayKey: "subagent:orch1",
      task: "leaf 1",
      cleanup: "keep",
    });

    registerSubagentRun({
      runId: "run-leaf-2",
      childSessionKey: "agent:main:subagent:orch1:subagent:leaf2",
      requesterSessionKey: "agent:main:subagent:orch1",
      requesterDisplayKey: "subagent:orch1",
      task: "leaf 2",
      cleanup: "keep",
    });

    // Main has 1 active child
    expect(countActiveRunsForSession("agent:main:main")).toBe(1);

    // Orchestrator has 2 active children
    expect(countActiveRunsForSession("agent:main:subagent:orch1")).toBe(2);
  });

  it("countActiveDescendantRuns traverses through ended parents", async () => {
    const { addSubagentRunForTests, countActiveDescendantRuns } = subagentRegistry;

    addSubagentRunForTests({
      runId: "run-parent-ended",
      childSessionKey: "agent:main:subagent:orch-ended",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "orchestrate",
      cleanup: "keep",
      createdAt: 1,
      startedAt: 1,
      endedAt: 2,
      cleanupHandled: false,
    });
    addSubagentRunForTests({
      runId: "run-leaf-active",
      childSessionKey: "agent:main:subagent:orch-ended:subagent:leaf",
      requesterSessionKey: "agent:main:subagent:orch-ended",
      requesterDisplayKey: "orch-ended",
      task: "leaf",
      cleanup: "keep",
      createdAt: 1,
      startedAt: 1,
      cleanupHandled: false,
    });

    expect(countActiveDescendantRuns("agent:main:main")).toBe(1);
    expect(countActiveDescendantRuns("agent:main:subagent:orch-ended")).toBe(1);
  });

  it("countPendingDescendantRuns includes ended descendants until cleanup completes", async () => {
    const { addSubagentRunForTests, countPendingDescendantRuns } = subagentRegistry;

    addSubagentRunForTests({
      runId: "run-parent-ended-pending",
      childSessionKey: "agent:main:subagent:orch-pending",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "orchestrate",
      cleanup: "keep",
      createdAt: 1,
      startedAt: 1,
      endedAt: 2,
      cleanupHandled: false,
      cleanupCompletedAt: undefined,
    });
    addSubagentRunForTests({
      runId: "run-leaf-ended-pending",
      childSessionKey: "agent:main:subagent:orch-pending:subagent:leaf",
      requesterSessionKey: "agent:main:subagent:orch-pending",
      requesterDisplayKey: "orch-pending",
      task: "leaf",
      cleanup: "keep",
      createdAt: 1,
      startedAt: 1,
      endedAt: 2,
      cleanupHandled: true,
      cleanupCompletedAt: undefined,
    });

    expect(countPendingDescendantRuns("agent:main:main")).toBe(2);
    expect(countPendingDescendantRuns("agent:main:subagent:orch-pending")).toBe(1);

    addSubagentRunForTests({
      runId: "run-leaf-completed",
      childSessionKey: "agent:main:subagent:orch-pending:subagent:leaf-completed",
      requesterSessionKey: "agent:main:subagent:orch-pending",
      requesterDisplayKey: "orch-pending",
      task: "leaf complete",
      cleanup: "keep",
      createdAt: 1,
      startedAt: 1,
      endedAt: 2,
      cleanupHandled: true,
      cleanupCompletedAt: 3,
    });
    expect(countPendingDescendantRuns("agent:main:subagent:orch-pending")).toBe(1);
  });
});
