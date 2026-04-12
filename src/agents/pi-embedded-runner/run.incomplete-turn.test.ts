import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedClassifyFailoverReason,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import {
  extractPlanningOnlyPlanDetails,
  hasContinuationIntent,
  hasCompletionLanguage,
  isLikelyExecutionAckPrompt,
  resolveAckExecutionFastPathInstruction,
  resolvePlanningOnlyRetryLimit,
  resolvePlanningOnlyRetryInstruction,
  STRICT_AGENTIC_BLOCKED_TEXT,
  resolveReplayInvalidFlag,
  resolveRunLivenessState,
} from "./run/incomplete-turn.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

describe("runEmbeddedPiAgent incomplete-turn safety", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
  });

  it("warns before retrying when an incomplete turn already sent a message", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        toolMetas: [],
        didSendViaMessagingTool: true,
        lastAssistant: {
          stopReason: "toolUse",
          errorMessage: "internal retry interrupted tool execution",
          provider: "openai",
          model: "mock-1",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-incomplete-turn-messaging-warning",
    });

    expect(mockedClassifyFailoverReason).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("verify before retrying");
  });

  it("uses explicit agentId without a session key before surfacing the strict-agentic blocked state", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      sessionKey: undefined,
      agentId: "research",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-strict-agentic-explicit-agent",
      config: {
        agents: {
          defaults: {
            embeddedPi: {
              executionContract: "default",
            },
          },
          list: [
            { id: "main" },
            {
              id: "research",
              embeddedPi: {
                executionContract: "strict-agentic",
              },
            },
          ],
        },
      } as OpenClawConfig,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(result.payloads).toEqual([
      {
        text: STRICT_AGENTIC_BLOCKED_TEXT,
        isError: true,
      },
    ]);
  });

  it("detects replay-safe planning-only GPT turns", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    });

    expect(retryInstruction).toContain("Do not restate the plan");
  });

  it("detects structured bullet-only plans with intent cues as planning-only GPT turns", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [
          "Plan:\n1. I'll inspect the code\n2. I'll patch the issue\n3. I'll run the tests",
        ],
      }),
    });

    expect(retryInstruction).toContain("Do not restate the plan");
  });

  it("does not misclassify ordinary bullet summaries as planning-only", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["1. Parser refactor\n2. Regression coverage\n3. Docs cleanup"],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("does not treat a bare plan heading as planning-only without an intent cue", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Plan:\n1. Parser refactor\n2. Regression coverage\n3. Docs cleanup"],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("does not retry planning-only detection after tool activity", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
        toolMetas: [{ toolName: "bash", meta: "ls" }],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("does not retry planning-only detection after an item has started", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
        itemLifecycle: {
          startedCount: 1,
          completedCount: 0,
          activeCount: 1,
        },
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("treats update_plan as non-progress for planning-only retry detection", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll capture the steps, then take the first tool action."],
        toolMetas: [{ toolName: "update_plan", meta: "status=updated" }],
        itemLifecycle: {
          startedCount: 1,
          completedCount: 1,
          activeCount: 0,
        },
      }),
    });

    expect(retryInstruction).toContain("Act now");
  });

  it("allows one retry by default and two retries for strict-agentic runs", () => {
    expect(resolvePlanningOnlyRetryLimit("default")).toBe(1);
    expect(resolvePlanningOnlyRetryLimit("strict-agentic")).toBe(2);
    expect(STRICT_AGENTIC_BLOCKED_TEXT).toContain("plan-only turns");
    expect(STRICT_AGENTIC_BLOCKED_TEXT).toContain("advanced the task");
  });

  it("detects short execution approval prompts", () => {
    expect(isLikelyExecutionAckPrompt("ok do it")).toBe(true);
    expect(isLikelyExecutionAckPrompt("go ahead")).toBe(true);
    expect(isLikelyExecutionAckPrompt("Can you do it?")).toBe(false);
  });

  it("detects short execution approvals across requested locales", () => {
    expect(isLikelyExecutionAckPrompt("نفذها")).toBe(true);
    expect(isLikelyExecutionAckPrompt("mach es")).toBe(true);
    expect(isLikelyExecutionAckPrompt("進めて")).toBe(true);
    expect(isLikelyExecutionAckPrompt("fais-le")).toBe(true);
    expect(isLikelyExecutionAckPrompt("adelante")).toBe(true);
    expect(isLikelyExecutionAckPrompt("vai em frente")).toBe(true);
    expect(isLikelyExecutionAckPrompt("진행해")).toBe(true);
  });

  it("adds an ack-turn fast-path instruction for GPT action turns", () => {
    const instruction = resolveAckExecutionFastPathInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "go ahead",
    });

    expect(instruction).toContain("Do not recap or restate the plan");
  });

  it("extracts structured steps from planning-only narration", () => {
    expect(
      extractPlanningOnlyPlanDetails(
        "I'll inspect the code. Then I'll patch the issue. Finally I'll run tests.",
      ),
    ).toEqual({
      explanation: "I'll inspect the code. Then I'll patch the issue. Finally I'll run tests.",
      steps: ["I'll inspect the code.", "Then I'll patch the issue.", "Finally I'll run tests."],
    });
  });

  it("marks incomplete-turn retries as replay-invalid abandoned runs", () => {
    const attempt = makeAttemptResult({
      assistantTexts: [],
      lastAssistant: {
        stopReason: "toolUse",
        provider: "openai",
        model: "gpt-5.4",
        content: [],
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    });
    const incompleteTurnText = "⚠️ Agent couldn't generate a response. Please try again.";

    expect(resolveReplayInvalidFlag({ attempt, incompleteTurnText })).toBe(true);
    expect(
      resolveRunLivenessState({
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
        incompleteTurnText,
      }),
    ).toBe("abandoned");
  });

  it("marks compaction-timeout retries as paused and replay-invalid", () => {
    const attempt = makeAttemptResult({
      promptErrorSource: "compaction",
      timedOutDuringCompaction: true,
    });

    expect(resolveReplayInvalidFlag({ attempt })).toBe(true);
    expect(
      resolveRunLivenessState({
        payloadCount: 0,
        aborted: true,
        timedOut: true,
        attempt,
      }),
    ).toBe("paused");
  });
});

describe("resolvePlanningOnlyRetryInstruction single-action loophole", () => {
  const openaiParams = { provider: "openai", modelId: "gpt-5.4" };

  function makeAttemptWithTools(
    toolNames: string[],
    assistantText: string,
  ): Parameters<typeof resolvePlanningOnlyRetryInstruction>[0]["attempt"] {
    return {
      toolMetas: toolNames.map((name) => ({ toolName: name })),
      assistantTexts: [assistantText],
      lastAssistant: { stopReason: "stop" },
      itemLifecycle: { startedCount: toolNames.length },
      replayMetadata: { hadPotentialSideEffects: false },
      clientToolCall: null,
      yieldDetected: false,
      didSendDeterministicApprovalPrompt: false,
      didSendViaMessagingTool: false,
      lastToolError: null,
    } as unknown as Parameters<typeof resolvePlanningOnlyRetryInstruction>[0]["attempt"];
  }

  it("retries when exactly 1 non-plan tool call + planning prose is detected", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "I'll analyze the structure next."),
    });
    expect(result).not.toBeNull();
  });

  it("does NOT retry when 2+ non-plan tool calls are present", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read", "write"], "I'll verify the output."),
    });
    expect(result).toBeNull();
  });

  it("does NOT retry when 1 tool call + completion language", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "Done — the file looks correct."),
    });
    expect(result).toBeNull();
  });

  it("does NOT retry 1 tool call + 'let me know' (handoff, not continuation)", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "Let me know if you need anything else."),
    });
    expect(result).toBeNull();
  });
});

describe("hasContinuationIntent", () => {
  it("detects promise patterns like I'll, going to, let me + verb", () => {
    expect(hasContinuationIntent(["I'll read the next file."])).toBe(true);
    expect(hasContinuationIntent(["Going to check the test results."])).toBe(true);
    expect(hasContinuationIntent(["Let me fix that issue."])).toBe(true);
    expect(hasContinuationIntent(["Next, I'll verify the output."])).toBe(true);
  });

  it("does not match 'let me know' (completion handoff, not continuation)", () => {
    expect(hasContinuationIntent(["Let me know if you need anything else."])).toBe(false);
    expect(hasContinuationIntent(["Let me know if this works for you."])).toBe(false);
  });

  it("returns false for empty or very long text", () => {
    expect(hasContinuationIntent([])).toBe(false);
    expect(hasContinuationIntent([""])).toBe(false);
    expect(hasContinuationIntent(["x".repeat(1501)])).toBe(false);
  });

  it("returns false for text without promise patterns", () => {
    expect(hasContinuationIntent(["The file contains the expected output."])).toBe(false);
    expect(hasContinuationIntent(["Here are the results of the analysis."])).toBe(false);
  });
});

describe("hasCompletionLanguage", () => {
  it("detects definitive completion signals", () => {
    expect(hasCompletionLanguage(["Done."])).toBe(true);
    expect(hasCompletionLanguage(["I've finished the changes."])).toBe(true);
    expect(hasCompletionLanguage(["Task complete."])).toBe(true);
    expect(hasCompletionLanguage(["All set — the fix is in place."])).toBe(true);
    expect(hasCompletionLanguage(["The refactoring is completed."])).toBe(true);
  });

  it("does not match progress verbs like found, ran, updated", () => {
    expect(hasCompletionLanguage(["I found the bug in the config."])).toBe(false);
    expect(hasCompletionLanguage(["I ran the tests and they pass."])).toBe(false);
    expect(hasCompletionLanguage(["Updated the dependency."])).toBe(false);
  });

  it("returns false for empty text", () => {
    expect(hasCompletionLanguage([])).toBe(false);
    expect(hasCompletionLanguage([""])).toBe(false);
  });
});
