import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureRuntimePluginsLoaded: vi.fn(),
  ensureContextEnginesInitialized: vi.fn(),
  resolveContextEngine: vi.fn(),
  onSubagentEnded: vi.fn(async () => {}),
  onAgentEvent: vi.fn(() => () => {}),
  persistSubagentRunsToDisk: vi.fn(),
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: vi.fn(() => ({})),
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
  getSubagentRunsSnapshotForRead: vi.fn((runs: Map<string, unknown>) => new Map(runs)),
  persistSubagentRunsToDisk: mocks.persistSubagentRunsToDisk,
  restoreSubagentRunsFromDisk: vi.fn(() => 0),
}));

vi.mock("./subagent-announce-queue.js", () => ({
  resetAnnounceQueuesForTests: vi.fn(),
}));

vi.mock("./timeout.js", () => ({
  resolveAgentTimeoutMs: vi.fn(() => 1_000),
}));

import {
  registerSubagentRun,
  releaseSubagentRun,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";

describe("subagent-registry context-engine bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveContextEngine.mockResolvedValue({
      onSubagentEnded: mocks.onSubagentEnded,
    });
    resetSubagentRegistryForTests({ persist: false });
  });

  it("reloads runtime plugins with the spawned workspace before subagent end hooks", async () => {
    registerSubagentRun({
      runId: "run-1",
      childSessionKey: "agent:main:session:child",
      requesterSessionKey: "agent:main:session:parent",
      requesterDisplayKey: "parent",
      task: "task",
      cleanup: "keep",
      workspaceDir: "/tmp/workspace",
    });

    releaseSubagentRun("run-1");

    await vi.waitFor(() => {
      expect(mocks.ensureRuntimePluginsLoaded).toHaveBeenCalledWith({
        config: {},
        workspaceDir: "/tmp/workspace",
      });
    });
    expect(mocks.ensureContextEnginesInitialized).toHaveBeenCalledTimes(1);
    expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
      childSessionKey: "agent:main:session:child",
      reason: "released",
      workspaceDir: "/tmp/workspace",
    });
  });
});
