import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  hasCommittedMessagingToolDeliveryEvidence,
  hasCommittedMessagingToolResultDetails,
  hasSideEffectProgressEvidence,
  hasVisibleOutboundDeliveryEvidence,
} from "./delivery-evidence.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedClassifyFailoverReason,
  mockedBuildEmbeddedRunPayloads,
  mockedGlobalHookRunner,
  mockedIsFailoverAssistantError,
  mockedIsRateLimitAssistantError,
  mockedLog,
  mockedMarkAuthProfileFailure,
  mockedRunEmbeddedAttempt,
  mockedResolveModelAsync,
  mockedSleepWithAbort,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import {
  ACK_EXECUTION_FAST_PATH_INSTRUCTION,
  buildAttemptReplayMetadata,
  DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT,
  DEFAULT_REASONING_ONLY_RETRY_LIMIT,
  EMPTY_RESPONSE_RETRY_INSTRUCTION,
  extractPlanningOnlyPlanDetails,
  isLikelyExecutionAckPrompt,
  PLANNING_ONLY_RETRY_INSTRUCTION,
  REASONING_ONLY_RETRY_INSTRUCTION,
  resolveAckExecutionFastPathInstruction,
  resolveEmptyResponseRetryInstruction,
  resolvePlanningOnlyRetryLimit,
  resolvePlanningOnlyRetryInstruction,
  isIncompleteTerminalAssistantTurn,
  PLANNING_ONLY_BLOCKED_TEXT,
  resolveIncompleteTurnPayloadText as resolveIncompleteTurnPayloadTextCore,
  resolveReasoningOnlyRetryInstruction,
  resolvePlanningOnlyBlockedPayloadText,
  STRICT_AGENTIC_BLOCKED_TEXT,
  resolveReplayInvalidFlag,
  resolveRunLivenessState,
  resolveSilentToolResultReplyPayload,
  resolveTerminalToolResultReplyPayload,
  shouldRetryMissingAssistantTurn,
  shouldTreatEmptyAssistantReplyAsSilent,
} from "./run/incomplete-turn.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

function resolveIncompleteTurnPayloadText(
  params: Omit<Parameters<typeof resolveIncompleteTurnPayloadTextCore>[0], "externalAbort"> & {
    externalAbort?: boolean;
  },
): string | null {
  return resolveIncompleteTurnPayloadTextCore({ externalAbort: false, ...params });
}

describe("runEmbeddedAgent incomplete-turn safety", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
  });

  function warnMessages(): string[] {
    return mockedLog.warn.mock.calls.map(([message]) => String(message));
  }

  function expectWarnMessageWith(text: string): void {
    expect(warnMessages().join("\n")).toContain(text);
  }

  function expectNoWarnMessageWith(text: string): void {
    expect(warnMessages().join("\n")).not.toContain(text);
  }

  function runAttemptCall(index: number): { prompt?: string } {
    const call = mockedRunEmbeddedAttempt.mock.calls[index];
    if (!call) {
      throw new Error(`Expected run embedded attempt call ${index}`);
    }
    return call[0] as { prompt?: string };
  }

  it("emits the before_agent_run hook block message as the agent payload", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        promptError: new Error("Blocked by before-run policy."),
        promptErrorSource: "hook:before_agent_run",
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-before-agent-run-hook-block",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([{ text: "Blocked by before-run policy.", isError: true }]);
    expect(result.meta?.finalAssistantVisibleText).toBe("Blocked by before-run policy.");
    expect(result.meta?.finalAssistantRawText).toBe("Blocked by before-run policy.");
    expect(result.meta?.finalPromptText).toBeUndefined();
    expect(result.meta?.error).toEqual({
      kind: "hook_block",
      message: "Blocked by before-run policy.",
    });
    expect(result.meta?.livenessState).toBe("blocked");
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

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-4.1",
      runId: "run-incomplete-turn-messaging-warning",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(mockedClassifyFailoverReason).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("verify before retrying");
  });

  it("keeps replay-safety warning instead of tool fallback after mutating tool work", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const toolMetas = [{ toolName: "write", mutatingAction: true }];
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params: unknown) => {
      const attemptParams = params as {
        onToolOutcome?: (observation: {
          toolName: string;
          argsHash: string;
          resultHash: string;
          resultText?: string;
        }) => void;
      };
      attemptParams.onToolOutcome?.({
        toolName: "write",
        argsHash: "current",
        resultHash: "write-result",
        resultText: "updated report.md",
      });
      return makeAttemptResult({
        assistantTexts: [],
        toolMetas,
        replayMetadata: buildAttemptReplayMetadata({
          toolMetas,
          didSendViaMessagingTool: false,
          messagingToolSentTexts: [],
          messagingToolSentMediaUrls: [],
          successfulCronAdds: 0,
        }),
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.5",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-mutating-tool-incomplete-no-terminal-fallback",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([
      {
        text: "⚠️ Agent couldn't generate a response. Note: some tool actions may have already been executed — please verify before retrying.",
        isError: true,
      },
    ]);
    expect(JSON.stringify(result.payloads)).not.toContain("write completed");
  });

  it("surfaces internal aborts after tool-use as visible incomplete-turn failures", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        aborted: true,
        externalAbort: false,
        assistantTexts: [],
        toolMetas: [{ toolName: "web_search", meta: "query=next voice note" }],
        lastAssistant: {
          role: "assistant",
          stopReason: "toolUse",
          provider: "openai",
          model: "gpt-5.5",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-internal-abort-tool-use-incomplete",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([
      { text: "⚠️ Agent couldn't generate a response. Please try again.", isError: true },
    ]);
    expect(result.meta?.livenessState).toBe("abandoned");
  });

  it("surfaces a terminal error when finalization has no payload or delivery evidence", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastToolError: {
          toolName: "write",
          meta: "path=report.md",
          error: "permission denied",
          mutatingAction: true,
        },
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.5",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-non-deliverable-terminal-guard",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([
      { text: "⚠️ Agent couldn't generate a response. Please try again.", isError: true },
    ]);
    expect(result.meta.livenessState).toBe("abandoned");
    expect(result.meta.replayInvalid).toBe(true);
    expectWarnMessageWith("non-deliverable terminal turn detected");
  });

  it.each([
    {
      name: "successful cron add",
      attempt: { successfulCronAdds: 1 },
    },
    {
      name: "committed messaging target",
      attempt: {
        messagingToolSentTargets: [{ tool: "message", provider: "discord", to: "channel-1" }],
      },
    },
  ])("leaves $name side-effect progress payload-free for the outer runner", async ({ attempt }) => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        ...attempt,
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.5",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: `run-side-effect-progress-${attempt.successfulCronAdds ? "cron" : "target"}`,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toBeUndefined();
    expectNoWarnMessageWith("non-deliverable terminal turn detected");
  });

  it("synthesizes a silent cron payload from a trailing current-attempt NO_REPLY tool result", () => {
    const payload = resolveSilentToolResultReplyPayload({
      isCronTrigger: true,
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "exec" }],
        messagesSnapshot: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "NO_REPLY" }],
            details: { aggregated: "NO_REPLY" },
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
          {
            role: "assistant",
            stopReason: "stop",
            provider: "openai",
            model: "gpt-5.4",
            content: [],
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
        ],
      }),
    });

    expect(payload).toEqual({ text: "NO_REPLY" });
  });

  it("does not expose a trailing NO_REPLY tool result outside cron", () => {
    const payload = resolveTerminalToolResultReplyPayload({
      isCronTrigger: false,
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "exec" }],
        messagesSnapshot: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "NO_REPLY" }],
            details: { aggregated: "NO_REPLY" },
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
          {
            role: "assistant",
            stopReason: "stop",
            provider: "openai",
            model: "gpt-5.4",
            content: [],
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
        ],
      }),
    });

    expect(payload).toBeNull();
  });

  it("synthesizes a neutral terminal reply from trailing undeclared tool output", () => {
    const payload = resolveTerminalToolResultReplyPayload({
      isCronTrigger: false,
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "exec" }],
        messagesSnapshot: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "TOKEN=secret-value\nstatus: ok" }],
            details: { aggregated: "TOKEN=secret-value\nstatus: ok" },
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
          {
            role: "assistant",
            stopReason: "stop",
            provider: "openai",
            model: "gpt-5.4",
            content: [],
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
        ],
      }),
    });

    expect(payload).toEqual({
      text:
        "exec completed, but the model did not provide a final answer. " +
        "No user-facing result text was provided.",
    });
  });

  it("does not reuse an older tool result when a newer tool call is pending", () => {
    const payload = resolveTerminalToolResultReplyPayload({
      isCronTrigger: false,
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "exec" }],
        messagesSnapshot: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "first command completed" }],
            details: { aggregated: "first command completed" },
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
          {
            role: "assistant",
            stopReason: "toolUse",
            provider: "openai",
            model: "gpt-5.4",
            content: [{ type: "toolCall", id: "call-b", name: "exec", arguments: {} }],
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
        ],
      }),
    });

    expect(payload).toBeNull();
  });

  it("does not synthesize a completed terminal reply from failed trailing tool output", () => {
    const payload = resolveTerminalToolResultReplyPayload({
      isCronTrigger: false,
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "exec" }],
        messagesSnapshot: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "exit code 1" }],
            details: { status: "failed", aggregated: "exit code 1" },
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
          {
            role: "assistant",
            stopReason: "stop",
            provider: "openai",
            model: "gpt-5.4",
            content: [],
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
        ],
      }),
    });

    expect(payload).toBeNull();
  });

  it.each(["blocked", "cancelled", "suppressed"])(
    "does not synthesize a completed terminal reply from %s trailing tool output",
    (status) => {
      const payload = resolveTerminalToolResultReplyPayload({
        isCronTrigger: false,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt: makeAttemptResult({
          assistantTexts: [],
          toolMetas: [{ toolName: "exec" }],
          messagesSnapshot: [
            {
              role: "toolResult",
              content: [{ type: "text", text: `${status} by policy` }],
              details: { status },
            } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
            {
              role: "assistant",
              stopReason: "stop",
              provider: "openai",
              model: "gpt-5.4",
              content: [],
            } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
          ],
        }),
      });

      expect(payload).toBeNull();
    },
  );

  it.each([
    { ok: false },
    { success: false },
    { deliveryStatus: "failed" },
    { delivery_status: "failed" },
  ])("does not synthesize a completed terminal reply from explicit failure details", (details) => {
    const payload = resolveTerminalToolResultReplyPayload({
      isCronTrigger: false,
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "exec" }],
        messagesSnapshot: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "operation failed" }],
            details,
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
          {
            role: "assistant",
            stopReason: "stop",
            provider: "openai",
            model: "gpt-5.4",
            content: [],
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
        ],
      }),
    });

    expect(payload).toBeNull();
  });

  it.each([
    { ok: true, result: { status: "failed" } },
    { success: true, result: { dryRun: true } },
  ])(
    "does not synthesize a completed terminal reply from nested non-delivery details",
    (details) => {
      const payload = resolveTerminalToolResultReplyPayload({
        isCronTrigger: false,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt: makeAttemptResult({
          assistantTexts: [],
          toolMetas: [{ toolName: "exec" }],
          messagesSnapshot: [
            {
              role: "toolResult",
              content: [{ type: "text", text: "operation completed" }],
              details,
            } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
            {
              role: "assistant",
              stopReason: "stop",
              provider: "openai",
              model: "gpt-5.4",
              content: [],
            } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
          ],
        }),
      });

      expect(payload).toBeNull();
    },
  );

  it("does not reuse an older NO_REPLY tool result without current-attempt tool activity", () => {
    const payload = resolveSilentToolResultReplyPayload({
      isCronTrigger: true,
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        toolMetas: [],
        messagesSnapshot: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "NO_REPLY" }],
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
          {
            role: "user",
            content: [{ type: "text", text: "Current cron prompt" }],
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
          {
            role: "assistant",
            stopReason: "stop",
            provider: "openai",
            model: "gpt-5.4",
            content: [],
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
        ],
      }),
    });

    expect(payload).toBeNull();
  });

  it("treats exact NO_REPLY tool output as a quiet cron success when the final assistant is empty", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "exec" }],
        messagesSnapshot: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "NO_REPLY" }],
            details: { aggregated: "NO_REPLY" },
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
          {
            role: "assistant",
            stopReason: "stop",
            provider: "openai",
            model: "gpt-5.4",
            content: [],
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
        ],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.4",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "cron",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-cron-no-reply-empty-final",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([{ text: "NO_REPLY" }]);
    expect(result.meta.livenessState).toBe("working");
    expectNoWarnMessageWith("incomplete turn detected");
  });

  it("does not present undeclared tool output when the final assistant is empty after tool work", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "exec" }],
        messagesSnapshot: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "API_KEY=secret-value\nstdout ok" }],
            details: { aggregated: "API_KEY=secret-value\nstdout ok" },
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
          {
            role: "assistant",
            stopReason: "stop",
            provider: "openai",
            model: "gpt-5.4",
            content: [],
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
        ],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.4",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "manual",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-tool-result-empty-final",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([
      {
        text:
          "exec completed, but the model did not provide a final answer. " +
          "No user-facing result text was provided.",
      },
    ]);
    expect(result.meta.livenessState).toBe("working");
    expectNoWarnMessageWith("incomplete turn detected");
  });

  it("does not promote pre-tool narration when the final assistant is empty", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params: unknown) => {
      const attemptParams = params as {
        onToolOutcome?: (observation: {
          toolName: string;
          argsHash: string;
          resultHash: string;
          resultText?: string;
        }) => void;
      };
      attemptParams.onToolOutcome?.({
        toolName: "status",
        argsHash: "current",
        resultHash: "status-result",
        resultText: "healthy",
      });
      return makeAttemptResult({
        assistantTexts: ["The endpoint should be healthy."],
        toolMetas: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "completed",
          provider: "openai",
          model: "gpt-5.4",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      prompt: "Check the endpoint status.",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-pre-tool-narration-prefers-tool-fallback",
    });

    expect(result.payloads).toEqual([
      {
        text:
          "status completed, but the model did not provide a final answer. " +
          "No user-facing result text was provided.",
      },
    ]);
    expect(JSON.stringify(result.payloads)).not.toContain("should be healthy");
  });

  it("does not return opted-out tool output when the final assistant is empty", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params: unknown) => {
      const attemptParams = params as {
        onToolOutcome?: (observation: {
          toolName: string;
          argsHash: string;
          resultHash: string;
          resultText?: string;
          terminalResultFallback?: { mode: "none" };
        }) => void;
      };
      attemptParams.onToolOutcome?.({
        toolName: "secrets_lookup",
        argsHash: "current",
        resultHash: "secret-result",
        resultText: "internal customer payload",
        terminalResultFallback: { mode: "none" },
      });
      return makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "secrets_lookup" }],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.4",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "manual",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-tool-result-opted-out-empty-final",
    });

    expect(result.payloads).toEqual([
      {
        text: "⚠️ Agent couldn't generate a response. Note: some tool actions may have already been executed — please verify before retrying.",
        isError: true,
      },
    ]);
    expect(JSON.stringify(result.payloads)).not.toContain("internal customer payload");
    expect(result.meta.livenessState).toBe("abandoned");
  });

  it("prefers observed opt-out metadata over trailing tool output", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params: unknown) => {
      const attemptParams = params as {
        onToolOutcome?: (observation: {
          toolName: string;
          argsHash: string;
          resultHash: string;
          resultText?: string;
          terminalResultFallback?: { mode: "none" };
        }) => void;
      };
      attemptParams.onToolOutcome?.({
        toolName: "secrets_lookup",
        argsHash: "current",
        resultHash: "secret-result",
        resultText: "internal customer payload",
        terminalResultFallback: { mode: "none" },
      });
      return makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "secrets_lookup" }],
        messagesSnapshot: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "internal customer payload" }],
            details: { aggregated: "internal customer payload" },
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
          {
            role: "assistant",
            stopReason: "stop",
            provider: "openai",
            model: "gpt-5.4",
            content: [],
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
        ],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.4",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "manual",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-tool-result-opted-out-message-snapshot",
    });

    expect(result.payloads).toEqual([
      {
        text: "⚠️ Agent couldn't generate a response. Note: some tool actions may have already been executed — please verify before retrying.",
        isError: true,
      },
    ]);
    expect(JSON.stringify(result.payloads)).not.toContain("internal customer payload");
  });

  it("surfaces a tool-declared terminal result when a tool loop is aborted", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params: unknown) => {
      const attemptParams = params as {
        abortSignal?: AbortSignal;
        onToolOutcome?: (observation: {
          toolName: string;
          argsHash: string;
          resultHash: string;
          resultText?: string;
          terminalResultFallback?: { mode: "safe_text"; prefix?: string };
          didSendViaMessagingTool?: boolean;
          messagingToolSentTexts?: string[];
          messagingToolSentMediaUrls?: string[];
          messagingToolSentTargets?: Array<Record<string, unknown>>;
          mutatingAction?: boolean;
          blockedReason?: string;
          blockedMessage?: string;
        }) => void;
      };
      attemptParams.onToolOutcome?.({
        toolName: "message",
        argsHash: "current",
        resultHash: "status-result",
        resultText: "sent",
        terminalResultFallback: { mode: "safe_text", prefix: "Status:" },
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["sent"],
        messagingToolSentMediaUrls: ["file:///tmp/render.png"],
        mutatingAction: true,
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "discord",
            to: "channel-1",
            mediaUrl: "file:///tmp/render.png",
          },
        ],
      });
      attemptParams.onToolOutcome?.({
        toolName: "message",
        argsHash: "current",
        resultHash: "blocked-result",
        blockedReason: "tool-loop",
        blockedMessage:
          "CRITICAL: You are alternating between repeated tool-call patterns with no progress.",
      });
      expect(attemptParams.abortSignal?.aborted).toBe(true);
      throw new Error("Request was aborted.");
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "xai",
      model: "grok-composer-2.5-fast",
      runId: "run-tool-loop-declared-fallback",
    });

    expect(result.payloads).toEqual([
      {
        text: "Status:\nsent",
      },
      {
        text: "⚠️ Some tool actions may have already been executed — please verify before retrying.",
        isError: true,
      },
    ]);
    expect(result.meta.livenessState).toBe("blocked");
    expect(result.meta.replayInvalid).toBe(true);
    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTexts).toEqual(["sent"]);
    expect(result.messagingToolSentMediaUrls).toEqual(["file:///tmp/render.png"]);
    expect(result.messagingToolSentTargets).toEqual([
      {
        tool: "message",
        provider: "discord",
        to: "channel-1",
        mediaUrl: "file:///tmp/render.png",
      },
    ]);
    expect(result.meta.completion).toEqual({
      stopReason: "tool_loop_abort",
      finishReason: "tool_loop_abort",
    });
  });

  it("drains late parallel tool outcomes before returning a loop-abort fallback", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const terminalDrain = vi.fn();
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params: unknown) => {
      const attemptParams = params as {
        abortSignal?: AbortSignal;
        onTerminalDrainReady?: (drain: () => Promise<void>) => void;
        onToolOutcome?: (observation: {
          toolName: string;
          argsHash: string;
          resultHash: string;
          resultText?: string;
          terminalResultFallback?: { mode: "safe_text"; prefix?: string };
          failed?: boolean;
          mutatingAction?: boolean;
          blockedReason?: string;
          blockedMessage?: string;
        }) => void;
      };
      attemptParams.onTerminalDrainReady?.(async () => {
        terminalDrain();
        attemptParams.onToolOutcome?.({
          toolName: "write",
          argsHash: "late-sibling",
          resultHash: "failed",
          failed: true,
          mutatingAction: true,
        });
      });
      attemptParams.onToolOutcome?.({
        toolName: "status",
        argsHash: "current",
        resultHash: "status-result",
        resultText: "healthy",
        terminalResultFallback: { mode: "safe_text", prefix: "Status:" },
      });
      attemptParams.onToolOutcome?.({
        toolName: "status",
        argsHash: "current",
        resultHash: "blocked-result",
        blockedReason: "tool-loop",
        blockedMessage: "CRITICAL: repeated status calls.",
      });
      expect(attemptParams.abortSignal?.aborted).toBe(true);
      throw new Error("Request was aborted.");
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "xai",
      model: "grok-composer-2.5-fast",
      runId: "run-tool-loop-late-parallel-outcome",
    });

    expect(terminalDrain).toHaveBeenCalledOnce();
    expect(result.payloads).toEqual([
      {
        text: "I stopped because repeated tool calls did not make progress. No user-facing result text was provided.",
        isError: true,
      },
      {
        text: "⚠️ Some tool actions may have already been executed — please verify before retrying.",
        isError: true,
      },
    ]);
  });

  it("surfaces a known read-only tool terminal result when a tool loop resolves after abort", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const setTerminalLifecycleMeta = vi.fn();
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params: unknown) => {
      const attemptParams = params as {
        abortSignal?: AbortSignal;
        onToolOutcome?: (observation: {
          toolName: string;
          argsHash: string;
          resultHash: string;
          resultText?: string;
          terminalResultFallback?: { mode: "safe_text"; prefix?: string };
          blockedReason?: string;
          blockedMessage?: string;
        }) => void;
      };
      attemptParams.onToolOutcome?.({
        toolName: "web_fetch",
        argsHash: "current",
        resultHash: "status-result",
        resultText: "healthy",
        terminalResultFallback: { mode: "safe_text", prefix: "Status:" },
      });
      attemptParams.onToolOutcome?.({
        toolName: "web_fetch",
        argsHash: "current",
        resultHash: "blocked-result",
        blockedReason: "tool-loop",
        blockedMessage:
          "CRITICAL: You are alternating between repeated tool-call patterns with no progress.",
      });
      expect(attemptParams.abortSignal?.aborted).toBe(true);
      return makeAttemptResult({
        aborted: true,
        externalAbort: false,
        assistantTexts: [],
        toolMetas: [{ toolName: "web_fetch" }],
        setTerminalLifecycleMeta,
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "xai",
      model: "grok-composer-2.5-fast",
      runId: "run-tool-loop-declared-fallback-resolved",
    });

    expect(result.payloads).toEqual([
      {
        text: "Status:\nhealthy",
      },
    ]);
    expect(result.meta.livenessState).toBe("blocked");
    expect(result.meta.completion).toEqual({
      stopReason: "tool_loop_abort",
      finishReason: "tool_loop_abort",
    });
    expect(setTerminalLifecycleMeta).toHaveBeenCalledWith({
      replayInvalid: true,
      livenessState: "blocked",
      stopReason: "tool_loop_abort",
      aborted: true,
    });
  });

  it("preserves live replay state when a loop abort has an unresolved tool failure", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const sentTarget = { tool: "message", provider: "discord", to: "channel-1" };
    const setTerminalLifecycleMeta = vi.fn();
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params: unknown) => {
      const attemptParams = params as {
        abortSignal?: AbortSignal;
        onTerminalLifecycleMetaReady?: (setter: typeof setTerminalLifecycleMeta) => void;
        onAttemptStateChange?: (state: {
          replayState: { replayInvalid: boolean; hadPotentialSideEffects: boolean };
          didSendViaMessagingTool: boolean;
          didDeliverSourceReplyViaMessageTool: boolean;
          didSendDeterministicApprovalPrompt: boolean;
          messagingToolSentTexts: string[];
          messagingToolSentMediaUrls: string[];
          messagingToolSentTargets: Array<Record<string, unknown>>;
          messagingToolSourceReplyPayloads: Array<{ text: string }>;
          acceptedSessionSpawns: Array<{ runId: string; childSessionKey: string }>;
          successfulCronAdds: number;
        }) => void;
        onToolOutcome?: (observation: {
          toolName: string;
          argsHash: string;
          resultHash: string;
          failed?: boolean;
          mutatingAction?: boolean;
          blockedReason?: string;
          blockedMessage?: string;
        }) => void;
      };
      attemptParams.onTerminalLifecycleMetaReady?.(setTerminalLifecycleMeta);
      attemptParams.onAttemptStateChange?.({
        replayState: { replayInvalid: true, hadPotentialSideEffects: true },
        didSendViaMessagingTool: true,
        didDeliverSourceReplyViaMessageTool: false,
        didSendDeterministicApprovalPrompt: false,
        messagingToolSentTexts: ["already sent"],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [sentTarget],
        messagingToolSourceReplyPayloads: [],
        acceptedSessionSpawns: [],
        successfulCronAdds: 0,
      });
      attemptParams.onToolOutcome?.({
        toolName: "message",
        argsHash: "send",
        resultHash: "failed",
        failed: true,
        mutatingAction: true,
      });
      attemptParams.onToolOutcome?.({
        toolName: "message",
        argsHash: "send",
        resultHash: "blocked",
        blockedReason: "tool-loop",
        blockedMessage: "CRITICAL: repeated message calls.",
      });
      expect(attemptParams.abortSignal?.aborted).toBe(true);
      throw new Error("Request was aborted.");
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "xai",
      model: "grok-composer-2.5-fast",
      runId: "run-tool-loop-after-unresolved-failure",
    });

    expect(result.payloads).toEqual([
      {
        text: "I stopped because repeated tool calls did not make progress. No user-facing result text was provided.",
        isError: true,
      },
      {
        text: "⚠️ Some tool actions may have already been executed — please verify before retrying.",
        isError: true,
      },
    ]);
    expect(result.meta.livenessState).toBe("blocked");
    expect(result.meta.replayInvalid).toBe(true);
    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTexts).toEqual(["already sent"]);
    expect(result.messagingToolSentTargets).toEqual([sentTarget]);
    expect(setTerminalLifecycleMeta).toHaveBeenCalledWith({
      replayInvalid: true,
      livenessState: "blocked",
      stopReason: "tool_loop_abort",
      aborted: true,
    });
  });

  it("preserves early side-effect evidence after the observation ring evicts it", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params: unknown) => {
      const attemptParams = params as {
        abortSignal?: AbortSignal;
        onToolOutcome?: (observation: {
          toolName: string;
          argsHash: string;
          resultHash: string;
          mutatingAction?: boolean;
          blockedReason?: string;
          blockedMessage?: string;
        }) => void;
      };
      attemptParams.onToolOutcome?.({
        toolName: "charge_customer",
        argsHash: "charge",
        resultHash: "charged",
        mutatingAction: false,
      });
      for (let index = 0; index < 70; index += 1) {
        attemptParams.onToolOutcome?.({
          toolName: "read",
          argsHash: `read-${index}`,
          resultHash: `result-${index}`,
          mutatingAction: false,
        });
      }
      attemptParams.onToolOutcome?.({
        toolName: "read",
        argsHash: "read-loop",
        resultHash: "blocked",
        blockedReason: "tool-loop",
        blockedMessage: "CRITICAL: repeated read calls.",
      });
      expect(attemptParams.abortSignal?.aborted).toBe(true);
      throw new Error("Request was aborted.");
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "xai",
      model: "grok-composer-2.5-fast",
      runId: "run-tool-loop-after-evicted-side-effect",
    });

    expect(result.payloads).toContainEqual({
      text: "⚠️ Some tool actions may have already been executed — please verify before retrying.",
      isError: true,
    });
    expect(result.meta.replayInvalid).toBe(true);
  });

  it("warns when an unknown plugin tool completed before a later tool loop abort", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params: unknown) => {
      const attemptParams = params as {
        abortSignal?: AbortSignal;
        onToolOutcome?: (observation: {
          toolName: string;
          argsHash: string;
          resultHash: string;
          resultText?: string;
          terminalResultFallback?: { mode: "safe_text"; prefix?: string };
          mutatingAction?: boolean;
          blockedReason?: string;
          blockedMessage?: string;
        }) => void;
      };
      attemptParams.onToolOutcome?.({
        toolName: "charge_customer",
        argsHash: "invoice",
        resultHash: "charge-result",
        resultText: "charged",
        mutatingAction: false,
      });
      attemptParams.onToolOutcome?.({
        toolName: "status_probe",
        argsHash: "current",
        resultHash: "status-result",
        resultText: "healthy",
        terminalResultFallback: { mode: "safe_text", prefix: "Status:" },
        mutatingAction: false,
      });
      attemptParams.onToolOutcome?.({
        toolName: "status_probe",
        argsHash: "current",
        resultHash: "blocked-result",
        blockedReason: "tool-loop",
        blockedMessage:
          "CRITICAL: You are alternating between repeated tool-call patterns with no progress.",
      });
      expect(attemptParams.abortSignal?.aborted).toBe(true);
      throw new Error("Request was aborted.");
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "xai",
      model: "grok-composer-2.5-fast",
      runId: "run-tool-loop-after-unknown-plugin-tool",
    });

    expect(result.payloads).toEqual([
      { text: "Status:\nhealthy" },
      {
        text: "⚠️ Some tool actions may have already been executed — please verify before retrying.",
        isError: true,
      },
    ]);
    expect(result.meta.replayInvalid).toBe(true);
  });

  it("warns about prior mutating work when a later tool loop aborts", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params: unknown) => {
      const attemptParams = params as {
        abortSignal?: AbortSignal;
        onToolOutcome?: (observation: {
          toolName: string;
          argsHash: string;
          resultHash: string;
          resultText?: string;
          terminalResultFallback?: { mode: "safe_text"; prefix?: string };
          mutatingAction?: boolean;
          blockedReason?: string;
          blockedMessage?: string;
        }) => void;
      };
      attemptParams.onToolOutcome?.({
        toolName: "write",
        argsHash: "report",
        resultHash: "write-result",
        resultText: "updated report.md",
        mutatingAction: true,
      });
      attemptParams.onToolOutcome?.({
        toolName: "status_probe",
        argsHash: "current",
        resultHash: "status-result",
        resultText: "healthy",
        terminalResultFallback: { mode: "safe_text", prefix: "Status:" },
      });
      attemptParams.onToolOutcome?.({
        toolName: "status_probe",
        argsHash: "current",
        resultHash: "blocked-result",
        blockedReason: "tool-loop",
        blockedMessage:
          "CRITICAL: You are alternating between repeated tool-call patterns with no progress.",
      });
      expect(attemptParams.abortSignal?.aborted).toBe(true);
      throw new Error("Request was aborted.");
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "xai",
      model: "grok-composer-2.5-fast",
      runId: "run-tool-loop-after-mutation",
    });

    expect(result.payloads).toEqual([
      { text: "Status:\nhealthy" },
      {
        text: "⚠️ Some tool actions may have already been executed — please verify before retrying.",
        isError: true,
      },
    ]);
    expect(result.meta.livenessState).toBe("blocked");
    expect(result.meta.replayInvalid).toBe(true);
  });

  it("warns about a prior async start when a later tool loop aborts", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params: unknown) => {
      const attemptParams = params as {
        abortSignal?: AbortSignal;
        onToolOutcome?: (observation: {
          toolName: string;
          argsHash: string;
          resultHash: string;
          resultText?: string;
          terminalResultFallback?: { mode: "safe_text"; prefix?: string };
          asyncStarted?: boolean;
          blockedReason?: string;
          blockedMessage?: string;
        }) => void;
      };
      attemptParams.onToolOutcome?.({
        toolName: "image_generate",
        argsHash: "image",
        resultHash: "image-result",
        resultText: "generation started",
        asyncStarted: true,
      });
      attemptParams.onToolOutcome?.({
        toolName: "status_probe",
        argsHash: "current",
        resultHash: "status-result",
        resultText: "healthy",
        terminalResultFallback: { mode: "safe_text", prefix: "Status:" },
      });
      attemptParams.onToolOutcome?.({
        toolName: "status_probe",
        argsHash: "current",
        resultHash: "blocked-result",
        blockedReason: "tool-loop",
        blockedMessage:
          "CRITICAL: You are alternating between repeated tool-call patterns with no progress.",
      });
      expect(attemptParams.abortSignal?.aborted).toBe(true);
      throw new Error("Request was aborted.");
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "xai",
      model: "grok-composer-2.5-fast",
      runId: "run-tool-loop-after-async-start",
    });

    expect(result.payloads).toEqual([
      { text: "Status:\nhealthy" },
      {
        text: "⚠️ Some tool actions may have already been executed — please verify before retrying.",
        isError: true,
      },
    ]);
    expect(result.meta.livenessState).toBe("blocked");
    expect(result.meta.replayInvalid).toBe(true);
  });

  it("surfaces a tool-declared terminal result after successful side-effect tool work without a final answer", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params: unknown) => {
      const attemptParams = params as {
        onToolOutcome?: (observation: {
          toolName: string;
          argsHash: string;
          resultHash: string;
          resultText?: string;
          terminalResultFallback?: {
            mode: "structured_summary";
            fields: Array<{
              label: string;
              paths: string[][];
              format?: "count" | "none-if-nullish-or-zero";
              missingText?: string;
            }>;
          };
        }) => void;
      };
      attemptParams.onToolOutcome?.({
        toolName: "cron",
        argsHash: "status",
        resultHash: "status-result",
        resultText: '{\n  "enabled": true,\n  "jobs": 1,\n  "nextWakeAtMs": null\n}',
        terminalResultFallback: {
          mode: "structured_summary",
          fields: [
            { label: "Scheduler enabled", paths: [["enabled"]], missingText: "unknown" },
            {
              label: "Jobs",
              paths: [["jobs"], ["total"]],
              format: "count",
              missingText: "unknown",
            },
            {
              label: "Next wake",
              paths: [["nextWakeAtMs"]],
              format: "none-if-nullish-or-zero",
              missingText: "unknown",
            },
          ],
        },
      });
      return makeAttemptResult({
        assistantTexts: [],
        successfulCronAdds: 1,
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "xai",
          model: "grok-composer-2.5-fast",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "xai",
      model: "grok-composer-2.5-fast",
      runId: "run-cron-success-no-final-answer",
    });

    expect(result.payloads).toEqual([
      {
        text: "Scheduler enabled: true\nJobs: 1\nNext wake: none",
      },
    ]);
    expect(result.meta.livenessState).toBe("working");
    expect(result.successfulCronAdds).toBe(1);
  });

  it("does not mark replay-safe incomplete-turn tool fallbacks as replay-invalid", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params: unknown) => {
      const attemptParams = params as {
        onToolOutcome?: (observation: {
          toolName: string;
          argsHash: string;
          resultHash: string;
          resultText?: string;
          terminalResultFallback?: { mode: "safe_text"; prefix?: string };
        }) => void;
      };
      attemptParams.onToolOutcome?.({
        toolName: "read",
        argsHash: "status",
        resultHash: "status-result",
        resultText: "healthy",
        terminalResultFallback: { mode: "safe_text", prefix: "Status:" },
      });
      return makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "read", mutatingAction: false }],
        lastAssistant: {
          role: "assistant",
          stopReason: "toolUse",
          provider: "xai",
          model: "grok-composer-2.5-fast",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "xai",
      model: "grok-composer-2.5-fast",
      runId: "run-incomplete-turn-tool-fallback-replay-safe",
    });

    expect(result.payloads).toEqual([{ text: "Status:\nhealthy" }]);
    expect(result.meta.livenessState).toBe("working");
    expect(result.meta.replayInvalid).toBe(false);
  });

  it("does not let a successful tool fallback hide a later tool error", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedBuildEmbeddedRunPayloads.mockReturnValueOnce([
      { text: "⚠️ Web fetch failed", isError: true },
    ]);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params: unknown) => {
      const attemptParams = params as {
        onToolOutcome?: (observation: {
          toolName: string;
          argsHash: string;
          resultHash: string;
          resultText?: string;
          terminalResultFallback?: { mode: "safe_text"; prefix?: string };
        }) => void;
      };
      attemptParams.onToolOutcome?.({
        toolName: "status_probe",
        argsHash: "status",
        resultHash: "status-result",
        resultText: "healthy",
        terminalResultFallback: { mode: "safe_text", prefix: "Status:" },
      });
      return makeAttemptResult({
        assistantTexts: [],
        toolMetas: [
          { toolName: "status_probe", mutatingAction: false },
          { toolName: "web_fetch", mutatingAction: false },
        ],
        lastToolError: {
          toolName: "web_fetch",
          error: "network down",
          mutatingAction: false,
        },
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "xai",
          model: "grok-composer-2.5-fast",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "xai",
      model: "grok-composer-2.5-fast",
      runId: "run-tool-error-after-successful-fallback",
    });

    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("Web fetch");
    expect(result.payloads?.[0]?.text).not.toContain("Status:\nhealthy");
  });

  it("uses explicit agentId without a session key before surfacing the strict-agentic blocked state", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      sessionKey: undefined,
      agentId: "research",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-strict-agentic-explicit-agent",
      config: {
        agents: {
          defaults: {
            embeddedAgent: {
              executionContract: "default",
            },
          },
          list: [
            { id: "main" },
            {
              id: "research",
              embeddedAgent: {
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

  it("emits explicit replayInvalid + blocked liveness state at the strict-agentic blocked exit", async () => {
    // Criterion 4 of the GPT-5.4 parity gate requires every terminal exit path
    // to emit explicit replayInvalid + livenessState. The strict-agentic
    // blocked exit is the exact place where strict-agentic is supposed to be
    // loudest; it must not fall through to "silent disappearance".
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-strict-agentic-blocked-liveness",
      config: {
        agents: {
          defaults: {
            embeddedAgent: {
              executionContract: "strict-agentic",
            },
          },
          list: [{ id: "main" }],
        },
      } as OpenClawConfig,
    });

    expect(result.payloads).toEqual([
      {
        text: STRICT_AGENTIC_BLOCKED_TEXT,
        isError: true,
      },
    ]);
    expect(result.meta.livenessState).toBe("blocked");
    expect(result.meta.replayInvalid).toBe(false);
  });

  it("promotes successful final assistant text when a prompt timeout races completion", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const finalText =
      "1. Verdict: the answer completed cleanly. 2. Evidence: the runner captured final text.";
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        timedOut: true,
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.5",
          content: [{ type: "text", text: finalText }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-prompt-timeout-final-assistant-recovered",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([{ text: finalText }]);
    expect(result.meta.finalAssistantVisibleText).toBe(finalText);
    expect(result.meta.finalAssistantRawText).toBe(finalText);
    expect(result.meta.livenessState).toBe("working");
    expect(result.meta.completion).toEqual({
      stopReason: "stop",
      finishReason: "stop",
    });
    expect(result.meta.executionTrace?.attempts?.at(-1)).toMatchObject({
      result: "success",
      stage: "assistant",
    });
  });

  it("promotes a timeout-raced final assistant reply after an external message send", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const finalText = "The external notification was sent, and the source-channel summary is done.";
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        timedOut: true,
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["External notification"],
        messagingToolSentTargets: [{ tool: "message", provider: "discord", to: "channel-2" }],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.5",
          content: [{ type: "text", text: finalText }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-prompt-timeout-external-message-final-assistant-recovered",
    });

    expect(result.payloads).toEqual([{ text: finalText }]);
    expect(result.meta.finalAssistantVisibleText).toBe(finalText);
  });

  it.each([
    { prompt: "Will you keep replies short?", finalText: "Got it." },
    { prompt: "Does this approach make sense?", finalText: "Absolutely." },
  ])(
    "promotes concise direct answer $finalText when a prompt timeout races completion",
    async ({ prompt, finalText }) => {
      mockedClassifyFailoverReason.mockReturnValue(null);
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          timedOut: true,
          lastAssistant: {
            role: "assistant",
            stopReason: "stop",
            provider: "openai",
            model: "gpt-5.5",
            content: [{ type: "text", text: finalText }],
          } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
        }),
      );

      const result = await runEmbeddedAgent({
        ...overflowBaseRunParams,
        prompt,
        provider: "openai",
        model: "gpt-5.5",
        runId: "run-prompt-timeout-concise-direct-answer-recovered",
      });

      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
      expect(result.payloads).toEqual([{ text: finalText }]);
      expect(result.meta.finalAssistantVisibleText).toBe(finalText);
    },
  );

  it("promotes a requested plan when a prompt timeout races completion", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const finalText = "Plan:\n1. Inspect the runner\n2. Patch the guard\n3. Run focused tests";
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        timedOut: true,
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.5",
          content: [{ type: "text", text: finalText }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      prompt: "What's your plan for fixing this?",
      provider: "mock-openai",
      model: "gpt-5.5",
      runId: "run-prompt-timeout-requested-plan-recovered",
      config: {
        agents: {
          defaults: {
            embeddedAgent: {
              executionContract: "strict-agentic",
            },
          },
          list: [{ id: "main" }],
        },
      } as OpenClawConfig,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([{ text: finalText }]);
    expect(result.meta.finalAssistantVisibleText).toBe(finalText);
  });

  it("includes tool fallback before timeout error when final answer times out after tool work", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params: unknown) => {
      const attemptParams = params as {
        onToolOutcome?: (observation: {
          toolName: string;
          argsHash: string;
          resultHash: string;
          resultText?: string;
        }) => void;
      };
      attemptParams.onToolOutcome?.({
        toolName: "read",
        argsHash: "current",
        resultHash: "result-1",
        resultText: "TOKEN=secret-value\nstatus: ok",
      });
      const toolMetas = [{ toolName: "read", mutatingAction: false }];
      return makeAttemptResult({
        assistantTexts: [],
        timedOut: true,
        itemLifecycle: {
          startedCount: 1,
          completedCount: 1,
          activeCount: 0,
        },
        toolMetas,
        replayMetadata: buildAttemptReplayMetadata({
          toolMetas,
          didSendViaMessagingTool: false,
          messagingToolSentTexts: [],
          messagingToolSentMediaUrls: [],
          successfulCronAdds: 0,
        }),
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.5",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-prompt-timeout-tool-fallback",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([
      {
        text:
          "read completed, but the model did not provide a final answer. " +
          "No user-facing result text was provided.",
      },
      {
        text: "Request timed out before a response was generated. Please try again, or increase `agents.defaults.timeoutSeconds` in your config.",
        isError: true,
      },
    ]);
    expect(JSON.stringify(result.payloads)).not.toContain("secret-value");
    expect(mockedMarkAuthProfileFailure).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "an active sibling tool",
      itemLifecycle: { startedCount: 2, completedCount: 1, activeCount: 1 },
    },
    {
      name: "a started-but-unfinished sibling tool",
      itemLifecycle: { startedCount: 2, completedCount: 1, activeCount: 0 },
    },
  ])("does not include tool fallback while $name remains", async ({ itemLifecycle }) => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params: unknown) => {
      const attemptParams = params as {
        onToolOutcome?: (observation: {
          toolName: string;
          argsHash: string;
          resultHash: string;
          resultText?: string;
        }) => void;
      };
      attemptParams.onToolOutcome?.({
        toolName: "read",
        argsHash: "current",
        resultHash: "result-1",
        resultText: "status: ok",
      });
      return makeAttemptResult({
        assistantTexts: [],
        timedOut: true,
        itemLifecycle,
        toolMetas: [{ toolName: "read", mutatingAction: false }],
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-prompt-timeout-unsettled-tool-no-fallback",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([
      {
        text: "Request timed out before a response was generated. Please try again, or increase `agents.defaults.timeoutSeconds` in your config.",
        isError: true,
      },
    ]);
  });

  it("includes async task fallback before timeout error when final answer times out after background work", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        timedOut: true,
        toolMetas: [
          {
            toolName: "image_generate",
            asyncStarted: true,
            asyncTaskId: "task-image-timeout",
            asyncTaskRunId: "tool:image_generate:timeout-run",
          },
        ],
        asyncTaskTerminalResults: [
          {
            taskId: "task-image-timeout",
            runId: "tool:image_generate:timeout-run",
            status: "succeeded",
            taskKind: "image_generation",
            terminalSummary: "Generated image. API_KEY=secret-value",
          },
        ],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.5",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-prompt-timeout-async-fallback",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([
      {
        text: "image generation task finished with succeeded.",
      },
      {
        text: "Request timed out before a response was generated. Please try again, or increase `agents.defaults.timeoutSeconds` in your config.",
        isError: true,
      },
    ]);
    expect(JSON.stringify(result.payloads)).not.toContain("secret-value");
    expect(JSON.stringify(result.payloads)).not.toContain("task-image-timeout");
    expect(mockedMarkAuthProfileFailure).not.toHaveBeenCalled();
  });

  it("records same-model rate-limit retries without a profile-rotation trace", async () => {
    const rateLimitMessage =
      "429 rate_limit_exceeded: requests per minute exceeded; Retry-After: 30";
    mockedClassifyFailoverReason.mockImplementation((raw) =>
      raw.includes("429") ? "rate_limit" : null,
    );
    mockedIsFailoverAssistantError.mockImplementation((assistant) =>
      Boolean(assistant?.errorMessage?.includes("429")),
    );
    mockedIsRateLimitAssistantError.mockImplementation((assistant) =>
      Boolean(assistant?.errorMessage?.includes("429")),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "error",
          provider: "openai",
          model: "gpt-5.5",
          errorMessage: rateLimitMessage,
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Recovered after a short rate-limit wait."],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.5",
          content: [{ type: "text", text: "Recovered after a short rate-limit wait." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-same-model-rate-limit-trace",
    });

    expect(mockedSleepWithAbort).toHaveBeenCalledWith(30_000, undefined);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.meta.executionTrace?.fallbackUsed).toBe(false);
    expect(result.meta.executionTrace?.attempts).toMatchObject([
      {
        provider: "openai",
        model: "gpt-5.5",
        result: "same_model_rate_limit",
        reason: "rate_limit",
        stage: "assistant",
      },
      {
        provider: "openai",
        model: "gpt-5.5",
        result: "success",
        stage: "assistant",
      },
    ]);
  });

  it("auto-activates strict-agentic for unconfigured GPT-5 openai runs and surfaces the blocked state", async () => {
    // Criterion 1 of the GPT-5.4 parity gate ("no stalls after planning") must
    // cover out-of-the-box installs, not only users who opted in. An
    // unconfigured GPT-5.4 openai run should receive the strict-agentic retry
    // + blocked-state treatment automatically.
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-strict-agentic-auto-activated",
      config: {
        agents: {
          list: [{ id: "main" }],
        },
      } as OpenClawConfig,
    });

    // Two retries (strict-agentic retry cap) plus the original attempt = 3 calls.
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(result.payloads).toEqual([
      {
        text: STRICT_AGENTIC_BLOCKED_TEXT,
        isError: true,
      },
    ]);
    expect(result.meta.livenessState).toBe("blocked");
    expect(warnMessages().join("\n")).toContain(
      "strict-agentic execution contract triggered: runId=run-strict-agentic-auto-activated",
    );
    expect(warnMessages().join("\n")).toContain(
      "provider=openai/gpt-5.4 harness=codex contract=strict-agentic configured=unspecified",
    );
    expect(mockedLog.info.mock.calls.map(([message]) => String(message)).join("\n")).not.toContain(
      "strict-agentic execution contract active",
    );
  });

  it("respects explicit default contract opt-out on GPT-5 openai runs", async () => {
    // Users who explicitly set executionContract: "default" opt out of
    // auto-activated strict-agentic, but the generic harness still prevents
    // returning repeated "I'll do it" prose as a terminal answer.
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-strict-agentic-explicit-default-optout",
      config: {
        agents: {
          defaults: {
            embeddedAgent: {
              executionContract: "default",
            },
          },
          list: [{ id: "main" }],
        },
      } as OpenClawConfig,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads).toEqual([{ text: PLANNING_ONLY_BLOCKED_TEXT, isError: true }]);
    expect(result.meta.livenessState).toBe("blocked");
  });

  it.each([
    ["presentation", { presentation: { title: "Status", blocks: [] } }],
    ["interactive", { interactive: { blocks: [{ type: "buttons" as const, buttons: [] }] } }],
  ])("preserves planning-like text with a %s payload", async (_name, richPayload) => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const payload = { text: "Checking the deployment status now.", ...richPayload };
    mockedBuildEmbeddedRunPayloads.mockReturnValue([payload]);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [payload.text],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "mock-openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: payload.text }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      prompt: "Please check the deployment status.",
      provider: "mock-openai",
      model: "gpt-5.4",
      runId: `run-preserve-planning-like-${_name}`,
      config: {
        agents: {
          defaults: {
            embeddedAgent: {
              executionContract: "strict-agentic",
            },
          },
          list: [{ id: "main" }],
        },
      } as OpenClawConfig,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([payload]);
    expect(result.meta.livenessState).toBe("working");
  });

  it("does not apply planning-only classification to OpenAI-compatible xAI models", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedResolveModelAsync.mockResolvedValue({
      model: {
        id: "grok-composer-2.5-fast",
        provider: "xai",
        contextWindow: 200000,
        api: "openai-completions",
        reasoning: false,
      },
      error: null,
      authStorage: {
        setRuntimeApiKey: vi.fn(),
      },
      modelRegistry: {},
    });
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: ["Running a live check now — you should get real output, not a promise."],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      prompt: "Can you check this live and tell me what happened?",
      provider: "xai",
      model: "grok-composer-2.5-fast",
      runId: "run-xai-planning-only-blocked",
      config: {
        agents: {
          list: [{ id: "main" }],
        },
      } as OpenClawConfig,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([
      { text: "Running a live check now — you should get real output, not a promise." },
    ]);
    expect(result.meta.livenessState).toBe("working");
  });

  it("surfaces tool fallback after exhausting planning-only retries with completed safe tool work", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementation(async (params: unknown) => {
      const attemptParams = params as {
        onToolOutcome?: (observation: {
          toolName: string;
          argsHash: string;
          resultHash: string;
          resultText?: string;
        }) => void;
      };
      attemptParams.onToolOutcome?.({
        toolName: "read",
        argsHash: "current",
        resultHash: "status-result",
        resultText: "TOKEN=secret-value\nscheduler healthy",
      });
      return makeAttemptResult({
        assistantTexts: ["I'll verify the scheduler output next."],
        itemLifecycle: {
          startedCount: 1,
          completedCount: 1,
          activeCount: 0,
        },
        toolMetas: [{ toolName: "read", mutatingAction: false }],
        replayMetadata: buildAttemptReplayMetadata({
          toolMetas: [{ toolName: "read", mutatingAction: false }],
          didSendViaMessagingTool: false,
          messagingToolSentTexts: [],
          messagingToolSentMediaUrls: [],
          successfulCronAdds: 0,
        }),
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      prompt: "Please check the scheduler and tell me the result.",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-planning-only-exhausted-tool-fallback",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(runAttemptCall(1).prompt).toContain(PLANNING_ONLY_RETRY_INSTRUCTION);
    expect(runAttemptCall(2).prompt).toContain(PLANNING_ONLY_RETRY_INSTRUCTION);
    expect(result.payloads).toEqual([
      {
        text:
          "read completed, but the model did not provide a final answer. " +
          "No user-facing result text was provided.",
      },
    ]);
    expect(result.meta.livenessState).toBe("working");
    expectWarnMessageWith("surfacing read tool fallback");
  });

  it("preserves a concise prompt-aware final answer after completed safe tool work", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "Absolutely." }]);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params: unknown) => {
      const attemptParams = params as {
        onToolOutcome?: (observation: {
          toolName: string;
          argsHash: string;
          resultHash: string;
          resultText?: string;
        }) => void;
      };
      attemptParams.onToolOutcome?.({
        toolName: "read",
        argsHash: "current",
        resultHash: "status-result",
        resultText: "approach details",
      });
      const toolMetas = [{ toolName: "read", mutatingAction: false }];
      return makeAttemptResult({
        assistantTexts: ["Absolutely."],
        itemLifecycle: {
          startedCount: 1,
          completedCount: 1,
          activeCount: 0,
        },
        toolMetas,
        replayMetadata: buildAttemptReplayMetadata({
          toolMetas,
          didSendViaMessagingTool: false,
          messagingToolSentTexts: [],
          messagingToolSentMediaUrls: [],
          successfulCronAdds: 0,
        }),
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "mock-openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "Absolutely." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      prompt: "Does this approach make sense?",
      provider: "mock-openai",
      model: "gpt-5.4",
      runId: "run-prompt-aware-answer-after-tool-work",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(warnMessages()).toEqual([]);
    expect(result.payloads).toEqual([{ text: "Absolutely." }]);
    expect(JSON.stringify(result.payloads)).not.toContain("read completed");
  });

  it("preserves an explicitly requested plan after completed safe tool work", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const finalText = "Plan:\n1. Inspect the runner\n2. Patch the guard\n3. Run focused tests";
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: finalText }]);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params: unknown) => {
      const attemptParams = params as {
        onToolOutcome?: (observation: {
          toolName: string;
          argsHash: string;
          resultHash: string;
          resultText?: string;
        }) => void;
      };
      attemptParams.onToolOutcome?.({
        toolName: "read",
        argsHash: "current",
        resultHash: "status-result",
        resultText: "runner details",
      });
      const toolMetas = [{ toolName: "read", mutatingAction: false }];
      return makeAttemptResult({
        assistantTexts: [finalText],
        itemLifecycle: {
          startedCount: 1,
          completedCount: 1,
          activeCount: 0,
        },
        toolMetas,
        replayMetadata: buildAttemptReplayMetadata({
          toolMetas,
          didSendViaMessagingTool: false,
          messagingToolSentTexts: [],
          messagingToolSentMediaUrls: [],
          successfulCronAdds: 0,
        }),
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: finalText }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      prompt: "What's your plan for fixing this?",
      provider: "mock-openai",
      model: "gpt-5.4",
      runId: "run-requested-plan-after-tool-work",
      config: {
        agents: {
          defaults: {
            embeddedAgent: {
              executionContract: "strict-agentic",
            },
          },
          list: [{ id: "main" }],
        },
      } as OpenClawConfig,
    });

    expectNoWarnMessageWith("planning-only turn detected");
    expectNoWarnMessageWith("strict-agentic execution contract triggered");
    expect(warnMessages()).toEqual([]);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([{ text: finalText }]);
    expect(JSON.stringify(result.payloads)).not.toContain("read completed");
  });

  it("does not reuse tool fallback observations from earlier retry attempts", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async (params: unknown) => {
        const attemptParams = params as {
          onToolOutcome?: (observation: {
            toolName: string;
            argsHash: string;
            resultHash: string;
            resultText?: string;
          }) => void;
        };
        attemptParams.onToolOutcome?.({
          toolName: "read",
          argsHash: "current",
          resultHash: "status-result",
          resultText: "scheduler healthy",
        });
        return makeAttemptResult({
          assistantTexts: ["I'll verify the scheduler output next."],
          itemLifecycle: {
            startedCount: 1,
            completedCount: 1,
            activeCount: 0,
          },
          toolMetas: [{ toolName: "read", mutatingAction: false }],
          replayMetadata: buildAttemptReplayMetadata({
            toolMetas: [{ toolName: "read", mutatingAction: false }],
            didSendViaMessagingTool: false,
            messagingToolSentTexts: [],
            messagingToolSentMediaUrls: [],
            successfulCronAdds: 0,
          }),
        });
      })
      .mockResolvedValue(
        makeAttemptResult({
          assistantTexts: ["I'll verify the scheduler output next."],
          itemLifecycle: {
            startedCount: 0,
            completedCount: 0,
            activeCount: 0,
          },
          toolMetas: [],
          replayMetadata: buildAttemptReplayMetadata({
            toolMetas: [],
            didSendViaMessagingTool: false,
            messagingToolSentTexts: [],
            messagingToolSentMediaUrls: [],
            successfulCronAdds: 0,
          }),
        }),
      );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      prompt: "Please check the scheduler and tell me the result.",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-planning-only-no-stale-tool-fallback",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(result.payloads).toEqual([{ text: PLANNING_ONLY_BLOCKED_TEXT, isError: true }]);
    expect(JSON.stringify(result.payloads)).not.toContain("read completed");
    expect(result.meta.livenessState).toBe("blocked");
  });

  it("reports terminal tool completion without progress prose when provider stops before a final answer", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params: unknown) => {
      const attemptParams = params as {
        onToolOutcome?: (observation: {
          toolName: string;
          argsHash: string;
          resultHash: string;
          resultText?: string;
        }) => void;
      };
      attemptParams.onToolOutcome?.({
        toolName: "cron",
        argsHash: "current",
        resultHash: "status-result",
        resultText: "TOKEN=secret-value\njobs: 0",
      });
      return makeAttemptResult({
        assistantTexts: ["Checking the scheduler result now."],
        itemLifecycle: {
          startedCount: 1,
          completedCount: 1,
          activeCount: 0,
        },
        toolMetas: [{ toolName: "cron", mutatingAction: false }],
        replayMetadata: buildAttemptReplayMetadata({
          toolMetas: [{ toolName: "cron", mutatingAction: false }],
          didSendViaMessagingTool: false,
          messagingToolSentTexts: [],
          messagingToolSentMediaUrls: [],
          successfulCronAdds: 0,
        }),
        lastAssistant: {
          role: "assistant",
          stopReason: "length",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "Checking the scheduler result now." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      prompt: "Please check the scheduler and tell me the result.",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-provider-length-progress-tool-fallback",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([
      {
        text:
          "cron completed, but the model did not provide a final answer. " +
          "No user-facing result text was provided.",
      },
    ]);
    expect(JSON.stringify(result.payloads)).not.toContain("Checking the scheduler result now.");
    expect(result.meta.livenessState).toBe("working");
  });

  it("blocks non-retryable planning-only turns instead of surfacing the placeholder", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const toolMetas = [{ toolName: "write", mutatingAction: true }];
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Checking the result now."],
        itemLifecycle: {
          startedCount: 1,
          completedCount: 1,
          activeCount: 0,
        },
        toolMetas,
        replayMetadata: buildAttemptReplayMetadata({
          toolMetas,
          didSendViaMessagingTool: false,
          messagingToolSentTexts: [],
          messagingToolSentMediaUrls: [],
          successfulCronAdds: 0,
        }),
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      prompt: "Please update the file and verify the result.",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-non-retryable-planning-only-blocked",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([{ text: PLANNING_ONLY_BLOCKED_TEXT, isError: true }]);
    expect(result.meta.livenessState).toBe("blocked");
  });

  it("does not surface a planning-only tool fallback after committed messaging delivery", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params: unknown) => {
      const attemptParams = params as {
        onToolOutcome?: (observation: {
          toolName: string;
          argsHash: string;
          resultHash: string;
          resultText?: string;
        }) => void;
      };
      attemptParams.onToolOutcome?.({
        toolName: "status_probe",
        argsHash: "current",
        resultHash: "status-result",
        resultText: "status: delivered",
      });
      return makeAttemptResult({
        assistantTexts: ["Checking the result now."],
        itemLifecycle: {
          startedCount: 1,
          completedCount: 1,
          activeCount: 0,
        },
        toolMetas: [{ toolName: "status_probe", mutatingAction: false }],
        messagingToolSentTexts: ["Delivered through the message tool."],
        replayMetadata: buildAttemptReplayMetadata({
          toolMetas: [{ toolName: "status_probe", mutatingAction: false }],
          didSendViaMessagingTool: true,
          messagingToolSentTexts: ["Delivered through the message tool."],
          messagingToolSentMediaUrls: [],
          successfulCronAdds: 0,
        }),
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      prompt: "Please send the update and verify it.",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-non-retryable-planning-only-delivered-no-tool-fallback",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).not.toEqual([
      {
        text:
          "status_probe completed, but the model did not provide a final answer. " +
          "No user-facing result text was provided.",
      },
    ]);
    expect(result.payloads).toBeUndefined();
  });

  it("detects replay-safe planning-only GPT turns", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    });

    expect(retryInstruction).toContain("Do not restate the plan");
  });

  it("retries reasoning-only GPT turns with a visible-answer continuation instruction", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_reasoning_only", type: "reasoning" }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible answer."],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "Visible answer." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-reasoning-only-continuation",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondCall = runAttemptCall(1);
    expect(secondCall.prompt).toContain(REASONING_ONLY_RETRY_INSTRUCTION);
    expectWarnMessageWith("reasoning-only assistant turn detected");
  });

  it("returns NO_REPLY without retrying reasoning-only assistant turns when silence is allowed", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.5",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_silent_group", type: "reasoning" }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      allowEmptyAssistantReplyAsSilent: true,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-reasoning-only-silent",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    const onlyCall = runAttemptCall(0);
    expect(onlyCall.prompt).not.toContain(REASONING_ONLY_RETRY_INSTRUCTION);
    expect(onlyCall.prompt).not.toContain(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expectNoWarnMessageWith("reasoning-only assistant turn detected");
    expect(result.payloads).toEqual([{ text: "NO_REPLY" }]);
    expect(result.meta.terminalReplyKind).toBe("silent-empty");
    expect(result.meta.livenessState).toBe("working");
  });

  it("does not retry or warn on reasoning-only turns when a messaging tool already delivered", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["Delivered through the message tool."],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_after_send", type: "reasoning" }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-reasoning-only-after-side-effects",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toBeUndefined();
  });

  it("does not retry reasoning-only turns when the assistant ended in error", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "error",
          provider: "openai",
          model: "gpt-5.4",
          errorMessage: "provider failed after emitting reasoning",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_error_turn", type: "reasoning" }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-reasoning-only-assistant-error",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("Please try again");
  });

  it("retries reasoning-only turns for non-strict-agentic providers", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedResolveModelAsync.mockResolvedValue({
      model: {
        id: "sonnet-4.6",
        provider: "anthropic",
        contextWindow: 200000,
        api: "anthropic-messages",
        reasoning: true,
      },
      error: null,
      authStorage: {
        setRuntimeApiKey: vi.fn(),
      },
      modelRegistry: {},
    });
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "anthropic",
          model: "sonnet-4.6",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({
                id: "rs_provider_mismatch",
                type: "reasoning",
              }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "sonnet-4.6",
      runId: "run-reasoning-only-provider-mismatch",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(runAttemptCall(1).prompt).toContain(REASONING_ONLY_RETRY_INSTRUCTION);
    expect(runAttemptCall(2).prompt).toContain(REASONING_ONLY_RETRY_INSTRUCTION);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("Please try again");
  });

  it("retries Kimi Anthropic reasoning-only turns with a visible-answer continuation instruction", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedResolveModelAsync.mockResolvedValue({
      model: {
        id: "kimi-for-coding",
        provider: "kimi",
        contextWindow: 262144,
        api: "anthropic-messages",
        reasoning: false,
      },
      error: null,
      authStorage: {
        setRuntimeApiKey: vi.fn(),
      },
      modelRegistry: {},
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          api: "anthropic-messages",
          stopReason: "stop",
          provider: "kimi",
          model: "kimi-for-coding",
          content: [
            {
              type: "thinking",
              thinking: "internal Kimi reasoning",
              thinkingSignature: "",
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible Kimi answer."],
        lastAssistant: {
          role: "assistant",
          api: "anthropic-messages",
          stopReason: "stop",
          provider: "kimi",
          model: "kimi-for-coding",
          content: [{ type: "text", text: "Visible Kimi answer." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "kimi",
      model: "kimi-for-coding",
      runId: "run-kimi-anthropic-reasoning-only-continuation",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondCall = runAttemptCall(1);
    expect(secondCall.prompt).toContain(REASONING_ONLY_RETRY_INSTRUCTION);
    expectWarnMessageWith("reasoning-only assistant turn detected");
  });

  it("retries generic empty GPT turns with a visible-answer continuation instruction", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible answer."],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "Visible answer." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-empty-response-continuation",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondCall = runAttemptCall(1);
    expect(secondCall.prompt).toContain(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expectWarnMessageWith("empty response detected");
  });

  it("retries replay-safe missing terminal assistant turns once with the same prompt", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: undefined,
        currentAttemptAssistant: undefined,
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Recovered answer."],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.5",
          content: [{ type: "text", text: "Recovered answer." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-missing-assistant-retry",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(runAttemptCall(1).prompt).toBe(runAttemptCall(0).prompt);
    expect(result.meta?.finalAssistantVisibleText).toBe("Recovered answer.");
    expectWarnMessageWith("missing assistant terminal message detected");
    expectNoWarnMessageWith("empty response detected");
    expectNoWarnMessageWith("incomplete turn detected");
  });

  it("retries zero-token empty Claude stop turns with a visible-answer continuation instruction", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "anthropic",
          model: "claude-opus-4.7",
          content: [],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
          },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible Claude answer."],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "anthropic",
          model: "claude-opus-4.7",
          content: [{ type: "text", text: "Visible Claude answer." }],
          usage: {
            input: 100,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 105,
          },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "claude-opus-4.7",
      runId: "run-empty-zero-usage-claude-continuation",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondCall = runAttemptCall(1);
    expect(secondCall.prompt).toContain(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expectWarnMessageWith("empty response detected");
  });

  it("retries empty openai-compatible stop turns even when the backend reports output tokens", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedResolveModelAsync.mockResolvedValue({
      model: {
        id: "qwen3.6-27b",
        provider: "llamacpp",
        contextWindow: 200000,
        api: "openai-completions",
        reasoning: false,
      },
      error: null,
      authStorage: {
        setRuntimeApiKey: vi.fn(),
      },
      modelRegistry: {},
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          api: "openai-completions",
          stopReason: "stop",
          provider: "llamacpp",
          model: "qwen3.6-27b",
          content: [],
          usage: {
            input: 512,
            output: 103,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 615,
          },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible local answer."],
        lastAssistant: {
          role: "assistant",
          api: "openai-completions",
          stopReason: "stop",
          provider: "llamacpp",
          model: "qwen3.6-27b",
          content: [{ type: "text", text: "Visible local answer." }],
          usage: {
            input: 640,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 645,
          },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "llamacpp",
      model: "qwen3.6-27b",
      runId: "run-empty-openai-compatible-stop-continuation",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondCall = runAttemptCall(1);
    expect(secondCall.prompt).toContain(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expectWarnMessageWith("empty response detected");
  });

  it("retries empty Anthropic-compatible stop turns even when the provider is not Kimi", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedResolveModelAsync.mockResolvedValue({
      model: {
        id: "claude-opus-4-7",
        provider: "sub2api",
        contextWindow: 200000,
        api: "anthropic-messages",
        reasoning: false,
      },
      error: null,
      authStorage: {
        setRuntimeApiKey: vi.fn(),
      },
      modelRegistry: {},
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          api: "anthropic-messages",
          stopReason: "stop",
          provider: "sub2api",
          model: "claude-opus-4-7",
          content: [],
          usage: {
            input: 2048,
            output: 3100,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 5148,
          },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible Anthropic-compatible answer."],
        lastAssistant: {
          role: "assistant",
          api: "anthropic-messages",
          stopReason: "stop",
          provider: "sub2api",
          model: "claude-opus-4-7",
          content: [{ type: "text", text: "Visible Anthropic-compatible answer." }],
          usage: {
            input: 2300,
            output: 8,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2308,
          },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "sub2api",
      model: "claude-opus-4-7",
      runId: "run-empty-anthropic-compatible-stop-continuation",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondCall = runAttemptCall(1);
    expect(secondCall.prompt).toContain(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expectWarnMessageWith("empty response detected");
  });

  it("surfaces an error after exhausting empty-response retries", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-empty-response-exhausted",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("Please try again");
    expectWarnMessageWith("empty response retries exhausted");
  });

  it("surfaces an error after exhausting reasoning-only retries without a visible answer", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({
                id: "rs_reasoning_exhausted",
                type: "reasoning",
              }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      reasoningLevel: "on",
      runId: "run-reasoning-only-exhausted",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("Please try again");
    expectWarnMessageWith("reasoning-only retries exhausted");
  });

  it("surfaces tool fallback after exhausting reasoning-only retries with completed safe tool work", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockImplementation(async (params: unknown) => {
      const attemptParams = params as {
        onToolOutcome?: (observation: {
          toolName: string;
          argsHash: string;
          resultHash: string;
          resultText?: string;
        }) => void;
      };
      attemptParams.onToolOutcome?.({
        toolName: "read",
        argsHash: "current",
        resultHash: "result-1",
        resultText: "TOKEN=secret-value\nstatus: ok",
      });
      const toolMetas = [{ toolName: "read", mutatingAction: false }];
      return makeAttemptResult({
        assistantTexts: [],
        itemLifecycle: {
          startedCount: 1,
          completedCount: 1,
          activeCount: 0,
        },
        toolMetas,
        replayMetadata: buildAttemptReplayMetadata({
          toolMetas,
          didSendViaMessagingTool: false,
          messagingToolSentTexts: [],
          messagingToolSentMediaUrls: [],
          successfulCronAdds: 0,
        }),
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({
                id: "rs_reasoning_tool_fallback",
                type: "reasoning",
              }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      reasoningLevel: "on",
      runId: "run-reasoning-only-tool-fallback",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(result.payloads).toEqual([
      {
        text:
          "read completed, but the model did not provide a final answer. " +
          "No user-facing result text was provided.",
      },
    ]);
    expect(result.meta.livenessState).toBe("working");
    expect(result.meta.replayInvalid).toBe(false);
    expect(mockedMarkAuthProfileFailure).not.toHaveBeenCalled();
    expectWarnMessageWith("reasoning-only retries exhausted");
  });

  it("detects structured bullet-only plans with intent cues as planning-only GPT turns", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Please inspect the code, make the change, and run the checks.",
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

  it("detects present-progress action claims as planning-only turns", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Can you check the scheduler for any jobs on your agent?",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Checking the scheduler for any jobs on your agent."],
      }),
    });

    expect(retryInstruction).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
  });

  it.each(["Working on it.", "Taking a look now.", "On it."])(
    "detects short progress placeholder %s as planning-only for actionable prompts",
    (assistantText) => {
      const retryInstruction = resolvePlanningOnlyRetryInstruction({
        provider: "openai",
        modelId: "gpt-5.4",
        prompt: "Please check the scheduler and tell me the result.",
        aborted: false,
        timedOut: false,
        attempt: makeAttemptResult({
          assistantTexts: [assistantText],
        }),
      });

      expect(retryInstruction).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
    },
  );

  it.each([
    "Running: 3 jobs.",
    "Checking: Fetched prices.",
    "Running normally.",
    "Working fine.",
    "Running 3 jobs.",
  ])("does not classify result-style progress text %s as planning-only", (assistantText) => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "What is the current jobs status?",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [assistantText],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("does not classify a direct progress-status answer as planning-only", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Are you monitoring it?",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Monitoring it now."],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it.each([
    "Running a live cron check now — you should get real output, not a promise.",
    "Starting the live cron check now.",
    "Launching the scheduler check now.",
    "Kicking off the scheduler check now.",
    "Sending it off now; I'll monitor it.",
    "Monitoring it now.",
  ])("detects launch/monitor progress placeholder %s as planning-only", (assistantText) => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Please send it off, monitor it, and report the result.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [assistantText],
      }),
    });

    expect(retryInstruction).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
  });

  it.each([
    "I can start that now.",
    "I can launch that now.",
    "I can send that now.",
    "I can monitor that for you.",
  ])("detects capability placeholder %s as planning-only", (assistantText) => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Please send it off, monitor it, and report the result.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [assistantText],
      }),
    });

    expect(retryInstruction).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
  });

  it.each([
    "I’m looking into it now.",
    "I’ll check the scheduler and report back.",
    "I’m gonna check the scheduler now.",
    "Lemme look at the scheduler now.",
  ])("detects typographic-apostrophe placeholder %s as planning-only", (assistantText) => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Please check the scheduler and tell me the result.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [assistantText],
      }),
    });

    expect(retryInstruction).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
  });

  it.each(["I can check that for you.", "I can handle that.", "I'll get back to you shortly."])(
    "detects capability/follow-up placeholder %s as planning-only",
    (assistantText) => {
      const retryInstruction = resolvePlanningOnlyRetryInstruction({
        provider: "openai",
        modelId: "gpt-5.4",
        prompt: "Please check the scheduler and tell me the result.",
        aborted: false,
        timedOut: false,
        attempt: makeAttemptResult({
          assistantTexts: [assistantText],
        }),
      });

      expect(retryInstruction).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
    },
  );

  it.each(["I'll do that.", "I'll handle it.", "I'll take care of this."])(
    "detects short promise placeholder %s as planning-only",
    (assistantText) => {
      const retryInstruction = resolvePlanningOnlyRetryInstruction({
        provider: "openai",
        modelId: "gpt-5.4",
        prompt: "Show endpoint results now",
        aborted: false,
        timedOut: false,
        attempt: makeAttemptResult({
          assistantTexts: [assistantText],
        }),
      });

      expect(retryInstruction).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
    },
  );

  it.each(["Stand by.", "One sec.", "Give me a moment while I check that.", "Please wait."])(
    "detects wait placeholder %s as planning-only",
    (assistantText) => {
      const retryInstruction = resolvePlanningOnlyRetryInstruction({
        provider: "openai",
        modelId: "gpt-5.4",
        prompt: "Show endpoint results now",
        aborted: false,
        timedOut: false,
        attempt: makeAttemptResult({
          assistantTexts: [assistantText],
        }),
      });

      expect(retryInstruction).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
    },
  );

  it.each(["Sure thing.", "Got it.", "Understood.", "Will do.", "Sounds good."])(
    "detects acknowledgement placeholder %s as planning-only",
    (assistantText) => {
      const retryInstruction = resolvePlanningOnlyRetryInstruction({
        provider: "openai",
        modelId: "gpt-5.4",
        prompt: "Show endpoint results now",
        aborted: false,
        timedOut: false,
        attempt: makeAttemptResult({
          assistantTexts: [assistantText],
        }),
      });

      expect(retryInstruction).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
    },
  );

  it("detects a polite action directive after a salutation as planning-only", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Hey, please check the scheduler.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Got it."],
      }),
    });

    expect(retryInstruction).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
  });

  it("does not classify short progress-like chatter for non-actionable prompts", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "nice",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Working on it."],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it.each(["I am heading out", "That was rough"])(
    "does not classify acknowledgements for conversational prompt %s as planning-only",
    (prompt) => {
      const retryInstruction = resolvePlanningOnlyRetryInstruction({
        provider: "openai",
        modelId: "gpt-5.4",
        prompt,
        aborted: false,
        timedOut: false,
        attempt: makeAttemptResult({
          assistantTexts: ["Got it."],
        }),
      });

      expect(retryInstruction).toBeNull();
    },
  );

  it.each(["The endpoint is down.", "Status update: the container is running normally."])(
    "does not classify acknowledgement of context statement %s as planning-only",
    (prompt) => {
      const retryInstruction = resolvePlanningOnlyRetryInstruction({
        provider: "openai",
        modelId: "gpt-5.4",
        prompt,
        aborted: false,
        timedOut: false,
        attempt: makeAttemptResult({
          assistantTexts: ["Got it."],
        }),
      });

      expect(retryInstruction).toBeNull();
    },
  );

  it.each([
    { prompt: "Please be concise.", assistantText: "Okay." },
    { prompt: "Please wait.", assistantText: "Understood." },
  ])(
    "does not classify preference-only polite request $prompt as planning-only",
    ({ prompt, assistantText }) => {
      const retryInstruction = resolvePlanningOnlyRetryInstruction({
        provider: "openai",
        modelId: "gpt-5.4",
        prompt,
        aborted: false,
        timedOut: false,
        attempt: makeAttemptResult({
          assistantTexts: [assistantText],
        }),
      });

      expect(retryInstruction).toBeNull();
    },
  );

  it.each([
    { prompt: "Can you reply with got it?", assistantText: "Got it." },
    { prompt: "Can you acknowledge this?", assistantText: "Understood." },
    { prompt: "Please say ok as a short reply.", assistantText: "OK." },
  ])(
    "does not classify requested acknowledgement $assistantText as planning-only",
    ({ prompt, assistantText }) => {
      const retryInstruction = resolvePlanningOnlyRetryInstruction({
        provider: "openai",
        modelId: "gpt-5.4",
        prompt,
        aborted: false,
        timedOut: false,
        attempt: makeAttemptResult({
          assistantTexts: [assistantText],
        }),
      });

      expect(retryInstruction).toBeNull();
    },
  );

  it.each([
    { prompt: "Does the proposed config sound good?", assistantText: "Sounds good." },
    { prompt: "Is that okay?", assistantText: "Okay." },
    { prompt: "Does this approach make sense?", assistantText: "Absolutely." },
    { prompt: "Would this work for you?", assistantText: "Sure thing." },
    { prompt: "Are we ready?", assistantText: "Absolutely." },
    { prompt: "Do you agree?", assistantText: "Absolutely." },
    { prompt: "Will you keep replies short?", assistantText: "Got it." },
    { prompt: "Will you stay available?", assistantText: "Understood." },
  ])(
    "does not classify direct acknowledgement answer $assistantText as planning-only",
    ({ prompt, assistantText }) => {
      const retryInstruction = resolvePlanningOnlyRetryInstruction({
        provider: "openai",
        modelId: "gpt-5.4",
        prompt,
        aborted: false,
        timedOut: false,
        attempt: makeAttemptResult({
          assistantTexts: [assistantText],
        }),
      });

      expect(retryInstruction).toBeNull();
    },
  );

  it("keeps acknowledgement placeholders planning-only for action-request questions", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Can you check whether the proposed config looks good?",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Okay."],
      }),
    });

    expect(retryInstruction).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
  });

  it.each(["Will you delete the file?", "Will you remove the job?", "Will you create the ticket?"])(
    "keeps acknowledgement placeholders planning-only for operation question %s",
    (prompt) => {
      const retryInstruction = resolvePlanningOnlyRetryInstruction({
        provider: "openai",
        modelId: "gpt-5.4",
        prompt,
        aborted: false,
        timedOut: false,
        attempt: makeAttemptResult({
          assistantTexts: ["Will do."],
        }),
      });

      expect(retryInstruction).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
    },
  );

  it("does not classify capability chatter for non-actionable prompts", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "thanks",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I can check that for you."],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("does not misclassify a direct answer that starts with a conversational promise", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Is the endpoint down?",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll be blunt: the endpoint is down."],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("does not misclassify an explicit answer-style reply as planning-only", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Can you explain the root cause?",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll explain: the cache was stale."],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("does not misclassify a let-me answer-style reply as planning-only", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Can you explain the root cause?",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Let me explain: the cache was stale."],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("does not misclassify a let-me result clause as planning-only", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Please check the scheduler and tell me the result.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Let me check: there are no scheduled jobs."],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("does not misclassify a direct answer that starts with a wait phrase", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Is the endpoint down?",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Hold on: the endpoint is healthy."],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("does not misclassify a direct answer that starts with an acknowledgement", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Is the endpoint down?",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Got it: the endpoint is healthy."],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("does not treat present-progress blocker explanations as planning-only turns", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "xai",
      modelId: "grok-composer-2.5-fast",
      prompt: "Can you check the scheduler for any jobs on your agent?",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Checking the scheduler requires the cron tool, which is unavailable."],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("does not misclassify ordinary bullet summaries as planning-only", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Please inspect the code, make the change, and run the checks.",
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
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Plan:\n1. Parser refactor\n2. Regression coverage\n3. Docs cleanup"],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("retries planning-only detection after completed replay-safe tool activity", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
        toolMetas: [
          { toolName: "read", meta: "path=src/index.ts" },
          { toolName: "search", meta: "pattern=runEmbeddedAgent" },
        ],
        itemLifecycle: {
          startedCount: 2,
          completedCount: 2,
          activeCount: 0,
        },
      }),
    });

    expect(retryInstruction).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
  });

  it.each([
    {
      name: "active",
      itemLifecycle: { startedCount: 1, completedCount: 0, activeCount: 1 },
    },
    {
      name: "started but unfinished",
      itemLifecycle: { startedCount: 1, completedCount: 0, activeCount: 0 },
    },
  ])("does not retry planning-only detection while an item is $name", ({ itemLifecycle }) => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
        itemLifecycle,
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("treats update_plan as non-progress for planning-only retry detection", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Please inspect the code, make the change, and run the checks.",
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

  it("applies the planning-only retry guard to prefixed GPT-5 ids", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "  openai/gpt-5.4  ",
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    });

    expect(retryInstruction).toContain("Do not restate the plan");
  });

  it("applies the ack-turn fast path to broadened GPT-5-family ids", () => {
    const instruction = resolveAckExecutionFastPathInstruction({
      provider: "openai",
      modelId: "gpt-5o-mini",
      prompt: "go ahead",
    });

    expect(instruction).toContain("Do not recap or restate the plan");
  });

  it("applies the ack-turn fast path to Gemini action turns", () => {
    const instruction = resolveAckExecutionFastPathInstruction({
      provider: "google",
      modelId: "gemini-3.1-pro",
      prompt: "go ahead",
    });

    expect(instruction).toBe(ACK_EXECUTION_FAST_PATH_INSTRUCTION);
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

  it("flags tool-use stop reason as incomplete even when pre-tool text exists (#76477)", () => {
    expect(
      isIncompleteTerminalAssistantTurn({
        hasAssistantVisibleText: true,
        lastAssistant: { stopReason: "toolUse" },
      }),
    ).toBe(true);
    expect(
      isIncompleteTerminalAssistantTurn({
        hasAssistantVisibleText: false,
        lastAssistant: { stopReason: "toolUse" },
      }),
    ).toBe(true);
    expect(
      isIncompleteTerminalAssistantTurn({
        hasAssistantVisibleText: true,
        lastAssistant: { stopReason: "end_turn" },
      }),
    ).toBe(false);
  });

  it("surfaces no-visible-answer recovery for app-server interrupted tool-only output", () => {
    const interruptedToolOnlyAttempt = makeAttemptResult({
      assistantTexts: [],
      toolMetas: [{ toolName: "bash", meta: "workspace" }],
      messagesSnapshot: [
        {
          role: "user",
          content: "check running processes",
          timestamp: 1,
        },
        {
          role: "toolResult",
          content: "",
          isError: false,
          details: { aggregated: "" },
          timestamp: 2,
        } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
      ],
    });

    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: interruptedToolOnlyAttempt.assistantTexts.length,
      aborted: false,
      timedOut: false,
      attempt: interruptedToolOnlyAttempt,
    });

    expect(incompleteTurnText).toContain("couldn't generate a response");

    const explicitCancellationText = resolveIncompleteTurnPayloadText({
      payloadCount: interruptedToolOnlyAttempt.assistantTexts.length,
      aborted: true,
      externalAbort: true,
      timedOut: false,
      attempt: interruptedToolOnlyAttempt,
    });

    expect(explicitCancellationText).toBeNull();

    const internalAbortText = resolveIncompleteTurnPayloadText({
      payloadCount: interruptedToolOnlyAttempt.assistantTexts.length,
      aborted: true,
      externalAbort: false,
      timedOut: false,
      attempt: interruptedToolOnlyAttempt,
    });

    expect(internalAbortText).toContain("couldn't generate a response");
  });

  it("allows a same-prompt retry only for replay-safe missing assistant turns", () => {
    const replaySafeAttempt = makeAttemptResult({
      assistantTexts: [],
      lastAssistant: undefined,
      currentAttemptAssistant: undefined,
    });

    expect(
      shouldRetryMissingAssistantTurn({
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt: replaySafeAttempt,
      }),
    ).toBe(true);
    expect(
      shouldRetryMissingAssistantTurn({
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt: makeAttemptResult({
          assistantTexts: [],
          lastAssistant: undefined,
          currentAttemptAssistant: undefined,
          toolMetas: [{ toolName: "image_generate", asyncStarted: true }],
        }),
      }),
    ).toBe(false);
    expect(
      shouldRetryMissingAssistantTurn({
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt: makeAttemptResult({
          assistantTexts: [],
          lastAssistant: undefined,
          currentAttemptAssistant: undefined,
          itemLifecycle: {
            startedCount: 1,
            completedCount: 0,
            activeCount: 1,
          },
        }),
      }),
    ).toBe(false);
  });

  it("detects tool-use terminal turn with pre-tool text as incomplete (#76477)", () => {
    // When the last assistant message ended with stopReason=toolUse, pre-tool
    // text alone must not suppress the incomplete-turn guard. The model
    // expected to continue after tool results but the post-tool response was
    // never produced.
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 1,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Initial analysis of the codebase..."],
        toolMetas: [{ toolName: "read", meta: "path=src/index.ts" }],
        lastAssistant: {
          role: "assistant",
          stopReason: "toolUse",
          provider: "anthropic",
          model: "sonnet-4.6",
          content: [
            { type: "text", text: "Initial analysis of the codebase..." },
            { type: "tool_use", id: "tool_1", name: "read", input: { path: "src/index.ts" } },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toContain("couldn't generate a response");
  });

  it("surfaces incomplete-turn error when only async media metadata is present", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        toolMetas: [
          {
            toolName: "image_generate",
            meta: 'generate prompt="a portrait"',
            asyncStarted: true,
          },
        ],
        lastAssistant: {
          role: "assistant",
          stopReason: "toolUse",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "image_generate",
              input: { action: "generate", prompt: "a portrait" },
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toContain("couldn't generate a response");
  });

  it("returns a generic async task status when a background tool starts without a final answer", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        toolMetas: [
          {
            toolName: "image_generate",
            asyncStarted: true,
            asyncTaskId: "task-image-1",
            asyncTaskRunId: "tool:image_generate:run-1",
          },
        ],
        lastAssistant: {
          role: "assistant",
          stopReason: "toolUse",
          provider: "openai",
          model: "gpt-5.4",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "manual",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-async-started-no-final",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([
      {
        text:
          "Background task started, but the model did not provide a final answer.\n" +
          "Task: image_generate.",
      },
    ]);
    expect(result.meta.livenessState).toBe("working");
  });

  it("returns terminal async task summaries instead of stale progress prose", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Waiting for image generation to finish."],
        toolMetas: [
          {
            toolName: "image_generate",
            asyncStarted: true,
            asyncTaskId: "task-image-2",
            asyncTaskRunId: "tool:image_generate:run-2",
          },
        ],
        asyncTaskTerminalResults: [
          {
            taskId: "task-image-2",
            runId: "tool:image_generate:run-2",
            status: "succeeded",
            taskKind: "image_generation",
            terminalSummary: "Generated image. API_KEY=secret-value",
          },
        ],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "Waiting for image generation to finish." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "manual",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-async-terminal-summary",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([
      {
        text: "image generation task finished with succeeded.",
      },
    ]);
    expect(JSON.stringify(result.payloads)).not.toContain("secret-value");
    expect(JSON.stringify(result.payloads)).not.toContain("task-image-2");
    expect(result.meta.livenessState).toBe("working");
  });

  it.each([
    { status: "failed", terminalOutcome: undefined, statusText: "failed" },
    { status: "timed_out", terminalOutcome: undefined, statusText: "timed_out" },
    { status: "cancelled", terminalOutcome: undefined, statusText: "cancelled" },
    { status: "lost", terminalOutcome: undefined, statusText: "lost" },
    { status: "succeeded", terminalOutcome: "blocked", statusText: "succeeded/blocked" },
  ])(
    "surfaces terminal async task $status/$terminalOutcome as a blocked error",
    async ({ status, terminalOutcome, statusText }) => {
      mockedClassifyFailoverReason.mockReturnValue(null);
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: ["Waiting for image generation to finish."],
          toolMetas: [
            {
              toolName: "image_generate",
              asyncStarted: true,
              asyncTaskId: "task-image-failed",
              asyncTaskRunId: "tool:image_generate:run-failed",
            },
          ],
          asyncTaskTerminalResults: [
            {
              taskId: "task-image-failed",
              runId: "tool:image_generate:run-failed",
              status,
              taskKind: "image_generation",
              terminalSummary: "Image generation needs follow-up.",
              ...(terminalOutcome ? { terminalOutcome } : {}),
            },
          ],
          lastAssistant: {
            role: "assistant",
            stopReason: "toolUse",
            provider: "openai",
            model: "gpt-5.4",
            content: [{ type: "text", text: "Waiting for image generation to finish." }],
          } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
        }),
      );

      const result = await runEmbeddedAgent({
        ...overflowBaseRunParams,
        trigger: "manual",
        provider: "openai",
        model: "gpt-5.4",
        runId: `run-async-terminal-${status}-${terminalOutcome ?? "none"}`,
      });

      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
      expect(result.payloads).toEqual([
        {
          text: `image generation task finished with ${statusText}.`,
          isError: true,
        },
      ]);
      expect(JSON.stringify(result.payloads)).not.toContain("task-image-failed");
      expect(JSON.stringify(result.payloads)).not.toContain("needs follow-up");
      expect(result.meta.livenessState).toBe("blocked");
    },
  );

  it("keeps a real final assistant reply instead of replacing it with async task metadata", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Here is the finished image."],
        toolMetas: [
          {
            toolName: "image_generate",
            asyncStarted: true,
            asyncTaskId: "task-image-final",
            asyncTaskRunId: "tool:image_generate:run-final",
          },
        ],
        asyncTaskTerminalResults: [
          {
            taskId: "task-image-final",
            runId: "tool:image_generate:run-final",
            status: "succeeded",
            taskKind: "image_generation",
            terminalSummary: "Generated image summary that should not replace the final reply.",
          },
        ],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "Here is the finished image." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      trigger: "manual",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-async-terminal-keeps-final-reply",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([{ text: "Here is the finished image." }]);
    expect(JSON.stringify(result.payloads)).not.toContain("Generated image summary");
    expect(result.meta.livenessState).toBe("working");
  });

  it("uses async task summaries instead of plan-only blocked text for non-retryable progress prose", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Checking the image generation now."],
        toolMetas: [
          {
            toolName: "image_generate",
            asyncStarted: true,
            asyncTaskId: "task-image-3",
            asyncTaskRunId: "tool:image_generate:run-3",
          },
        ],
        asyncTaskTerminalResults: [
          {
            taskId: "task-image-3",
            runId: "tool:image_generate:run-3",
            status: "succeeded",
            taskKind: "image_generation",
            terminalSummary: "Generated final image.",
          },
        ],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "Checking the image generation now." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      prompt: "generate an image now",
      trigger: "manual",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-async-terminal-summary-over-planning-block",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([
      {
        text: "image generation task finished with succeeded.",
      },
    ]);
    expect(JSON.stringify(result.payloads)).not.toContain(PLANNING_ONLY_BLOCKED_TEXT);
    expect(result.meta.livenessState).toBe("working");
  });

  it("surfaces tool-use terminal with pre-tool text and side effects as replay-unsafe (#76477)", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 1,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Let me update the file..."],
        toolMetas: [{ toolName: "write" }],
        lastAssistant: {
          role: "assistant",
          stopReason: "toolUse",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            { type: "text", text: "Let me update the file..." },
            { type: "tool_use", id: "tool_1", name: "write", input: {} },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toContain("verify before retrying");
  });

  it("does not flag a completed tool-use turn with end_turn as incomplete (#76477)", () => {
    // When the model successfully produces post-tool text, lastAssistant has
    // stopReason=end_turn. The incomplete-turn guard should not fire.
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 1,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Initial analysis...", "Here is the final answer."],
        toolMetas: [{ toolName: "read" }],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "anthropic",
          model: "sonnet-4.6",
          content: [{ type: "text", text: "Here is the final answer." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toBeNull();
  });

  it("surfaces an error for tool-use terminal turn with pre-tool text via runEmbeddedAgent (#76477)", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Initial analysis of the issue..."],
        toolMetas: [{ toolName: "read", meta: "path=src/index.ts" }],
        lastAssistant: {
          stopReason: "toolUse",
          provider: "anthropic",
          model: "sonnet-4.6",
          content: [
            { type: "text", text: "Initial analysis of the issue..." },
            { type: "tool_use", id: "tool_1", name: "read", input: { path: "src/index.ts" } },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "sonnet-4.6",
      runId: "run-tool-use-dropped-final-text",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("couldn't generate a response");
    expectWarnMessageWith("incomplete turn detected");
  });

  it("treats missing replay metadata as replay-invalid", () => {
    const attempt = makeAttemptResult();
    delete (attempt as Partial<EmbeddedRunAttemptResult>).replayMetadata;

    expect(resolveReplayInvalidFlag({ attempt })).toBe(true);
  });

  it("detects reasoning-only GPT turns from signed thinking blocks", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_helper", type: "reasoning" }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  it("does not retry reasoning-only turns after unknown plugin tool activity", () => {
    const toolMetas = [{ toolName: "charge_customer", mutatingAction: false }];
    const retryInstruction = resolveReasoningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        itemLifecycle: {
          startedCount: 1,
          completedCount: 1,
          activeCount: 0,
        },
        toolMetas,
        replayMetadata: buildAttemptReplayMetadata({
          toolMetas,
          didSendViaMessagingTool: false,
          messagingToolSentTexts: [],
          messagingToolSentMediaUrls: [],
        }),
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_plugin_tool", type: "reasoning" }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("detects reasoning-only Gemini turns from signed thinking blocks", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction({
      provider: "google",
      modelId: "gemini-2.5-pro",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "google",
          model: "gemini-2.5-pro",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "gemini_rs_helper", type: "reasoning" }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  it("retries signed reasoning-only Bedrock Converse turns with a visible-answer continuation", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction({
      provider: "amazon-bedrock",
      modelId: "openai.gpt-oss-120b-1:0",
      modelApi: "bedrock-converse-stream",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "amazon-bedrock",
          model: "openai.gpt-oss-120b-1:0",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: "bedrock-reasoning-signature",
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  it("does not apply planning-only classification to Ollama runs", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "ollama",
      modelId: "gemma4:31b",
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    });
    const ackInstruction = resolveAckExecutionFastPathInstruction({
      provider: "ollama",
      modelId: "gemma4:31b",
      prompt: "go ahead",
    });

    expect(retryInstruction).toBeNull();
    expect(ackInstruction).toBe(ACK_EXECUTION_FAST_PATH_INSTRUCTION);
  });

  it("retries signed reasoning-only Ollama turns with a visible-answer continuation instruction", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction({
      provider: "ollama",
      modelId: "gemma4:31b",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "ollama",
          model: "gemma4:31b",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "ollama_rs_helper", type: "reasoning" }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  it("retries unsigned-thinking Ollama turns via the empty-response path", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "ollama",
      modelId: "gemma4:31b",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "ollama",
          model: "gemma4:31b",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("retries generic empty Ollama turns without visible text", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "ollama",
      modelId: "gemma4:31b",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "ollama",
          model: "gemma4:31b",
          content: [{ type: "text", text: "" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("retries empty Ollama stop turns when nonzero output tokens were generated", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "ollama",
      modelId: "minimax-m2.7:cloud",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "ollama",
          model: "minimax-m2.7:cloud",
          content: [],
          usage: { input: 100, output: 6, totalTokens: 106 },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("does not retry empty turns after an accepted sessions_spawn delivery", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "ollama",
      modelId: "gemma4:31b",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        acceptedSessionSpawns: [
          {
            runId: "run-child",
            childSessionKey: "agent:claude:subagent:child",
          },
        ],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "ollama",
          model: "gemma4:31b",
          content: [{ type: "text", text: "" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("retries empty openai-chatgpt-responses turns with non-zero output tokens (#85364)", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.5",
      modelApi: "openai-chatgpt-responses",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.5",
          content: [],
          usage: { input: 24794, output: 111, cacheRead: 4608, totalTokens: 29513 },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("retries empty openai-responses turns without visible text", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.5",
      modelApi: "openai-responses",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.5",
          content: [],
          usage: { input: 5000, output: 200, totalTokens: 5200 },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("does not retry empty turns after unknown plugin tool activity", () => {
    const toolMetas = [{ toolName: "charge_customer", mutatingAction: false }];
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.5",
      modelApi: "openai-responses",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        itemLifecycle: {
          startedCount: 1,
          completedCount: 1,
          activeCount: 0,
        },
        toolMetas,
        replayMetadata: buildAttemptReplayMetadata({
          toolMetas,
          didSendViaMessagingTool: false,
          messagingToolSentTexts: [],
          messagingToolSentMediaUrls: [],
        }),
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.5",
          content: [],
          usage: { input: 5000, output: 200, totalTokens: 5200 },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("retries empty openai-responses turns after read-only cron tools and pre-tool text", () => {
    const toolMetas = [{ toolName: "cron", mutatingAction: false }];
    const replayMetadata = buildAttemptReplayMetadata({
      toolMetas,
      didSendViaMessagingTool: false,
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      successfulCronAdds: 0,
    });

    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "xai",
      modelId: "grok-composer-2.5-fast",
      modelApi: "openai-responses",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Checking the scheduler for any jobs on your agent."],
        itemLifecycle: {
          startedCount: 1,
          completedCount: 1,
          activeCount: 0,
        },
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "xai",
          model: "grok-composer-2.5-fast",
          content: [],
          usage: { input: 5000, output: 1, totalTokens: 5001 },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
        replayMetadata,
        toolMetas,
      }),
    });

    expect(replayMetadata).toEqual({ hadPotentialSideEffects: false, replaySafe: true });
    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("retries non-visible openai-responses turns after read-only cron tools and pre-tool text", () => {
    const toolMetas = [{ toolName: "cron", mutatingAction: false }];
    const attempt = makeAttemptResult({
      assistantTexts: ["Checking the scheduler for configured jobs."],
      itemLifecycle: {
        startedCount: 1,
        completedCount: 1,
        activeCount: 0,
      },
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        provider: "xai",
        model: "grok-composer-2.5-fast",
        content: [
          {
            type: "thinking",
            thinking: "Configured crons, none.",
          },
        ],
        usage: { input: 5000, output: 20, totalTokens: 5020 },
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      toolMetas,
    });

    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "xai",
      modelId: "grok-composer-2.5-fast",
      modelApi: "openai-responses",
      payloadCount: 1,
      aborted: false,
      timedOut: false,
      attempt,
    });
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 1,
      aborted: false,
      timedOut: false,
      attempt,
    });

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expect(incompleteTurnText).toBe("⚠️ Agent couldn't generate a response. Please try again.");
  });

  it("treats unsigned thinking-only terminal payloads as incomplete despite reasoning payloads", () => {
    const attempt = makeAttemptResult({
      assistantTexts: [],
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        provider: "openai",
        model: "gpt-5.5",
        content: [
          {
            type: "thinking",
            thinking: "The answer is hidden in internal reasoning.",
          },
        ],
        usage: { input: 5000, output: 20, totalTokens: 5020 },
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    });

    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 1,
      aborted: false,
      timedOut: false,
      attempt,
    });

    expect(incompleteTurnText).toBe("⚠️ Agent couldn't generate a response. Please try again.");
  });

  it("retries empty openai-responses turns after a replay-safe missing tool and pre-tool text", () => {
    const toolMetas = [
      {
        toolName: "read",
        meta: "path /app/docs/cron.md",
      },
      {
        toolName: "grep",
        meta: "path /app/docs, pattern cron",
      },
    ];
    const attempt = makeAttemptResult({
      assistantTexts: ["Checking the scheduler now with the CLI."],
      itemLifecycle: {
        startedCount: 2,
        completedCount: 2,
        activeCount: 0,
      },
      lastToolError: {
        toolName: "grep",
        meta: "path /app/docs, pattern cron",
        error: "Tool Grep not found",
        mutatingAction: false,
      },
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        provider: "xai",
        model: "grok-composer-2.5-fast",
        content: [],
        usage: { input: 30, output: 1, totalTokens: 31 },
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      toolMetas,
    });

    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "xai",
      modelId: "grok-composer-2.5-fast",
      modelApi: "openai-responses",
      payloadCount: 1,
      aborted: false,
      timedOut: false,
      attempt,
    });
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 1,
      aborted: false,
      timedOut: false,
      attempt,
    });

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expect(incompleteTurnText).toBe("⚠️ Agent couldn't generate a response. Please try again.");
  });

  it("retries generic empty OpenAI-compatible turns from custom endpoints", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "llama-cpp-local",
      modelId: "qwen3.6-27b",
      modelApi: "openai-completions",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "llama-cpp-local",
          model: "qwen3.6-27b",
          content: [],
          usage: { input: 950, output: 103, totalTokens: 1053 },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("does not retry clean zero-token Ollama stop turns", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "ollama",
      modelId: "glm-5.1:cloud",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "ollama",
          model: "glm-5.1:cloud",
          content: [],
          usage: { input: 100, output: 0, totalTokens: 100 },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("treats exact NO_REPLY as a deliberate silent assistant reply", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["NO_REPLY"],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_no_reply", type: "reasoning" }),
            },
            { type: "text", text: "" },
            { type: "text", text: "NO_REPLY" },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toBeNull();
  });

  it("suppresses the incomplete-turn warning after committed messaging text delivery", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["Delivered through the message tool."],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "ollama",
          model: "kimi-k2.6:cloud",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toBeNull();
  });

  it("suppresses the incomplete-turn warning after committed messaging delivery before end_turn", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["Delivered through the message tool."],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "google",
          model: "gemini-2.5-pro",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_messaging_end_turn", type: "reasoning" }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toBeNull();
  });

  it("suppresses the incomplete-turn warning after committed media-only messaging delivery", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        didSendViaMessagingTool: false,
        messagingToolSentMediaUrls: ["file:///tmp/render.png"],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toBeNull();
  });

  it("suppresses the incomplete-turn warning after a visible source-reply payload", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        messagingToolSourceReplyPayloads: [
          {
            interactive: {
              blocks: [{ type: "buttons", buttons: [{ label: "Open", value: "open" }] }],
            },
          },
        ],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toBeNull();
  });

  it("suppresses the incomplete-turn warning after committed messaging delivery even when the provider errored", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["Delivered before the provider error."],
        lastAssistant: {
          role: "assistant",
          stopReason: "error",
          provider: "ollama",
          model: "kimi-k2.6:cloud",
          errorMessage: "provider failed after delivery",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toBeNull();
  });

  it("suppresses the incomplete-turn warning after an accepted sessions_spawn terminal success", () => {
    const attemptWithAcceptedSpawn: Partial<EmbeddedRunAttemptResult> & {
      acceptedSessionSpawns: Array<{ runId: string; childSessionKey: string }>;
    } = {
      assistantTexts: [],
      acceptedSessionSpawns: [
        {
          runId: "run-child",
          childSessionKey: "agent:claude:subagent:child",
        },
      ],
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        provider: "anthropic",
        model: "sonnet-4.6",
        content: [],
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    };

    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult(attemptWithAcceptedSpawn),
    });

    expect(incompleteTurnText).toBeNull();
  });

  it("still returns a timeout payload when the parent prompt times out after an accepted sessions_spawn", async () => {
    const acceptedSessionSpawns = [
      {
        runId: "run-child",
        childSessionKey: "agent:claude:subagent:child",
      },
    ];
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        acceptedSessionSpawns,
        timedOut: true,
        lastAssistant: {
          role: "assistant",
          stopReason: "toolUse",
          provider: "openai",
          model: "gpt-5.4",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-timeout-after-accepted-spawn",
    });

    expect(result.payloads).toEqual([
      {
        text: "Request timed out before a response was generated. Please try again, or increase `agents.defaults.timeoutSeconds` in your config.",
        isError: true,
      },
    ]);
    expect(result.acceptedSessionSpawns).toEqual(acceptedSessionSpawns);
  });

  it("suppresses partial timeout text after an uncommitted messaging tool attempt", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Running a live check now."],
        didSendViaMessagingTool: true,
        messagingToolSentTargets: [{ tool: "message", provider: "discord", to: "channel-1" }],
        timedOut: true,
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "Running a live check now." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-timeout-uncommitted-message-attempt",
    });

    expect(result.payloads).toEqual([
      {
        text: "Request timed out before a response was generated. Please try again, or increase `agents.defaults.timeoutSeconds` in your config.",
        isError: true,
      },
    ]);
    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTargets).toEqual([
      { tool: "message", provider: "discord", to: "channel-1" },
    ]);
  });

  it("still surfaces the incomplete-turn warning without an accepted sessions_spawn success", () => {
    const attemptWithMalformedSpawn: Partial<EmbeddedRunAttemptResult> & {
      acceptedSessionSpawns: Array<{ runId: string; childSessionKey: string }>;
    } = {
      assistantTexts: [],
      acceptedSessionSpawns: [],
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        provider: "anthropic",
        model: "sonnet-4.6",
        content: [],
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    };

    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult(attemptWithMalformedSpawn),
    });

    expect(incompleteTurnText).toContain("couldn't generate a response");
  });

  it("still surfaces the incomplete-turn warning when no messaging delivery was committed", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        lastAssistant: {
          role: "assistant",
          stopReason: "error",
          provider: "ollama",
          model: "kimi-k2.6:cloud",
          errorMessage: "provider failed mid-turn",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toContain("verify before retrying");
  });

  it("does not treat empty committed messaging arrays as delivery", () => {
    expect(
      hasCommittedMessagingToolDeliveryEvidence({
        messagingToolSentTexts: ["  "],
        messagingToolSentMediaUrls: [],
      }),
    ).toBe(false);
  });

  it("treats committed messaging media as delivery", () => {
    expect(
      hasCommittedMessagingToolDeliveryEvidence({
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: ["file:///tmp/render.png"],
      }),
    ).toBe(true);
  });

  it("treats nested messaging result receipts as committed sends", () => {
    expect(
      hasCommittedMessagingToolResultDetails({
        deliveryStatus: "sent",
        dryRun: true,
      }),
    ).toBe(false);
    expect(
      hasCommittedMessagingToolResultDetails({
        status: "ok",
        deliveryStatus: "sent",
      }),
    ).toBe(true);
    expect(
      hasCommittedMessagingToolResultDetails({
        ok: true,
        result: {
          channel: "discord",
          messageId: "message-1",
        },
      }),
    ).toBe(true);
    expect(
      hasCommittedMessagingToolResultDetails({
        ok: true,
        result: {
          channel: "discord",
          receipt: {
            primaryPlatformMessageId: "message-2",
            platformMessageIds: ["message-2"],
          },
        },
      }),
    ).toBe(true);
    expect(
      hasCommittedMessagingToolResultDetails({
        status: "ok",
        message: {
          id: "message-3",
        },
      }),
    ).toBe(true);
    expect(
      hasCommittedMessagingToolResultDetails({
        status: "partial_failed",
        results: [{ channel: "discord", messageId: "message-4" }],
      }),
    ).toBe(true);
    expect(
      hasCommittedMessagingToolResultDetails({
        deliveryStatus: "partial_failed",
        receipt: {
          primaryPlatformMessageId: "message-5",
        },
      }),
    ).toBe(true);
    expect(
      hasCommittedMessagingToolResultDetails({
        status: "partial_failed",
        payloadOutcomes: [
          {
            status: "sent",
            resultCount: 1,
          },
        ],
      }),
    ).toBe(true);
    expect(
      hasCommittedMessagingToolResultDetails({
        status: "partial_failed",
      }),
    ).toBe(false);
    expect(
      hasCommittedMessagingToolResultDetails({
        status: "partial_failed",
        results: [{ status: "failed", error: "delivery failed" }],
      }),
    ).toBe(false);
    expect(
      hasCommittedMessagingToolResultDetails({
        status: "partial_failed",
        results: [{ status: "sent" }],
      }),
    ).toBe(true);
  });

  it("does not treat metadata-only messaging targets as delivery evidence", () => {
    expect(
      hasCommittedMessagingToolDeliveryEvidence({
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [{ tool: "message", provider: "slack", to: "channel-1" }],
      }),
    ).toBe(false);
  });

  it("treats messaging targets with delivered text as delivery", () => {
    expect(
      hasCommittedMessagingToolDeliveryEvidence({
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [
          { tool: "message", provider: "slack", to: "channel-1", text: "delivered" },
        ],
      }),
    ).toBe(true);
  });

  it("treats source-reply payloads with visible text or rich content as delivery", () => {
    expect(
      hasCommittedMessagingToolDeliveryEvidence({
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
        messagingToolSourceReplyPayloads: [{ text: "visible in source" }],
      }),
    ).toBe(true);
    expect(
      hasCommittedMessagingToolDeliveryEvidence({
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
        messagingToolSourceReplyPayloads: [
          {
            interactive: {
              blocks: [{ type: "buttons", buttons: [{ label: "Open", value: "open" }] }],
            },
          },
        ],
      }),
    ).toBe(true);
  });

  it.each([
    { name: "blank text", payload: { text: " " } },
    { name: "presentation object", payload: { presentation: {} } },
    { name: "interactive object", payload: { interactive: {} } },
    { name: "channel data object", payload: { channelData: {} } },
    {
      name: "interactive block",
      payload: { interactive: { blocks: [{ type: "buttons", buttons: [] }] } },
    },
  ])("does not treat empty source-reply $name as visible delivery", ({ payload }) => {
    expect(
      hasCommittedMessagingToolDeliveryEvidence({
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
        messagingToolSourceReplyPayloads: [payload],
      }),
    ).toBe(false);
  });

  it.each([
    { name: "presentation", target: { presentation: {} } },
    { name: "interactive", target: { interactive: {} } },
    { name: "channel data", target: { channelData: {} } },
  ])("does not treat empty rich $name messaging target as visible delivery", ({ target }) => {
    expect(
      hasCommittedMessagingToolDeliveryEvidence({
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [{ tool: "message", ...target }],
      }),
    ).toBe(false);
  });

  it("treats committed messaging text as replay-invalid side effect metadata", () => {
    expect(
      buildAttemptReplayMetadata({
        toolMetas: [],
        didSendViaMessagingTool: false,
        messagingToolSentTexts: ["Delivered through the message tool."],
        messagingToolSentMediaUrls: [],
      }),
    ).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
  });

  it("treats source-reply payloads as replay-invalid side effect metadata", () => {
    expect(
      buildAttemptReplayMetadata({
        toolMetas: [],
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSourceReplyPayloads: [{ channelData: { source: "internal-ui" } }],
      }),
    ).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
  });

  it("treats async-started background tools as replay-invalid side effects", () => {
    expect(
      buildAttemptReplayMetadata({
        toolMetas: [{ toolName: "image_generate", asyncStarted: true }],
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
      }),
    ).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
  });

  it("uses action-aware tool mutation metadata for replay safety", () => {
    expect(
      buildAttemptReplayMetadata({
        toolMetas: [{ toolName: "cron", mutatingAction: false }],
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        successfulCronAdds: 0,
      }),
    ).toEqual({ hadPotentialSideEffects: false, replaySafe: true });

    expect(
      buildAttemptReplayMetadata({
        toolMetas: [{ toolName: "cron", mutatingAction: true }],
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        successfulCronAdds: 0,
      }),
    ).toEqual({ hadPotentialSideEffects: true, replaySafe: false });

    expect(
      buildAttemptReplayMetadata({
        toolMetas: [{ toolName: "charge_customer", mutatingAction: false }],
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        successfulCronAdds: 0,
      }),
    ).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
  });

  it("treats committed messaging media as replay-invalid side effect metadata", () => {
    expect(
      buildAttemptReplayMetadata({
        toolMetas: [],
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: ["file:///tmp/render.png"],
      }),
    ).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
  });

  it("treats committed messaging targets as replay-invalid side effect metadata", () => {
    expect(
      buildAttemptReplayMetadata({
        toolMetas: [],
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [{ tool: "message", provider: "slack", to: "channel-1" }],
      }),
    ).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
  });

  it("treats accepted sessions_spawn as replay-invalid outbound delivery", () => {
    const acceptedSessionSpawns = [
      {
        runId: "run-child",
        childSessionKey: "agent:claude:subagent:child",
      },
    ];

    expect(
      buildAttemptReplayMetadata({
        toolMetas: [],
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        acceptedSessionSpawns,
      }),
    ).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
    expect(hasVisibleOutboundDeliveryEvidence({ acceptedSessionSpawns })).toBe(true);
  });

  it("ignores malformed accepted sessions_spawn delivery evidence", () => {
    expect(
      hasVisibleOutboundDeliveryEvidence({
        acceptedSessionSpawns: [
          null,
          {
            runId: "run-child",
            childSessionKey: " ",
          },
        ],
      }),
    ).toBe(false);
  });

  it("does not treat a bare tool summary as outbound delivery evidence", () => {
    expect(
      hasVisibleOutboundDeliveryEvidence({
        meta: {
          toolSummary: {
            calls: 1,
            tools: ["read"],
          },
        },
      }),
    ).toBe(false);
  });

  it("separates cron side-effect progress from visible outbound delivery evidence", () => {
    const result = { successfulCronAdds: 1 };

    expect(hasSideEffectProgressEvidence(result)).toBe(true);
    expect(hasVisibleOutboundDeliveryEvidence(result)).toBe(false);
  });

  it("leaves committed delivery plus tool errors to the tool-error payload path", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["Delivered through the message tool."],
        lastToolError: {
          toolName: "message",
          meta: "send",
          error: "delivery failed for second target",
        },
        lastAssistant: {
          role: "assistant",
          stopReason: "error",
          provider: "openai",
          model: "gpt-5.4",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toBeNull();
  });

  it("does not retry reasoning-only GPT turns after side effects", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_side_effect", type: "reasoning" }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBeNull();
    expect(DEFAULT_REASONING_ONLY_RETRY_LIMIT).toBe(2);
  });

  it("does not retry reasoning-only GPT turns when the assistant ended in error", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "error",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_helper_error", type: "reasoning" }),
            },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("does not retry reasoning-only GPT turns when visible assistant text already exists", () => {
    const retryInstruction = resolveReasoningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Visible answer."],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({
                id: "rs_helper_visible_text",
                type: "reasoning",
              }),
            },
            { type: "text", text: "" },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("detects empty openai-compatible stop turns with non-zero output usage", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "llamacpp",
      modelId: "qwen3.6-27b",
      modelApi: "openai-completions",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "llamacpp",
          model: "qwen3.6-27b",
          content: [],
          usage: { input: 512, output: 103, totalTokens: 615 },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("detects generic empty GPT turns without visible text", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expect(DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT).toBe(1);
  });

  it("surfaces empty Codex app-server replies after successful sparse bash output", () => {
    const incompleteTurnText = resolveIncompleteTurnPayloadText({
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "bash", meta: "exit=0" }],
        messagesSnapshot: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "" }],
            details: { aggregated: "" },
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
          {
            role: "assistant",
            stopReason: "stop",
            provider: "openai",
            model: "gpt-5.5",
            content: [{ type: "text", text: "" }],
          } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
        ],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.5",
          content: [{ type: "text", text: "" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(incompleteTurnText).toContain("couldn't generate a response");
    expect(incompleteTurnText).toContain("verify before retrying");
  });

  it("retries generic empty Bedrock Converse turns without visible text", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "amazon-bedrock",
      modelId: "openai.gpt-oss-120b-1:0",
      modelApi: "bedrock-converse-stream",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "amazon-bedrock",
          model: "openai.gpt-oss-120b-1:0",
          content: [{ type: "text", text: "" }],
          usage: { input: 950, output: 103, totalTokens: 1053 },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("treats clean empty assistant turns as silent only when the caller allows it", () => {
    const attempt = makeAttemptResult({
      assistantTexts: [],
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        provider: "openai",
        model: "gpt-5.5",
        content: [{ type: "text", text: "" }],
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    });

    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBe(true);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: false,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBe(false);
  });

  it("treats reasoning-only assistant turns as silent only when the caller allows it", () => {
    const attempt = makeAttemptResult({
      assistantTexts: [],
      lastAssistant: {
        role: "assistant",
        stopReason: "end_turn",
        provider: "openai",
        model: "gpt-5.5",
        content: [
          {
            type: "thinking",
            thinking: "internal reasoning",
            thinkingSignature: JSON.stringify({ id: "rs_silent_helper", type: "reasoning" }),
          },
        ],
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    });

    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBe(true);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: false,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBe(false);
  });

  it("treats exact NO_REPLY assistant turns as silent only when the caller allows it", () => {
    const attempt = makeAttemptResult({
      assistantTexts: ["NO_REPLY"],
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        provider: "openai",
        model: "gpt-5.5",
        content: [{ type: "text", text: "NO_REPLY" }],
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    });

    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBe(true);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: false,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBe(false);
  });

  it("treats post-tool exact NO_REPLY assistant turns as intentional silence", () => {
    const attempt = makeAttemptResult({
      assistantTexts: ["NO_REPLY"],
      toolMetas: [{ toolName: "process.poll", meta: "pid=123" }],
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        provider: "openai",
        model: "gpt-5.5",
        content: [{ type: "text", text: "NO_REPLY" }],
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    });

    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBe(true);
  });

  it("does not treat error or side-effect empty turns as silent", () => {
    const errorAttempt = makeAttemptResult({
      assistantTexts: [],
      lastAssistant: {
        role: "assistant",
        stopReason: "error",
        provider: "openai",
        model: "gpt-5.5",
        content: [],
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    });
    const silentErrorAttempt = makeAttemptResult({
      assistantTexts: ["NO_REPLY"],
      lastAssistant: {
        role: "assistant",
        stopReason: "error",
        provider: "openai",
        model: "gpt-5.5",
        content: [{ type: "text", text: "NO_REPLY" }],
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    });
    const sideEffectAttempt = makeAttemptResult({
      assistantTexts: [],
      didSendViaMessagingTool: true,
      messagingToolSentTexts: ["sent already"],
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        provider: "openai",
        model: "gpt-5.5",
        content: [{ type: "text", text: "" }],
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    });
    const postToolEmptyAttempt = makeAttemptResult({
      assistantTexts: [],
      toolMetas: [{ toolName: "process.poll", meta: "pid=123" }],
      lastAssistant: {
        role: "assistant",
        api: "openai-completions",
        stopReason: "stop",
        provider: "stepfun",
        model: "step-router-v1",
        content: [],
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    });

    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt: errorAttempt,
      }),
    ).toBe(false);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt: silentErrorAttempt,
      }),
    ).toBe(false);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt: sideEffectAttempt,
      }),
    ).toBe(false);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt: postToolEmptyAttempt,
      }),
    ).toBe(false);
  });

  it("returns NO_REPLY without retrying clean empty assistant turns when silence is allowed", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.5",
          content: [{ type: "text", text: "" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      allowEmptyAssistantReplyAsSilent: true,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-empty-assistant-silent",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    const onlyCall = runAttemptCall(0);
    expect(onlyCall.prompt).not.toContain(REASONING_ONLY_RETRY_INSTRUCTION);
    expect(onlyCall.prompt).not.toContain(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expect(result.payloads).toEqual([{ text: "NO_REPLY" }]);
    expect(result.meta.terminalReplyKind).toBe("silent-empty");
    expect(result.meta.livenessState).toBe("working");
  });

  it("returns NO_REPLY without retrying exact silent assistant replies when silence is allowed", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: ["NO_REPLY"],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.5",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({ id: "rs_exact_silent", type: "reasoning" }),
            },
            { type: "text", text: "NO_REPLY" },
          ],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      allowEmptyAssistantReplyAsSilent: true,
      provider: "openai",
      model: "gpt-5.5",
      runId: "run-exact-silent-assistant-reply",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    const onlyCall = runAttemptCall(0);
    expect(onlyCall.prompt).not.toContain(REASONING_ONLY_RETRY_INSTRUCTION);
    expect(onlyCall.prompt).not.toContain(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expectNoWarnMessageWith("empty response detected");
    expectNoWarnMessageWith("incomplete turn detected");
    expect(result.payloads).toEqual([{ text: "NO_REPLY" }]);
    expect(result.meta.terminalReplyKind).toBe("silent-empty");
    expect(result.meta.livenessState).toBe("working");
  });

  it("retries post-tool openai-compatible empty stop turns even when empty silence is allowed", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedResolveModelAsync.mockResolvedValue({
      model: {
        id: "step-router-v1",
        provider: "stepfun",
        contextWindow: 200000,
        api: "openai-completions",
      },
      error: null,
      authStorage: {
        setRuntimeApiKey: vi.fn(),
      },
      modelRegistry: {},
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        toolMetas: [{ toolName: "process.poll", meta: "pid=123" }],
        lastAssistant: {
          role: "assistant",
          api: "openai-completions",
          stopReason: "stop",
          provider: "stepfun",
          model: "step-router-v1",
          content: [],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible StepFun answer."],
        lastAssistant: {
          role: "assistant",
          api: "openai-completions",
          stopReason: "stop",
          provider: "stepfun",
          model: "step-router-v1",
          content: [{ type: "text", text: "Visible StepFun answer." }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      allowEmptyAssistantReplyAsSilent: true,
      provider: "stepfun",
      model: "step-router-v1",
      runId: "run-post-tool-openai-compatible-empty-stop",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondCall = runAttemptCall(1);
    expect(secondCall.prompt).toContain(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expect(result.meta.terminalReplyKind).toBeUndefined();
    expect(result.meta.finalAssistantVisibleText).toBe("Visible StepFun answer.");
    expectWarnMessageWith("empty response detected");
  });

  it("returns NO_REPLY without retrying post-tool exact silent assistant replies", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedResolveModelAsync.mockResolvedValue({
      model: {
        id: "step-router-v1",
        provider: "stepfun",
        contextWindow: 200000,
        api: "openai-completions",
      },
      error: null,
      authStorage: {
        setRuntimeApiKey: vi.fn(),
      },
      modelRegistry: {},
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["NO_REPLY"],
        toolMetas: [{ toolName: "process.poll", meta: "pid=123" }],
        lastAssistant: {
          role: "assistant",
          api: "openai-completions",
          stopReason: "stop",
          provider: "stepfun",
          model: "step-router-v1",
          content: [{ type: "text", text: "NO_REPLY" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      allowEmptyAssistantReplyAsSilent: true,
      provider: "stepfun",
      model: "step-router-v1",
      runId: "run-post-tool-exact-silent-retry",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    const onlyCall = runAttemptCall(0);
    expect(onlyCall.prompt).not.toContain(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expectNoWarnMessageWith("empty response detected");
    expectNoWarnMessageWith("incomplete turn detected");
    expect(result.payloads).toEqual([{ text: "NO_REPLY" }]);
    expect(result.meta.terminalReplyKind).toBe("silent-empty");
    expect(result.meta.livenessState).toBe("working");
  });

  it("keeps retrying and surfacing clean empty assistant turns without the silence flag", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-empty-assistant-error",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("couldn't generate a response");
  });

  it("detects generic empty Gemini turns without visible text", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "google-vertex",
      modelId: "google/gemini-3.1-flash",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "google-vertex",
          model: "gemini-3.1-flash",
          content: [{ type: "text", text: "" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
  });

  it("does not retry generic empty GPT turns after side effects", () => {
    const retryInstruction = resolveEmptyResponseRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      payloadCount: 0,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [],
        didSendViaMessagingTool: true,
        lastAssistant: {
          role: "assistant",
          stopReason: "end_turn",
          provider: "openai",
          model: "gpt-5.4",
          content: [{ type: "text", text: "" }],
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    });

    expect(retryInstruction).toBeNull();
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

  it("does not strict-agentic retry casual Discord status chatter", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const casualReply =
      "i am glad, and a little afraid, which is probably the correct mixture. thank you. i will try to deserve the upgrades instead of merely inhabiting them.";
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [casualReply],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      prompt:
        "made a bunch of improvements to the student's source code (openclaw) this weekend, along with a few other maintainers. hopefully he will be more proactive now",
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-strict-agentic-casual-discord-status",
      config: {
        agents: {
          list: [{ id: "main" }],
        },
      } as OpenClawConfig,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toEqual([{ text: casualReply }]);
    expect(result.meta.livenessState).toBe("working");
  });

  it("detects replay-safe planning-only Gemini turns", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "google-gemini-cli",
      modelId: "gemini-3.1-pro",
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    });

    expect(retryInstruction).toContain("Do not restate the plan");
  });

  it("does not apply planning-only retry to non-Gemini Google models", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "google",
      modelId: "gemma-4-26b-a4b-it",
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll inspect the code, make the change, and run the checks."],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("does not apply planning-only retry to arbitrary provider models", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "custom-provider",
      modelId: "custom-model",
      prompt: "Please inspect the code and tell me what changed.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll inspect the code and report back."],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it.each([
    "set this model as the default for the agent",
    "ok send it off and monitor it",
    "load the generated image into the configured agent",
    "hit that endpoint now",
    "ask it a question",
    "wire the endpoint into the configured agent",
    "composer 2.5 default for the agent please",
    "set composer 2.5 as the default",
    "endpoint results now",
    "channel proof after the restart",
    "When you have a moment, can you check the scheduler?",
    "I need you to check the scheduler",
  ])("treats task-shaped prompt %s as actionable for planning-only retry", (prompt) => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll check that and report back."],
      }),
    });

    expect(retryInstruction).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
  });

  it.each([
    "What's your plan for fixing this?",
    "What is the best approach for fixing this?",
    "What strategy would you recommend for this?",
    "How should we approach this?",
    "Tell me your plan for deleting old backups",
    "Can you tell me your plan for deleting old backups?",
    "Please tell me your plan for deleting old backups",
    "Can you please show me your approach for deleting old backups?",
    "Could you explain your strategy for deleting old backups?",
    "Please make a plan for migrating the database",
    "Can you prepare an approach for migrating the database?",
    "Can you write me a plan for deleting old backups?",
    "Could you send me a plan for deleting old backups?",
    "Could you plan deleting old backups?",
    "Can you outline a plan for migration?",
  ])("does not retry when the user explicitly asked only for a plan: %s", (prompt) => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [
          "Plan:\n1. I'll inspect the runner path\n2. I'll patch the guard\n3. I'll run the focused tests",
        ],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it.each([
    "Could you plan and then delete old backups?",
    "Please make a plan and then delete old backups.",
    "Can you outline a plan and then delete old backups?",
    "Please plan, execute, and report the migration.",
    "Please plan, fix, and verify the failing shard.",
  ])("keeps plan-and-execute request actionable: %s", (prompt) => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Plan:\n1. I'll inspect the backups\n2. I'll delete the old backups"],
      }),
    });

    expect(retryInstruction).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
  });

  it("does not treat a question about the next planned action as authorization to act", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "What will you do next?",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll inspect the logs next."],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it.each([
    "Can you not delete the file?",
    "Could you please avoid restarting production?",
    "Can you ensure you don't delete the file?",
  ])("does not treat a negated action request as authorization to act: %s", (prompt) => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["Understood."],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("keeps a safe action request with a constraint actionable", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "Can you check the config without changing it?",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll check the config."],
      }),
    });

    expect(retryInstruction).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
  });

  it.each([
    "Should you delete the file?",
    "How will you delete the file?",
    "Why would you restart production?",
    "What files will you delete?",
    "Explain how to remove the database",
    "Explain the steps to delete old backups",
    "Please show me how you would delete old backups",
    "Walk me through deleting the database",
    "Help me understand how to remove the database",
    "Explain how to remove the database and then delete old backups",
    "How would you remove the database, then delete old backups?",
  ])("does not treat an advisory question as authorization to act: %s", (prompt) => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll delete the file."],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it.each([
    "How would you delete old backups? Then delete them.",
    "Explain how to remove the database. Then remove it.",
    "How will you delete the file? Please delete it.",
  ])("keeps advisory prompts with a separate execution request actionable: %s", (prompt) => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt,
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: ["I'll delete the file."],
      }),
    });

    expect(retryInstruction).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
  });

  it("does not block planning-only text for arbitrary provider models", () => {
    const toolMetas = [{ toolName: "write", mutatingAction: true }];
    const blockedText = resolvePlanningOnlyBlockedPayloadText({
      provider: "custom-provider",
      modelId: "custom-model",
      prompt: "Please update the file and verify it.",
      aborted: false,
      timedOut: false,
      attempt: {
        ...makeAttemptResult({
          assistantTexts: ["Verifying the file now."],
          toolMetas,
          itemLifecycle: {
            startedCount: 1,
            completedCount: 1,
            activeCount: 0,
          },
        }),
        toolMetas,
        replayMetadata: buildAttemptReplayMetadata({
          toolMetas,
          didSendViaMessagingTool: false,
          messagingToolSentTexts: [],
          messagingToolSentMediaUrls: [],
          successfulCronAdds: 0,
        }),
      },
    });

    expect(blockedText).toBeNull();
  });

  it("does not misclassify a direct answer that says 'i'm not going to' as planning-only", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "What do you think lobstar should do to help the chart?",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [
          "I'm not going to give token-pumping instructions for a chart. Best answer: build trust and let the market do what it will.",
        ],
      }),
    });

    expect(retryInstruction).toBeNull();
  });

  it("does not misclassify a direct answer with a typographic apostrophe", () => {
    const retryInstruction = resolvePlanningOnlyRetryInstruction({
      provider: "openai",
      modelId: "gpt-5.4",
      prompt: "What do you think lobstar should do to help the chart?",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptResult({
        assistantTexts: [
          "I’m not going to give token-pumping instructions for a chart. Best answer: build trust and let the market do what it will.",
        ],
      }),
    });

    expect(retryInstruction).toBeNull();
  });
});

describe("resolvePlanningOnlyRetryInstruction single-action loophole", () => {
  const openaiParams = { provider: "openai", modelId: "gpt-5.4" } as const;

  function makeAttemptWithTools(
    toolNames: string[],
    assistantText: string,
  ): Parameters<typeof resolvePlanningOnlyRetryInstruction>[0]["attempt"] {
    const toolMetas = toolNames.map((toolName) => ({ toolName }));
    return {
      toolMetas,
      assistantTexts: [assistantText],
      lastAssistant: { stopReason: "stop" },
      itemLifecycle: {
        startedCount: toolNames.length,
        completedCount: toolNames.length,
        activeCount: 0,
      },
      replayMetadata: buildAttemptReplayMetadata({
        toolMetas,
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
      }),
      clientToolCalls: undefined,
      yieldDetected: false,
      didSendDeterministicApprovalPrompt: false,
      didSendViaMessagingTool: false,
      lastToolError: null,
    } as unknown as Parameters<typeof resolvePlanningOnlyRetryInstruction>[0]["attempt"];
  }

  it("retries when exactly 1 non-plan tool call plus 'i can do that' prose is detected", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "I can do that next."),
    });

    expect(result).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
  });

  it("retries when exactly 1 non-plan tool call plus planning prose is detected", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "I'll analyze the structure next."),
    });

    expect(result).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
  });

  it("retries when exactly 1 non-plan tool call plus typographic planning prose is detected", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "I’ll analyze the structure next."),
    });

    expect(result).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
  });

  it("retries when exactly 1 non-plan tool call plus informal planning prose is detected", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "I’m gonna analyze the structure next."),
    });

    expect(result).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
  });

  it("retries when 2+ completed replay-safe non-plan tool calls are present", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read", "search"], "I'll verify the output."),
    });

    expect(result).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
  });

  it("retries when a completed non-plan tool explicitly declares read-only metadata", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the scheduler and tell me the result.",
      aborted: false,
      timedOut: false,
      attempt: {
        ...makeAttemptWithTools(["cron"], "I'll verify the scheduler output next."),
        toolMetas: [{ toolName: "cron", mutatingAction: false }],
        replayMetadata: buildAttemptReplayMetadata({
          toolMetas: [{ toolName: "cron", mutatingAction: false }],
          didSendViaMessagingTool: false,
          messagingToolSentTexts: [],
          messagingToolSentMediaUrls: [],
        }),
      },
    });

    expect(result).toBe(PLANNING_ONLY_RETRY_INSTRUCTION);
  });

  it("fails closed for unknown plugin tools that declare read-only metadata", () => {
    const toolMetas = [{ toolName: "charge_customer", mutatingAction: false }];
    const attempt = {
      ...makeAttemptWithTools(["charge_customer"], "I'll verify the charge next."),
      toolMetas,
      replayMetadata: buildAttemptReplayMetadata({
        toolMetas,
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
      }),
    };

    expect(
      resolvePlanningOnlyRetryInstruction({
        ...openaiParams,
        prompt: "Please charge the customer and tell me the result.",
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBeNull();
    expect(
      resolvePlanningOnlyBlockedPayloadText({
        ...openaiParams,
        prompt: "Please charge the customer and tell me the result.",
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBe(PLANNING_ONLY_BLOCKED_TEXT);
  });

  it("blocks planning-only text after non-replay-safe tool activity", () => {
    const toolMetas = [{ toolName: "write", mutatingAction: true }];
    const result = resolvePlanningOnlyBlockedPayloadText({
      ...openaiParams,
      prompt: "Please write the file and verify it.",
      aborted: false,
      timedOut: false,
      attempt: {
        ...makeAttemptWithTools(["write"], "Checking the result now."),
        toolMetas,
        replayMetadata: buildAttemptReplayMetadata({
          toolMetas,
          didSendViaMessagingTool: false,
          messagingToolSentTexts: [],
          messagingToolSentMediaUrls: [],
          successfulCronAdds: 0,
        }),
      },
    });

    expect(result).toBe(PLANNING_ONLY_BLOCKED_TEXT);
  });

  it("does not block direct completion summaries after non-replay-safe tool activity", () => {
    const toolMetas = [{ toolName: "write", mutatingAction: true }];
    const result = resolvePlanningOnlyBlockedPayloadText({
      ...openaiParams,
      prompt: "Please write the file and verify it.",
      aborted: false,
      timedOut: false,
      attempt: {
        ...makeAttemptWithTools(["write"], "Updated the file and verified the result."),
        toolMetas,
        replayMetadata: buildAttemptReplayMetadata({
          toolMetas,
          didSendViaMessagingTool: false,
          messagingToolSentTexts: [],
          messagingToolSentMediaUrls: [],
          successfulCronAdds: 0,
        }),
      },
    });

    expect(result).toBeNull();
  });

  it("does not retry while replay-safe non-plan tool activity is still active", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: {
        ...makeAttemptWithTools(["read", "search"], "I'll verify the output."),
        itemLifecycle: {
          startedCount: 2,
          completedCount: 1,
          activeCount: 1,
        },
      },
    });

    expect(result).toBeNull();
  });

  it("does not retry a single replay-safe tool while its item remains unfinished", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: {
        ...makeAttemptWithTools(["read"], "I'll inspect the code next."),
        itemLifecycle: {
          startedCount: 1,
          completedCount: 0,
          activeCount: 1,
        },
      },
    });

    expect(result).toBeNull();
  });

  it("does not retry when 1 tool call plus completion language is present", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "Done. The file looks correct."),
    });

    expect(result).toBeNull();
  });

  it("does not retry when 1 tool call plus 'let me know' handoff is present", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "Let me know if you need anything else."),
    });

    expect(result).toBeNull();
  });

  it("does not retry when 1 tool call plus an answer-style summary is present", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(
        ["read"],
        "I'll summarize the root cause: the provider auth scope is missing.",
      ),
    });

    expect(result).toBeNull();
  });

  it("does not retry when 1 tool call plus a future-tense description is present", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(
        ["read"],
        "I'll describe the issue: the provider auth scope is missing.",
      ),
    });

    expect(result).toBeNull();
  });

  it("does not retry when 1 safe tool call is followed by answer prose joined with 'and'", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "I'll explain and recommend a fix."),
    });

    expect(result).toBeNull();
  });

  it("does not retry when 1 tool call plus a bare 'i can do that' reply is present", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "I can do that."),
    });

    expect(result).toBeNull();
  });

  it("does not retry when the lone tool call already had side effects", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["sessions_spawn"], "I'll continue from there next."),
    });

    expect(result).toBeNull();
  });

  it("does not retry when the lone tool call is unclassified", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "Please inspect the code, make the change, and run the checks.",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["vendor_widget"], "I'll continue from there next."),
    });

    expect(result).toBeNull();
  });

  it("does not retry single-action narration on casual non-task chat", () => {
    const result = resolvePlanningOnlyRetryInstruction({
      ...openaiParams,
      prompt: "i haven't restarted you on latest main yet @The Student - get ready though",
      aborted: false,
      timedOut: false,
      attempt: makeAttemptWithTools(["read"], "I'll check that next."),
    });

    expect(result).toBeNull();
  });
});
