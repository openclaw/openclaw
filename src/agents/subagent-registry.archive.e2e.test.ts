import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const noop = () => {};
let currentConfig = {
  agents: { defaults: { subagents: { archiveAfterMinutes: 60 } } },
};
const loadConfigMock = vi.fn(() => currentConfig);

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (request: unknown) => {
    const method = (request as { method?: string }).method;
    if (method === "agent.wait") {
      // Keep lifecycle unsettled so register/replace assertions can inspect stored state.
      return { status: "pending" };
    }
    return {};
  }),
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn((_handler: unknown) => noop),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: loadConfigMock,
  };
});

vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn(async () => true),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: vi.fn(() => new Map()),
  saveSubagentRegistryToDisk: vi.fn(() => {}),
}));

describe("subagent registry archive behavior", () => {
  let mod: typeof import("./subagent-registry.js");

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    currentConfig = {
      agents: { defaults: { subagents: { archiveAfterMinutes: 60 } } },
    };
    loadConfigMock.mockClear();
    mod = await import("./subagent-registry.js");
  });

  afterEach(() => {
    mod.resetSubagentRegistryForTests({ persist: false });
    vi.useRealTimers();
  });

  it("does not set archiveAtMs for keep-mode run subagents", () => {
    mod.registerSubagentRun({
      runId: "run-keep-1",
      childSessionKey: "agent:main:subagent:keep-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "persistent-run",
      cleanup: "keep",
    });

    const run = mod.listSubagentRunsForRequester("agent:main:main")[0];
    expect(run?.runId).toBe("run-keep-1");
    expect(run?.spawnMode).toBe("run");
    expect(run?.archiveAtMs).toBeUndefined();
  });

  it("sets archiveAtMs and sweeps delete-mode run subagents", async () => {
    currentConfig = {
      agents: { defaults: { subagents: { archiveAfterMinutes: 1 } } },
    };

    mod.registerSubagentRun({
      runId: "run-delete-1",
      childSessionKey: "agent:main:subagent:delete-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "ephemeral-run",
      cleanup: "delete",
    });

    const initialRun = mod.listSubagentRunsForRequester("agent:main:main")[0];
    expect(initialRun?.archiveAtMs).toBe(Date.now() + 60_000);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
  });

  it("does not set archiveAtMs for persistent session-mode runs", () => {
    mod.registerSubagentRun({
      runId: "run-session-1",
      childSessionKey: "agent:main:subagent:session-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "persistent-session",
      cleanup: "keep",
      spawnMode: "session",
    });

    const run = mod.listSubagentRunsForRequester("agent:main:main")[0];
    expect(run?.runId).toBe("run-session-1");
    expect(run?.spawnMode).toBe("session");
    expect(run?.archiveAtMs).toBeUndefined();
  });

  it("keeps archiveAtMs unset when replacing a keep-mode run after steer restart", () => {
    mod.registerSubagentRun({
      runId: "run-old",
      childSessionKey: "agent:main:subagent:run-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "persistent-run",
      cleanup: "keep",
    });

    const replaced = mod.replaceSubagentRunAfterSteer({
      previousRunId: "run-old",
      nextRunId: "run-new",
    });

    expect(replaced).toBe(true);
    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-new");
    expect(run?.spawnMode).toBe("run");
    expect(run?.archiveAtMs).toBeUndefined();
  });

  it("recomputes archiveAtMs when replacing a delete-mode run after steer restart", async () => {
    currentConfig = {
      agents: { defaults: { subagents: { archiveAfterMinutes: 1 } } },
    };

    mod.registerSubagentRun({
      runId: "run-delete-old",
      childSessionKey: "agent:main:subagent:delete-old",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "ephemeral-run",
      cleanup: "delete",
    });

    await vi.advanceTimersByTimeAsync(5_000);

    const replaced = mod.replaceSubagentRunAfterSteer({
      previousRunId: "run-delete-old",
      nextRunId: "run-delete-new",
    });

    expect(replaced).toBe(true);
    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-delete-new");
    expect(run?.archiveAtMs).toBe(Date.now() + 60_000);
  });

  it("treats archiveAfterMinutes=0 as never archive", () => {
    currentConfig = {
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
    };

    mod.registerSubagentRun({
      runId: "run-no-archive",
      childSessionKey: "agent:main:subagent:no-archive",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "never archive",
      cleanup: "delete",
    });

    const run = mod.listSubagentRunsForRequester("agent:main:main")[0];
    expect(run?.archiveAtMs).toBeUndefined();
  });
});
