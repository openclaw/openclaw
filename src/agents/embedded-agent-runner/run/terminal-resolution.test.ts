import { beforeEach, describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { classifyAgentExecResult } from "../../../commands/agent-exec-result.js";
import { createMediaGenerationOperation } from "../../media-generation-activity.js";
import { resetGeneratedMediaTaskActivityForTests } from "../../media-generation-activity.test-support.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  markEmbeddedRunAuthProfileSuccess,
  reportEmbeddedRunSuccessfulAuthBinding,
} from "./auth-profile-success.js";
import { TRUNCATED_REPLY_NOTICE_TEXT } from "./incomplete-turn-resolution.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { emptyAssistant, makeTerminalInput } from "./terminal-resolution.test-support.js";
import { createEmbeddedRunTerminalRetryState } from "./terminal-retry-state.js";

vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

const REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";

describe("terminal resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGeneratedMediaTaskActivityForTests();
  });

  it("completes an empty post-tool turn after committed media delivery", async () => {
    const hasToolMediaBlockReply = true;
    const assistant = emptyAssistant();
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      toolMetas: [{ toolName: "tts", isError: false, replaySafe: false }],
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      hasToolMediaBlockReply,
    });
    const input = makeTerminalInput({ attempt });

    const resolved = await resolveEmbeddedRunTerminal(input);

    expect(resolved.action).toBe("complete");
    expect(input.sessionPromptState.activateInternalPrompt).not.toHaveBeenCalled();
    if (resolved.action !== "complete") {
      throw new Error("expected terminal resolution to complete");
    }
    expect(resolved.result.meta.error).toBeUndefined();
    expect(resolved.result.payloads ?? []).toEqual([]);
  });

  it.each(["empty", "reasoning", "cleanup"])(
    "preserves a failed harness turn instead of retrying its %s output",
    async (output) => {
      const error = new Error("Provider failed while a tool was pending");
      const cleanupFailed = output !== "empty" && output !== "reasoning";
      const partialText = "The first operation finished.";
      const assistant =
        output === "reasoning"
          ? buildEmbeddedRunnerAssistant({ content: [{ type: "thinking", thinking: "checking" }] })
          : cleanupFailed
            ? buildEmbeddedRunnerAssistant({
                stopReason: "toolUse",
                content: [{ type: "text", text: partialText }],
              })
            : undefined;
      const payloads = cleanupFailed ? undefined : [];
      const attempt = makeEmbeddedRunnerAttempt({
        terminal: { kind: "failed", source: "prompt", error },
        assistantTexts: [],
        currentAttemptAssistant: assistant,
        lastAssistant: assistant,
        lastToolError: cleanupFailed
          ? { toolName: "exec", error: "Tool execution aborted" }
          : undefined,
        toolMetas: cleanupFailed ? [{ toolName: "exec", isError: true, replaySafe: false }] : [],
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        replayMetadata: { hadPotentialSideEffects: cleanupFailed, replaySafe: false },
      });
      const onSuccessfulAuthProfile = vi.fn();
      const input = makeTerminalInput({
        attempt,
        payloadsWithToolMedia: payloads,
        authProfileId: "openai:selected",
        runParams: { onSuccessfulAuthProfile },
      });

      const resolved = await resolveEmbeddedRunTerminal(input);

      expect(resolved).toMatchObject({
        action: "complete",
        result: { meta: { error: { message: error.message, fallbackSafe: false } } },
      });
      expect(input.sessionPromptState.activateInternalPrompt).not.toHaveBeenCalled();
      expect(input.sessionPromptState.suppressNextUserMessagePersistence).toBe(false);
      expect(input.armPostCompactionGuard).not.toHaveBeenCalled();
      expect(markEmbeddedRunAuthProfileSuccess).not.toHaveBeenCalled();
      expect(reportEmbeddedRunSuccessfulAuthBinding).not.toHaveBeenCalled();
      expect(onSuccessfulAuthProfile).not.toHaveBeenCalled();
      expect(input.setTerminalLifecycleMeta).toHaveBeenCalledWith(
        expect.objectContaining({ livenessState: "abandoned" }),
      );
      if (resolved.action === "complete") {
        expect(classifyAgentExecResult(resolved.result).status).toBe("error");
        expect(resolved.result.meta.executionTrace?.attempts ?? []).not.toContainEqual(
          expect.objectContaining({ result: "success" }),
        );
        if (cleanupFailed) {
          expect(resolved.result.payloads ?? []).toEqual(payloads ?? []);
          expect(resolved.result.messagingToolSentTexts).toEqual(attempt.messagingToolSentTexts);
        }
      }
    },
  );

  it("keeps external cancellation ahead of a failed attempt during final result construction", async () => {
    const assistant = emptyAssistant({ stopReason: "stop" });
    const attempt = makeEmbeddedRunnerAttempt({
      terminal: { kind: "failed", source: "prompt", error: new Error("Late provider failure") },
      lastToolError: { toolName: "exec", error: "Tool execution aborted" },
      currentAttemptAssistant: assistant,
      replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    });
    const terminalState = resolveEmbeddedRunAttemptTerminalState({
      attempt,
      assistant,
      abortSignal: AbortSignal.abort(),
    });
    const input = makeTerminalInput({ attempt, terminalState });
    const resolved = await resolveEmbeddedRunTerminal(input);
    expect(resolved).toMatchObject({ action: "complete", result: { meta: { aborted: true } } });
    if (resolved.action === "complete") {
      expect(resolved.result.meta.error).toBeUndefined();
      expect(resolved.result.meta.livenessState).toBe("blocked");
    }
    expect(input.sessionPromptState.activateInternalPrompt).not.toHaveBeenCalled();
  });

  it("completes NO_REPLY from an internal notification without retrying", async () => {
    const assistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: SILENT_REPLY_TOKEN }],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [SILENT_REPLY_TOKEN],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    const activateInternalPrompt = vi.fn();
    const input = makeTerminalInput({
      attempt,
      attemptAssistant: assistant,
      runParams: {
        allowEmptyAssistantReplyAsSilent: false,
        trigger: "user",
        inputProvenance: { kind: "inter_session", sourceTool: "subagent_announce" },
      },
      sessionPromptState: { activateInternalPrompt },
    });

    const resolved = await resolveEmbeddedRunTerminal(input);

    expect(resolved.action).toBe("complete");
    if (resolved.action !== "complete") {
      return;
    }
    expect(resolved.result.payloads).toEqual([{ text: SILENT_REPLY_TOKEN }]);
    expect(resolved.result.meta.terminalReplyKind).toBe("silent-empty");
    expect(resolved.result.meta.livenessState).toBe("working");
    expect(activateInternalPrompt).not.toHaveBeenCalled();
  });

  it("keeps an empty visible parent alive for accepted completion children", async () => {
    const attempt = makeEmbeddedRunnerAttempt({
      acceptedSessionSpawns: [
        {
          runId: "child-run",
          childSessionKey: "agent:main:subagent:child",
          expectsCompletionMessage: true,
        },
      ],
    });

    const resolved = await resolveEmbeddedRunTerminal(
      makeTerminalInput({
        attempt,
        runParams: { replyOperation: { turnKind: "visible" } as never },
      }),
    );

    expect(resolved).toMatchObject({
      result: {
        payloads: undefined,
        meta: { continuationPending: true },
        acceptedSessionSpawns: attempt.acceptedSessionSpawns,
      },
    });
  });

  // Live Telegram group: image_generate started, the model acknowledged with a
  // progress message (or said nothing), and the image arrives in a later turn.
  const detachedImageAttempt = (
    status: "running" | "succeeded",
    overrides: Parameters<typeof makeEmbeddedRunnerAttempt>[0] = {},
  ) => {
    createMediaGenerationOperation({
      taskId: "task-image",
      runId: "tool:image_generate:run-image",
      taskKind: "image_generation",
      requesterSessionKey: "agent:main:telegram:group:-100",
      requesterAgentId: "main",
      createdAt: Date.now(),
      status,
    });
    return makeEmbeddedRunnerAttempt({
      toolMetas: [
        {
          toolName: "image_generate",
          asyncStarted: true,
          asyncTaskRunId: "tool:image_generate:run-image",
        },
      ],
      ...overrides,
    });
  };
  const progressTarget = { tool: "message", provider: "telegram", text: "Making the image now." };
  const progressAck = {
    didSendViaMessagingTool: true,
    messagingToolSentTexts: ["Making the image now."],
    messagingToolSentTargets: [progressTarget],
  };

  it("keeps a running media turn pending after a non-final source reply", async () => {
    const overrides = {
      ...progressAck,
      didDeliverSourceReplyViaMessageTool: true,
      messagingToolSentTargets: [{ ...progressTarget, sourceReplyFinal: false }],
      messagingToolSourceReplyPayloads: [
        { text: "Making the image now.", sourceReplyFinal: false },
      ],
    };
    const resolved = await resolveEmbeddedRunTerminal(
      makeTerminalInput({
        attempt: detachedImageAttempt("running", overrides),
        runParams: { replyOperation: { turnKind: "visible" } as never },
      }),
    );

    expect(resolved).toMatchObject({
      action: "complete",
      result: { payloads: undefined, meta: { continuationPending: true } },
    });
  });

  it("completes a media turn when the model delivered its final reply", async () => {
    const status = "running" as const;
    const overrides = {
      ...progressAck,
      didDeliverSourceReplyViaMessageTool: true,
      messagingToolSourceReplyPayloads: [{ text: "Making the image now.", sourceReplyFinal: true }],
    };
    const resolved = await resolveEmbeddedRunTerminal(
      makeTerminalInput({
        attempt: detachedImageAttempt(status, overrides),
        runParams: { replyOperation: { turnKind: "visible" } as never },
      }),
    );

    expect(resolved.action).toBe("complete");
    if (resolved.action === "complete") {
      expect(resolved.result.meta.continuationPending).toBeUndefined();
    }
  });

  it.each([false, true])(
    "settles terminal tool batches only after successful results (error=%s)",
    async (isError) => {
      const terminalCall = {
        type: "toolCall" as const,
        id: "terminal-tool-call",
        name: "ask_user",
        arguments: {},
      };
      const assistant = buildEmbeddedRunnerAssistant({
        stopReason: "toolUse",
        content: [terminalCall],
      });
      const toolResult = {
        role: "toolResult" as const,
        toolCallId: terminalCall.id,
        toolName: terminalCall.name,
        content: [{ type: "text" as const, text: "The visible question was cancelled." }],
        isError,
        timestamp: 0,
      };
      const attempt = makeEmbeddedRunnerAttempt({
        assistantTexts: [],
        toolMetas: [{ toolName: terminalCall.name, toolCallId: terminalCall.id, terminate: true }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        messagesSnapshot: [
          {
            role: "user",
            content: [{ type: "text", text: "Ask the current question." }],
            timestamp: 0,
          },
          assistant,
          ...(!isError
            ? [
                buildEmbeddedRunnerAssistant({
                  content: [{ type: "text", text: "The question was already shown." }],
                }),
              ]
            : []),
          toolResult,
        ],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
      });
      const input = makeTerminalInput({
        attempt,
        attemptAssistant: assistant,
        replayState: { hadPotentialSideEffects: true, replayInvalid: true },
      });
      const resolved = await resolveEmbeddedRunTerminal(input);
      expect(resolved.action).toBe("complete");
      if (resolved.action === "complete") {
        expect(resolved.result.meta.intentionalTerminalCompletion).toBe(
          isError ? undefined : "tool-batch",
        );
        if (isError) {
          expect(resolved.result.meta.error?.kind).toBe("incomplete_turn");
          expect(resolved.result.payloads?.[0]?.isError).toBe(true);
        } else {
          expect(resolved.result.meta.error).toBeUndefined();
          expect(resolved.result.payloads).toBeUndefined();
          expect(resolved.result.meta.livenessState).toBe("working");
          expect(input.sessionPromptState.activateInternalPrompt).not.toHaveBeenCalled();
          expect(attempt.messagesSnapshot.at(-1)).toBe(toolResult);
        }
      }
    },
  );

  it("keeps a length-stopped silent cron result silent", async () => {
    // The only payload is the synthesized silent result of a successful tool and
    // the assistant produced no prose, so there is no partial reply to label; a
    // truncation notice here would turn intentional silence into a message.
    const assistant = emptyAssistant({ stopReason: "length" });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      toolMetas: [{ toolName: "exec" }],
      messagesSnapshot: [
        {
          role: "toolResult",
          content: [{ type: "text", text: SILENT_REPLY_TOKEN }],
          details: { aggregated: SILENT_REPLY_TOKEN },
        } as never,
        assistant,
      ],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
    });
    const input = makeTerminalInput({
      attempt,
      attemptAssistant: assistant,
      runParams: { trigger: "cron", terminalReplyExpectation: "required" },
    });

    const resolved = await resolveEmbeddedRunTerminal(input);

    expect(resolved.action).toBe("complete");
    if (resolved.action !== "complete") {
      return;
    }
    expect(resolved.result.payloads).toEqual([{ text: SILENT_REPLY_TOKEN }]);
  });

  it("marks explicit subagent silence at the terminal producer", async () => {
    const rawText = "NO_REPLY";
    const expectedKind = "silent-empty";
    const assistant = emptyAssistant({ content: [{ type: "text", text: rawText ?? "" }] });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: rawText ? [rawText] : [],
      toolMetas: [{ toolName: "write", replaySafe: false }],
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
    });
    const input = makeTerminalInput({
      attempt,
      attemptAssistant: assistant,
      finalAssistantRawText: rawText,
      replayState: { ...attempt.replayMetadata, replayInvalid: false },
      runParams: {
        lane: "subagent",
        allowEmptyAssistantReplyAsSilent: true,
        terminalReplyExpectation: "optional",
      },
    });

    const resolved = await resolveEmbeddedRunTerminal(input);

    expect(resolved.action).toBe("complete");
    if (resolved.action !== "complete") {
      return;
    }
    expect(resolved.result.meta.terminalReplyKind).toBe(expectedKind);
  });

  it("retries reasoning-only output and surfaces a retained presentation after exhaustion", async () => {
    const assistant = buildEmbeddedRunnerAssistant({
      content: [
        {
          type: "thinking",
          thinking: "internal reasoning",
          thinkingSignature: JSON.stringify({ id: "rs_terminal", type: "reasoning" }),
        },
      ],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    const activateInternalPrompt = vi.fn();
    const retryInput = makeTerminalInput({
      attempt,
      attemptAssistant: assistant,
      runParams: { allowEmptyAssistantReplyAsSilent: true, terminalReplyExpectation: "required" },
      sessionPromptState: { activateInternalPrompt },
    });

    await expect(resolveEmbeddedRunTerminal(retryInput)).resolves.toEqual({ action: "retry" });
    expect(activateInternalPrompt).toHaveBeenCalledWith(REASONING_ONLY_RETRY_INSTRUCTION);

    const exhaustedInput = makeTerminalInput({
      attempt,
      attemptAssistant: assistant,
      retryState: { ...createEmbeddedRunTerminalRetryState(), reasoningOnlyAttempts: 2 },
      readTerminalToolPresentation: () =>
        "Web fetch completed.\nOrigin: https://example.com\nStatus: 200",
    });
    const exhausted = await resolveEmbeddedRunTerminal(exhaustedInput);

    expect(exhausted.action).toBe("complete");
    if (exhausted.action !== "complete") {
      return;
    }
    expect(exhausted.result.payloads).toEqual([
      {
        text:
          "Web fetch completed.\nOrigin: https://example.com\nStatus: 200\n\n" +
          "⚠️ Agent couldn't generate a response. Please try again.",
        isError: true,
      },
    ]);
    expect(exhausted.result.meta.error).toMatchObject({
      kind: "incomplete_turn",
      fallbackSafe: true,
      terminalPresentation: true,
    });
  });

  it("suppresses duplicate user persistence when retrying a missing assistant", async () => {
    const activePromptPersisted = true;
    const expectedSuppression = true;
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: undefined,
      currentAttemptAssistant: undefined,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    const activateInternalPrompt = vi.fn();
    const input = makeTerminalInput({
      attempt,
      attemptAssistant: undefined,
      sessionPromptState: {
        activePrompt: { persisted: activePromptPersisted, internal: false },
        activateInternalPrompt,
      },
    });

    await expect(resolveEmbeddedRunTerminal(input)).resolves.toEqual({ action: "retry" });
    expect(input.sessionPromptState.suppressNextUserMessagePersistence).toBe(expectedSuppression);
    expect(activateInternalPrompt).not.toHaveBeenCalled();
  });

  it("activates the prompt owner for an OpenAI Responses compaction checkpoint", async () => {
    const assistant = buildEmbeddedRunnerAssistant({
      stopReason: "length",
      providerReplay: {
        v: 1,
        type: "openai-responses-compaction",
        id: "cmp-terminal-retry",
        data: "opaque-compaction",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.6-luna",
        baseUrlHash: "base-url-hash",
      },
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    const activateCompactionContinuation = vi.fn();
    const input = makeTerminalInput({
      attempt,
      attemptAssistant: assistant,
      sessionPromptState: { activateCompactionContinuation },
    });

    await expect(resolveEmbeddedRunTerminal(input)).resolves.toEqual({ action: "retry" });
    expect(activateCompactionContinuation).toHaveBeenCalledWith(
      expect.stringContaining("Continue from the compacted transcript"),
    );
    expect(input.armPostCompactionGuard).toHaveBeenCalledOnce();
  });

  it("reports completed-empty finalization for required replies", async () => {
    const assistant = emptyAssistant();
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      toolMetas: [{ toolName: "write", replaySafe: false }],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    });
    const resolved = await resolveEmbeddedRunTerminal(
      makeTerminalInput({
        attempt,
        attemptAssistant: assistant,
        runParams: {
          allowEmptyAssistantReplyAsSilent: true,
          terminalReplyExpectation: "required",
        },
        replayState: { hadPotentialSideEffects: true, replayInvalid: true },
        settledTurnFinalizationOutcome: "completed-empty",
      }),
    );
    expect(resolved.action).toBe("complete");
    if (resolved.action !== "complete") {
      return;
    }
    expect(resolved.result.payloads?.[0]).toMatchObject({ isError: true });
    expect(resolved.result.meta.error?.kind).toBe("incomplete_turn");
    expect(resolved.result.meta.terminalReplyKind).not.toBe("silent-empty");
  });

  it("delivers partial text with a truncation notice when the output budget ends", async () => {
    const assistant = buildEmbeddedRunnerAssistant({
      stopReason: "length",
      content: [{ type: "text", text: "Here is the first half of the answer" }],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: ["Here is the first half of the answer"],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    const resolved = await resolveEmbeddedRunTerminal(
      makeTerminalInput({
        attempt,
        attemptAssistant: assistant,
        payloadsWithToolMedia: [{ text: "Here is the first half of the answer" }],
      }),
    );

    expect(resolved.action).toBe("complete");
    if (resolved.action !== "complete") {
      return;
    }
    expect(resolved.result.payloads).toEqual([
      { text: "Here is the first half of the answer" },
      { text: TRUNCATED_REPLY_NOTICE_TEXT },
    ]);
    expect(resolved.result.meta.error).toBeUndefined();
    expect(resolved.result.meta.livenessState).toBe("working");
  });

  it("does not add a truncation notice to a length stop that already has terminal output", async () => {
    // Terminal tool media was already a complete outcome before this fix, so it
    // must not gain a notice telling the user to ask for a continuation.
    const assistant = buildEmbeddedRunnerAssistant({
      stopReason: "length",
      content: [{ type: "text", text: "Chart attached" }],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: ["Chart attached"],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      toolMediaUrls: ["https://example.invalid/chart.png"],
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    const resolved = await resolveEmbeddedRunTerminal(
      makeTerminalInput({
        attempt,
        attemptAssistant: assistant,
        payloadsWithToolMedia: [{ text: "Chart attached" }],
      }),
    );

    expect(resolved.action).toBe("complete");
    if (resolved.action !== "complete") {
      return;
    }
    expect(resolved.result.payloads).toEqual([{ text: "Chart attached" }]);
  });
});
