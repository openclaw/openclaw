import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const noop = () => {};

type LifecycleEvent = {
  stream?: string;
  runId: string;
  sessionKey?: string;
  data?: {
    phase?: string;
    endedAt?: number;
    aborted?: boolean;
  };
};

let lifecycleHandler: ((evt: LifecycleEvent) => void) | undefined;

const loadOpenClawPluginsMock = vi.fn();
const ensureContextEnginesInitializedMock = vi.fn();
const onSubagentEndedMock = vi.fn(async () => {});
const resolveContextEngineMock = vi.fn(async () => ({
  onSubagentEnded: onSubagentEndedMock,
}));
const runSubagentAnnounceFlowMock = vi.fn(async () => true);

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({})),
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn((handler: typeof lifecycleHandler) => {
    lifecycleHandler = handler;
    return noop;
  }),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agents: {
      defaults: {
        subagents: { archiveAfterMinutes: 0 },
      },
      list: [
        {
          id: "child",
          workspace: "/tmp/workspace-child",
        },
      ],
    },
  })),
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => ({
    "agent:child:subagent:child-1": {
      sessionId: "sess-child-1",
      updatedAt: 1,
    },
  })),
  resolveAgentIdFromSessionKey: (key: string) => {
    const match = key.match(/^agent:([^:]+)/);
    return match?.[1] ?? "main";
  },
  resolveStorePath: vi.fn(() => "/tmp/test-session-store.json"),
}));

vi.mock("../context-engine/init.js", () => ({
  ensureContextEnginesInitialized: ensureContextEnginesInitializedMock,
}));

vi.mock("../context-engine/registry.js", () => ({
  resolveContextEngine: resolveContextEngineMock,
}));

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins: loadOpenClawPluginsMock,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("./subagent-announce.js", () => ({
  captureSubagentCompletionReply: vi.fn(async () => undefined),
  runSubagentAnnounceFlow: runSubagentAnnounceFlowMock,
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: vi.fn(() => new Map()),
  saveSubagentRegistryToDisk: vi.fn(() => {}),
}));

describe("subagent registry context-engine workspace", () => {
  let mod: typeof import("./subagent-registry.js");

  beforeAll(async () => {
    mod = await import("./subagent-registry.js");
  });

  beforeEach(() => {
    lifecycleHandler = undefined;
    loadOpenClawPluginsMock.mockReset();
    ensureContextEnginesInitializedMock.mockReset();
    onSubagentEndedMock.mockReset();
    onSubagentEndedMock.mockResolvedValue(undefined);
    resolveContextEngineMock.mockReset();
    resolveContextEngineMock.mockResolvedValue({
      onSubagentEnded: onSubagentEndedMock,
    });
    runSubagentAnnounceFlowMock.mockReset();
    runSubagentAnnounceFlowMock.mockResolvedValue(true);
  });

  afterEach(() => {
    mod.resetSubagentRegistryForTests({ persist: false });
  });

  const flushAsync = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  const waitForPluginLoad = async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (loadOpenClawPluginsMock.mock.calls.length > 0) {
        return;
      }
      await flushAsync();
    }
    throw new Error("expected plugin loader call");
  };

  it("uses the child session workspace before onSubagentEnded resolves the engine", async () => {
    mod.registerSubagentRun({
      runId: "run-child-workspace",
      childSessionKey: "agent:child:subagent:child-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "test subagent workspace plugin loading",
      cleanup: "keep",
    });

    lifecycleHandler?.({
      stream: "lifecycle",
      runId: "run-child-workspace",
      sessionKey: "agent:child:subagent:child-1",
      data: {
        phase: "end",
        endedAt: 1_000,
      },
    });

    await waitForPluginLoad();

    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/workspace-child",
      }),
    );
    expect(ensureContextEnginesInitializedMock).toHaveBeenCalledTimes(1);
    expect(resolveContextEngineMock).toHaveBeenCalledTimes(1);
    expect(onSubagentEndedMock).toHaveBeenCalledWith({
      childSessionKey: "agent:child:subagent:child-1",
      reason: "completed",
    });
  });
});
