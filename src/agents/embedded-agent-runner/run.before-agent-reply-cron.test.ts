// Coverage for cron before_agent_reply hook handling before embedded attempts.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

function firstBeforeAgentReplyCall() {
  // Helper keeps assertions on the hook payload and context close to the tests
  // without leaking mock tuple details into every case.
  const call = mockedGlobalHookRunner.runBeforeAgentReply.mock.calls[0];
  if (!call) {
    throw new Error("expected before_agent_reply hook call");
  }
  return call;
}

function firstAttemptParams(): {
  agentHarnessTaskRuntimeScope?: {
    requesterSessionKey?: string;
    requesterOrigin?: Record<string, unknown>;
  };
  cleanupBundleMcpOnRunEnd?: boolean;
  modelRun?: boolean;
  promptMode?: string;
  promptCacheKey?: string;
  suppressLiveStreamOutput?: boolean;
} {
  const call = mockedRunEmbeddedAttempt.mock.calls[0] as
    | [
        {
          cleanupBundleMcpOnRunEnd?: boolean;
          modelRun?: boolean;
          promptMode?: string;
          promptCacheKey?: string;
          suppressLiveStreamOutput?: boolean;
        },
      ]
    | undefined;
  if (!call) {
    throw new Error("expected embedded attempt call");
  }
  return call[0];
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

describe("runEmbeddedAgent cron before_agent_reply seam", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
  });

  it("lets before_agent_reply claim cron runs before the embedded attempt starts", async () => {
    // Cron hooks can fully handle maintenance prompts before the model is
    // invoked, which avoids unnecessary prompt-cache and setup work.
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue({
      handled: true,
      reply: { text: "dreaming claimed" },
    });
    const onExecutionPhase = vi.fn();

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "cron",
      jobId: "cron-job-123",
      prompt: "__openclaw_memory_core_short_term_promotion_dream__",
      onExecutionPhase,
    });

    expect(mockedGlobalHookRunner.runBeforeAgentReply).toHaveBeenCalledTimes(1);
    expect(onExecutionPhase).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "before_agent_reply" }),
    );
    const [hookPayload, hookContext] = firstBeforeAgentReplyCall();
    expect(hookPayload).toEqual({
      cleanedBody: "__openclaw_memory_core_short_term_promotion_dream__",
    });
    expect(hookContext?.jobId).toBe("cron-job-123");
    expect(hookContext?.agentId).toBe("main");
    expect(hookContext?.sessionId).toBe("test-session");
    expect(hookContext?.sessionKey).toBe("test-key");
    expect(hookContext?.workspaceDir).toBe("/tmp/workspace");
    expect(hookContext?.trigger).toBe("cron");
    expect(hookContext?.senderId).toBeUndefined();
    expect(hookContext?.chatId).toBeUndefined();
    expect(hookContext?.channel).toBeUndefined();
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.text).toBe("dreaming claimed");
  });

  it("returns a silent payload when a cron hook claims without a reply body", async () => {
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue({
      handled: true,
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "cron",
    });

    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.text).toBe(SILENT_REPLY_TOKEN);
  });

  it("re-arms setup progress when a cron hook does not claim", async () => {
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue(undefined);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    const onExecutionPhase = vi.fn();

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "cron",
      onExecutionPhase,
    });

    expect(onExecutionPhase).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "before_agent_reply" }),
    );
    expect(onExecutionPhase).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "runtime_plugins" }),
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("does not invoke before_agent_reply for non-cron embedded runs", async () => {
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "user",
    });

    expect(mockedGlobalHookRunner.runBeforeAgentReply).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("forwards one-shot model-run flags into the embedded attempt", async () => {
    // Model-run mode is request-scoped; it must pass through to the first
    // attempt without becoming a persistent session setting.
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "user",
      modelRun: true,
      promptMode: "none",
    });

    const attemptParams = firstAttemptParams();
    expect(attemptParams.modelRun).toBe(true);
    expect(attemptParams.promptMode).toBe("none");
  });

  it("forwards one-shot bundle MCP cleanup into the embedded attempt", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      cleanupBundleMcpOnRunEnd: true,
    });

    expect(firstAttemptParams().cleanupBundleMcpOnRunEnd).toBe(true);
  });

  it("forwards prompt cache identity into the embedded attempt", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      promptCacheKey: "cron-cache-key",
    });

    expect(firstAttemptParams().promptCacheKey).toBe("cron-cache-key");
  });

  it("derives task runtime requester origins from explicit cron delivery routes", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "cron",
      messageChannel: " Discord ",
      agentAccountId: " acct-1 ",
      messageTo: "channel:12345",
      messageThreadId: "thread-9",
    });

    const scope = requireRecord(
      firstAttemptParams().agentHarnessTaskRuntimeScope,
      "agentHarnessTaskRuntimeScope",
    );
    expect(scope.requesterSessionKey).toBe("test-key");
    expect(scope.requesterOrigin).toEqual({
      channel: "discord",
      accountId: "acct-1",
      to: "channel:12345",
      threadId: "thread-9",
    });
  });

  it("keeps explicit requester origins ahead of derived cron delivery routes", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "cron",
      messageChannel: "discord",
      agentAccountId: "acct-route",
      messageTo: "channel:route",
      messageThreadId: "thread-route",
      requesterOrigin: {
        channel: "telegram",
        accountId: "acct-explicit",
        to: "telegram:123",
        threadId: "thread-explicit",
      },
    });

    const scope = requireRecord(
      firstAttemptParams().agentHarnessTaskRuntimeScope,
      "agentHarnessTaskRuntimeScope",
    );
    expect(scope.requesterOrigin).toEqual({
      channel: "telegram",
      accountId: "acct-explicit",
      to: "telegram:123",
      threadId: "thread-explicit",
    });
  });

  it("forwards suppressed live stream output into the embedded attempt", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      suppressLiveStreamOutput: true,
    });

    expect(firstAttemptParams().suppressLiveStreamOutput).toBe(true);
  });
});
