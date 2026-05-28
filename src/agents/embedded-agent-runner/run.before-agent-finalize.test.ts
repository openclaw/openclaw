import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

function finalAnswerAttempt(text: string): EmbeddedRunAttemptResult {
  return makeAttemptResult({
    assistantTexts: [text],
    lastAssistant: {
      stopReason: "stop",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "text", text }],
    } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    messagesSnapshot: [
      {
        role: "assistant",
        content: [{ type: "text", text }],
      } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
    ],
  });
}

function attemptCall(index: number): {
  prompt?: string;
  suppressNextUserMessagePersistence?: boolean;
} {
  const call = mockedRunEmbeddedAttempt.mock.calls[index];
  if (!call) {
    throw new Error(`Expected embedded attempt call ${index}`);
  }
  return call[0] as { prompt?: string; suppressNextUserMessagePersistence?: boolean };
}

describe("runEmbeddedAgent before_agent_finalize", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_finalize",
    );
  });

  it("runs the hook before accepting a normal embedded final answer", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(finalAnswerAttempt("First answer."));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-before-finalize-continue",
    });

    expect(mockedGlobalHookRunner.runBeforeAgentFinalize).toHaveBeenCalledTimes(1);
    expect(mockedGlobalHookRunner.runBeforeAgentFinalize).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-before-finalize-continue",
        sessionId: "test-session",
        sessionKey: "test-key",
        provider: "openai",
        model: "gpt-5.5",
        stopHookActive: false,
        lastAssistantMessage: "First answer.",
      }),
      expect.objectContaining({
        runId: "run-before-finalize-continue",
        sessionId: "test-session",
        sessionKey: "test-key",
        modelProviderId: "openai",
        modelId: "gpt-5.5",
      }),
    );
  });

  it("turns a revise decision into one more hidden continuation", async () => {
    mockedGlobalHookRunner.runBeforeAgentFinalize
      .mockResolvedValueOnce({
        action: "revise",
        reason: "Tighten the final wording.",
        retry: {
          instruction: "Mention the validated behavior.",
          idempotencyKey: "wording",
          maxAttempts: 1,
        },
      })
      .mockResolvedValueOnce({ action: "continue" });
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(finalAnswerAttempt("First answer."))
      .mockResolvedValueOnce(finalAnswerAttempt("Revised answer."));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-before-finalize-revise",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(attemptCall(1).prompt).toContain("Tighten the final wording.");
    expect(attemptCall(1).prompt).toContain("Mention the validated behavior.");
    expect(attemptCall(1).prompt).not.toContain("hello");
    expect(attemptCall(1).suppressNextUserMessagePersistence).toBe(true);
  });

  it("does not retry a revise decision after potential side effects", async () => {
    mockedGlobalHookRunner.runBeforeAgentFinalize.mockResolvedValueOnce({
      action: "revise",
      reason: "Please revise.",
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Sent."],
        didSendViaMessagingTool: true,
        lastAssistant: {
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.5",
          content: [{ type: "text", text: "Sent." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-before-finalize-side-effect",
    });

    expect(mockedGlobalHookRunner.runBeforeAgentFinalize).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });
});
