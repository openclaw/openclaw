import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const noop = () => {};

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

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    agents: { defaults: { subagents: { archiveAfterMinutes: 60 } } },
  })),
}));

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

  beforeAll(async () => {
    mod = await import("./subagent-registry.js");
  });

  afterEach(() => {
    mod.resetSubagentRegistryForTests({ persist: false });
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

  it("keeps archiveAtMs unset when replacing a session-mode run after steer restart", () => {
    mod.registerSubagentRun({
      runId: "run-old",
      childSessionKey: "agent:main:subagent:session-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "persistent-session",
      cleanup: "keep",
      spawnMode: "session",
    });

    const replaced = mod.replaceSubagentRunAfterSteer({
      previousRunId: "run-old",
      nextRunId: "run-new",
    });

    expect(replaced).toBe(true);
    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-new");
    expect(run?.spawnMode).toBe("session");
    expect(run?.archiveAtMs).toBeUndefined();
  });
});
