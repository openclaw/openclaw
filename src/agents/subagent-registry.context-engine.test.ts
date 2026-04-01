import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const noop = () => {};

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  ensureRuntimePluginsLoaded: vi.fn(),
  ensureContextEnginesInitialized: vi.fn(),
  resolveContextEngine: vi.fn(),
  onSubagentEnded: vi.fn(async () => {}),
  onAgentEvent: vi.fn(() => noop),
  persistSubagentRunsToDisk: vi.fn(),
  restoreSubagentRunsFromDisk: vi.fn(() => 0),
  getSubagentRunsSnapshotForRead: vi.fn((runs: Map<string, SubagentRunRecord>) => new Map(runs)),
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: mocks.loadConfig,
  };
});

vi.mock("../context-engine/init.js", () => ({
  ensureContextEnginesInitialized: mocks.ensureContextEnginesInitialized,
}));

vi.mock("../context-engine/registry.js", () => ({
  resolveContextEngine: mocks.resolveContextEngine,
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: mocks.onAgentEvent,
}));

vi.mock("./runtime-plugins.js", () => ({
  ensureRuntimePluginsLoaded: mocks.ensureRuntimePluginsLoaded,
}));

vi.mock("./subagent-registry-state.js", () => ({
  getSubagentRunsSnapshotForRead: mocks.getSubagentRunsSnapshotForRead,
  persistSubagentRunsToDisk: mocks.persistSubagentRunsToDisk,
  restoreSubagentRunsFromDisk: mocks.restoreSubagentRunsFromDisk,
}));

vi.mock("./subagent-announce-queue.js", () => ({
  resetAnnounceQueuesForTests: vi.fn(),
}));

vi.mock("./timeout.js", () => ({
  resolveAgentTimeoutMs: vi.fn(() => 1_000),
}));

describe("subagent-registry context-engine bootstrap", () => {
  let mod: typeof import("./subagent-registry.js");

  beforeAll(async () => {
    mod = await import("./subagent-registry.js");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveContextEngine.mockResolvedValue({
      onSubagentEnded: mocks.onSubagentEnded,
    });
    mod.__testing.setDepsForTest({
      loadConfig: mocks.loadConfig,
      ensureRuntimePluginsLoaded: mocks.ensureRuntimePluginsLoaded,
      ensureContextEnginesInitialized: mocks.ensureContextEnginesInitialized,
      resolveContextEngine: mocks.resolveContextEngine,
      onAgentEvent: mocks.onAgentEvent,
      persistSubagentRunsToDisk: mocks.persistSubagentRunsToDisk,
      restoreSubagentRunsFromDisk: mocks.restoreSubagentRunsFromDisk,
      getSubagentRunsSnapshotForRead: mocks.getSubagentRunsSnapshotForRead,
    });
    mod.resetSubagentRegistryForTests({ persist: false });
  });

  afterEach(() => {
    mod.__testing.setDepsForTest();
    mod.resetSubagentRegistryForTests({ persist: false });
  });

  it("reloads runtime plugins with the spawned workspace before released subagent end hooks", async () => {
    mod.addSubagentRunForTests({
      runId: "run-1",
      childSessionKey: "agent:main:session:child",
      controllerSessionKey: "agent:main:session:parent",
      requesterSessionKey: "agent:main:session:parent",
      requesterOrigin: undefined,
      requesterDisplayKey: "parent",
      task: "task",
      cleanup: "keep",
      expectsCompletionMessage: undefined,
      spawnMode: "run",
      workspaceDir: "/tmp/workspace",
      createdAt: 1,
      startedAt: 1,
      sessionStartedAt: 1,
      accumulatedRuntimeMs: 0,
      cleanupHandled: false,
    });

    mod.releaseSubagentRun("run-1");

    await vi.waitFor(() => {
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
        childSessionKey: "agent:main:session:child",
        reason: "released",
        workspaceDir: "/tmp/workspace",
      });
    });
    expect(mocks.ensureRuntimePluginsLoaded).toHaveBeenCalledWith({
      config: {},
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });
    expect(mocks.ensureContextEnginesInitialized).toHaveBeenCalledTimes(1);
  });
});
