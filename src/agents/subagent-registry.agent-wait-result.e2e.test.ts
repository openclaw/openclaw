import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const noop = () => {};
const MAIN_REQUESTER_SESSION_KEY = "agent:main:main";

const callGatewayMock = vi.fn(async (request: unknown) => {
  const method = (request as { method?: string }).method;
  if (method === "agent.wait") {
    return {
      status: "ok",
      startedAt: 100,
      endedAt: 200,
      result: "final answer from agent.wait",
    };
  }
  return {};
});
const onAgentEventMock = vi.fn((_handler: unknown) => noop);
const loadConfigMock = vi.fn(() => ({
  agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
}));
const loadRegistryMock = vi.fn(() => new Map());
const saveRegistryMock = vi.fn(() => {});
const announceSpy = vi.fn(async (_params?: Record<string, unknown>) => true);
const captureCompletionReplySpy = vi.fn(
  async (_sessionKey?: string) => undefined as string | undefined,
);

vi.mock("../gateway/call.js", () => ({
  callGateway: callGatewayMock,
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: onAgentEventMock,
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: loadConfigMock,
  };
});

vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: announceSpy,
  captureSubagentCompletionReply: captureCompletionReplySpy,
  extractAgentWaitResultText: (wait: { result?: unknown }) =>
    typeof wait?.result === "string" ? wait.result : undefined,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: loadRegistryMock,
  saveSubagentRegistryToDisk: saveRegistryMock,
}));

describe("subagent registry agent.wait result fallback", () => {
  let mod: typeof import("./subagent-registry.js");

  beforeAll(async () => {
    mod = await import("./subagent-registry.js");
  });

  beforeEach(() => {
    announceSpy.mockReset().mockResolvedValue(true);
    captureCompletionReplySpy.mockReset().mockResolvedValue(undefined);
    callGatewayMock.mockClear();
  });

  afterEach(() => {
    mod.resetSubagentRegistryForTests({ persist: false });
  });

  async function waitForAnnounce() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (announceSpy.mock.calls.length > 0) {
        return;
      }
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("announce did not fire in time");
  }

  it("uses agent.wait result when completion history is still empty", async () => {
    mod.registerSubagentRun({
      runId: "run-wait-result",
      childSessionKey: "agent:main:subagent:child-wait-result",
      requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
      requesterDisplayKey: "main",
      task: "wait result fallback",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });

    await waitForAnnounce();

    expect(captureCompletionReplySpy.mock.calls.length).toBeLessThanOrEqual(1);
    const run = mod
      .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
      .find((candidate) => candidate.runId === "run-wait-result");
    expect(run?.frozenResultText).toBe("final answer from agent.wait");

    const firstCall = announceSpy.mock.calls[0]?.[0] as { roundOneReply?: string } | undefined;
    expect(firstCall?.roundOneReply).toBe("final answer from agent.wait");
  });
});
