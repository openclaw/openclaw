import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { callGateway } from "../gateway/call.js";
import {
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
  resetAgentRunContextForTest,
} from "../infra/agent-events.js";

let currentConfig = {
  agents: { defaults: { subagents: { archiveAfterMinutes: 1 } } },
};
const loadConfigMock = vi.fn(() => currentConfig);
const flushSweepMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const countSessionsDelete = () =>
  vi
    .mocked(callGateway)
    .mock.calls.filter(
      ([request]) => (request as { method?: string } | undefined)?.method === "sessions.delete",
    ).length;

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({})),
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: loadConfigMock,
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

vi.mock("../tasks/task-status-access.js", () => ({
  findTaskByRunIdForStatus: vi.fn(() => undefined),
  listTasksForSessionKeyForStatus: vi.fn(() => [] as never[]),
}));

describe("subagent archive live run context (real agent-events store)", () => {
  let mod: typeof import("./subagent-registry.js");

  beforeAll(async () => {
    mod = await import("./subagent-registry.js");
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    currentConfig = {
      agents: { defaults: { subagents: { archiveAfterMinutes: 1 } } },
    };
    vi.mocked(callGateway).mockReset();
    vi.mocked(callGateway).mockImplementation(async () => ({}));
    loadConfigMock.mockClear();
    resetAgentRunContextForTest();
    mod.testing.setDepsForTest({
      callGateway,
      getRuntimeConfig: loadConfigMock as typeof import("../config/config.js").getRuntimeConfig,
      ensureRuntimePluginsLoaded: vi.fn(),
    });
    mod.resetSubagentRegistryForTests({ persist: false });
  });

  afterEach(() => {
    mod.testing.setDepsForTest();
    mod.resetSubagentRegistryForTests({ persist: false });
    resetAgentRunContextForTest();
    vi.useRealTimers();
  });

  it("retains a delete-mode run past its archive deadline while its real run context is live", async () => {
    const runId = "run-live-retain";
    const childSessionKey = "agent:main:subagent:live-retain";
    const now = Date.now();
    mod.addSubagentRunForTests({
      runId,
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "long-running-task",
      cleanup: "delete",
      createdAt: now,
      startedAt: now,
      archiveAtMs: now - 1,
    });
    registerAgentRunContext(runId, { sessionKey: childSessionKey });

    await mod.testing.sweepOnceForTests();
    await flushSweepMicrotasks();

    expect(getAgentRunContext(runId)).toBeTruthy();
    expect(countSessionsDelete()).toBe(0);
    expect(mod.listSubagentRunsForRequester("agent:main:main")).toEqual([
      expect.objectContaining({ runId }),
    ]);
  });

  it("archives the run on the next sweep once its real run context is released", async () => {
    const runId = "run-live-release";
    const childSessionKey = "agent:main:subagent:live-release";
    const now = Date.now();
    mod.addSubagentRunForTests({
      runId,
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "long-running-task",
      cleanup: "delete",
      createdAt: now,
      startedAt: now,
      archiveAtMs: now - 1,
    });
    registerAgentRunContext(runId, { sessionKey: childSessionKey });

    await mod.testing.sweepOnceForTests();
    await flushSweepMicrotasks();

    expect(getAgentRunContext(runId)).toBeTruthy();
    expect(countSessionsDelete()).toBe(0);
    expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(1);

    clearAgentRunContext(runId);

    await mod.testing.sweepOnceForTests();
    await flushSweepMicrotasks();

    expect(getAgentRunContext(runId)).toBeUndefined();
    expect(countSessionsDelete()).toBe(1);
    expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
  });
});
