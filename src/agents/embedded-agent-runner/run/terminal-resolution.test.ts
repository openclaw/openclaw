import { beforeEach, describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { classifyAgentExecResult } from "../../../commands/agent-exec-result.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import { createMediaGenerationOperation } from "../../media-generation-activity.js";
import { resetGeneratedMediaTaskActivityForTests } from "../../media-generation-activity.test-support.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createUsageAccumulator } from "../usage-accumulator.js";
import {
  markEmbeddedRunAuthProfileSuccess,
  reportEmbeddedRunSuccessfulAuthBinding,
} from "./auth-profile-success.js";
import { TRUNCATED_REPLY_NOTICE_TEXT } from "./incomplete-turn-resolution.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";
import { prepareEmbeddedRunTerminal } from "./terminal-preparation.js";
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
    expect(resolved.result.payloads).toBeUndefined();
    expect(resolved.result.meta.terminalReply).toEqual({ disposition: "silent" });
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

  it.each([
    { provider: "openai", api: "openai-responses", narration: "none", isError: false },
    { provider: "openai", api: "openai-responses", narration: "commentary", isError: false },
    { provider: "openai", api: "openai-completions", narration: "unphased", isError: false },
    { provider: "anthropic", api: "anthropic-messages", narration: "unphased", isError: false },
    { provider: "ollama", api: "ollama", narration: "unphased", isError: false },
    { provider: "google", api: "google-generative-ai", narration: "unphased", isError: false },
    { provider: "mistral", api: "mistral-conversations", narration: "unphased", isError: false },
    { provider: "ollama", api: "ollama", narration: "unphased", isError: true },
  ])(
    "settles $provider terminal tools with $narration narration only after success (error=$isError)",
    async ({ provider, api, narration, isError }) => {
      const text = "Let me ask which option you prefer.";
      const terminalCall = {
        type: "toolCall" as const,
        id: "terminal-tool-call",
        name: "ask_user",
        arguments: {},
      };
      const assistant = buildEmbeddedRunnerAssistant({
        provider,
        api,
        stopReason: "toolUse",
        content: [
          ...(narration === "none"
            ? []
            : [
                {
                  type: "text" as const,
                  text,
                  ...(narration === "commentary"
                    ? {
                        textSignature: JSON.stringify({
                          v: 1,
                          id: "narration",
                          phase: "commentary",
                        }),
                      }
                    : {}),
                },
              ]),
          terminalCall,
        ],
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
        assistantTexts: narration === "unphased" ? [text] : [],
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
      input.prepared = prepareEmbeddedRunTerminal({
        runParams: {
          ...input.runParams,
          admittedRunContext: createTestAdmittedRunContext("run:terminal-resolution"),
        },
        attempt,
        currentAttemptCompletedAssistant: assistant,
        provider,
        model: assistant.model,
        activeErrorContext: { provider, model: assistant.model },
        authProfileStore: input.profileFailureStore,
        sessionIdUsed: attempt.sessionIdUsed,
        outerContextTokenMeta: {},
        usageAccumulator: createUsageAccumulator(),
        contextRecoveryState: input.contextRecoveryState,
        resolvedToolResultFormat: "markdown",
        terminalState: input.terminalState,
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
          expect(resolved.result.payloads?.map((payload) => payload.text) ?? []).toEqual(
            narration === "unphased" ? [text] : [],
          );
          expect(input.sessionPromptState.activateInternalPrompt).not.toHaveBeenCalled();
          expect(attempt.messagesSnapshot.at(-1)).toBe(toolResult);
        }
      }
    },
  );

  it.each(
    (["cross-chat send", "reaction", "group", "yield"] as const).flatMap((effect) =>
      ["NO_REPLY", " \tNO_REPLY\n"].map((text) => ({
        effect,
        text,
      })),
    ),
  )(
    "honors required external silence after $effect: $text without recovery",
    async ({ effect, text }) => {
      const assistant = emptyAssistant({ content: [{ type: "text", text }] });
      const attempt = makeEmbeddedRunnerAttempt({
        assistantTexts: [text],
        toolMetas: [
          { toolName: effect === "yield" ? "sessions_yield" : "message", replaySafe: false },
        ],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        yieldDetected: effect === "yield",
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        ...(effect === "cross-chat send"
          ? { didSendViaMessagingTool: true, messagingToolSentTexts: ["Sent to another chat."] }
          : {}),
      });
      const input = makeTerminalInput({
        attempt,
        attemptAssistant: assistant,
        finalAssistantRawText: text,
        runParams: {
          terminalReplyExpectation: "required",
          sessionKey:
            effect === "group"
              ? "agent:main:telegram:group:team"
              : "agent:main:telegram:direct:user",
        },
      });

      const resolved = await resolveEmbeddedRunTerminal(input);

      expect(resolved.action).toBe("complete");
      if (resolved.action !== "complete") {
        throw new Error("expected intentional silence");
      }
      expect(resolved.result.meta.error).toBeUndefined();
      expect(resolved.result.meta.terminalReply).toEqual({ disposition: "silent" });
      expect(resolved.result.payloads).toBeUndefined();
      expect(input.sessionPromptState.activateInternalPrompt).not.toHaveBeenCalled();
    },
  );

  it.each(["subagent", undefined])(
    "requires a real private result (lane=%s) and preserves mixed-token text",
    async (lane) => {
      for (const { text, silent } of [
        { text: "NO_REPLY", silent: true },
        { text: "NO_REPLY.", silent: false },
        { text: '"NO_REPLY"', silent: false },
        { text: '{"action":"NO_REPLY"}', silent: false },
        { text: "NO_REPLY The requested result.", silent: false },
      ]) {
        const assistant = emptyAssistant({ content: [{ type: "text", text }] });
        const attempt = makeEmbeddedRunnerAttempt({
          assistantTexts: [text],
          lastAssistant: assistant,
          currentAttemptAssistant: assistant,
          currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
        });
        const input = makeTerminalInput({
          attempt,
          attemptAssistant: assistant,
          finalAssistantRawText: text,
          payloadsWithToolMedia: silent ? [] : [{ text }],
          runParams: { lane, messageChannel: undefined },
        });
        const resolved = await resolveEmbeddedRunTerminal(input);
        if (silent) {
          expect(resolved).toEqual({ action: "retry" });
          expect(input.sessionPromptState.activateInternalPrompt).toHaveBeenCalledOnce();
        } else {
          expect(resolved.action).toBe("complete");
          if (resolved.action !== "complete") {
            throw new Error("expected mixed-token answer");
          }
          expect(resolved.result.payloads).toEqual([{ text }]);
          expect(resolved.result.meta.terminalReply).toEqual({ disposition: "visible", text });
        }
      }
    },
  );

  it("completes optional empty output without recovery or a silent classification", async () => {
    const input = makeTerminalInput({ runParams: { terminalReplyExpectation: "optional" } });
    const resolved = await resolveEmbeddedRunTerminal(input);

    expect(resolved.action).toBe("complete");
    if (resolved.action !== "complete") {
      throw new Error("expected optional completion");
    }
    expect(resolved.result.meta.terminalReply).toEqual({ disposition: "empty" });
    expect(resolved.result.meta.error).toBeUndefined();
    expect(resolved.result.payloads).toBeUndefined();
    expect(input.sessionPromptState.activateInternalPrompt).not.toHaveBeenCalled();
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
          "No answer was returned. Ask again if you still need one.",
        isError: true,
        isStatusNotice: true,
      },
    ]);
    expect(exhausted.result.meta.error).toMatchObject({
      kind: "incomplete_turn",
      fallbackSafe: false,
      terminalPresentation: true,
    });
    expect(exhausted.result.meta.terminalReply).toEqual({ disposition: "empty" });
    expect(exhausted.result.meta.finalAssistantVisibleText).toBeUndefined();
    expect(exhausted.result.meta.finalAssistantRawText).toBeUndefined();
  });

  it("keeps a prepared answer when a later assistant message is reasoning-only", async () => {
    const answerText = "The operation completed successfully.";
    const answer = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: answerText }],
    });
    const reasoningOnly = buildEmbeddedRunnerAssistant({
      content: [
        {
          type: "thinking",
          thinking: "The earlier answer is complete.",
          thinkingSignature: JSON.stringify({ id: "rs_retained", type: "reasoning" }),
        },
      ],
    });
    const attempt = {
      ...makeEmbeddedRunnerAttempt({
        assistantTexts: [answerText],
        messagesSnapshot: [
          { role: "user", content: "Run the operation.", timestamp: 0 },
          answer,
          reasoningOnly,
        ],
        lastAssistant: reasoningOnly,
        currentAttemptAssistant: reasoningOnly,
        toolMetas: [
          { toolName: "write", replaySafe: false },
          { toolName: "exec", replaySafe: false },
        ],
        itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      }),
      keptAnswer: { assistant: answer, messageIndex: 1 },
    };

    const resolved = await resolveEmbeddedRunTerminal(
      makeTerminalInput({
        attempt,
        attemptAssistant: reasoningOnly,
        payloadsWithToolMedia: [{ text: answerText }],
        finalAssistantVisibleText: answerText,
        finalAssistantRawText: answerText,
      }),
    );

    expect(resolved.action).toBe("complete");
    if (resolved.action !== "complete") {
      return;
    }
    expect(resolved.result.payloads).toEqual([{ text: answerText }]);
    expect(resolved.result.meta.error).toBeUndefined();
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

  it("reports exhausted finalization as a failed required reply", async () => {
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
        settledTurnFinalizationOutcome: "failed",
      }),
    );
    expect(resolved.action).toBe("complete");
    if (resolved.action !== "complete") {
      return;
    }
    expect(resolved.result.payloads?.[0]).toMatchObject({ isError: true });
    expect(resolved.result.meta.error?.kind).toBe("incomplete_turn");
    expect(resolved.result.meta.terminalReply).toEqual({ disposition: "empty" });
    expect(resolved.result.meta.finalAssistantVisibleText).toBeUndefined();
    expect(resolved.result.meta.finalAssistantRawText).toBeUndefined();
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
