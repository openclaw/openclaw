import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { classifyAgentExecResult } from "../../../commands/agent-exec-result.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
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
import { prepareAttempt } from "./terminal-preparation.test-support.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import {
  textAssistant,
  assistantAttempt,
  expectComplete,
  emptyAssistant,
  makeTerminalInput,
  resolveTerminal,
} from "./terminal-resolution.test-support.js";

vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

const REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";

function reasoningAssistant(id: string, thinking: string) {
  const thinkingSignature = JSON.stringify({ id, type: "reasoning" });
  return buildEmbeddedRunnerAssistant({
    content: [{ type: "thinking", thinking, thinkingSignature }],
  });
}

describe("terminal resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGeneratedMediaTaskActivityForTests();
  });

  it("completes an empty post-tool turn after committed media delivery", async () => {
    const input = makeTerminalInput({
      assistant: emptyAssistant(),
      attemptOverrides: {
        toolMetas: [{ toolName: "tts", isError: false, replaySafe: false }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        hasToolMediaBlockReply: true,
      },
    });

    const resolved = await resolveEmbeddedRunTerminal(input);

    expectComplete(resolved);
    expect(input.sessionPromptState.activateInternalPrompt).not.toHaveBeenCalled();
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
            ? textAssistant(partialText, { stopReason: "toolUse" })
            : undefined;
      const payloads = cleanupFailed ? undefined : [];
      const attempt = assistantAttempt(assistant, {
        terminal: { kind: "failed", source: "prompt", error },
        lastToolError: cleanupFailed
          ? { toolName: "exec", error: "Tool execution aborted" }
          : undefined,
        toolMetas: cleanupFailed ? [{ toolName: "exec", isError: true, replaySafe: false }] : [],
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

  it("keeps real internal provider failures visible", async () => {
    const resolved = await resolveTerminal({
      assistant: emptyAssistant({ stopReason: "error", errorMessage: "Authentication failed" }),
      attemptOverrides: {
        terminal: { kind: "failed", source: "prompt", error: new Error("Authentication failed") },
      },
      runParams: {
        messageChannel: "internal",
        inputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
      },
    });
    expectComplete(resolved);
    expect(resolved.result.meta.error).toMatchObject({ message: "Authentication failed" });
    expect(resolved.result.meta.suppressErrorNotice).not.toBe(true);
  });

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
    expectComplete(resolved);
    expect(resolved.result.meta).toMatchObject({ aborted: true, livenessState: "blocked" });
    expect(resolved.result.meta.error).toBeUndefined();
    expect(input.sessionPromptState.activateInternalPrompt).not.toHaveBeenCalled();
  });

  it("completes NO_REPLY from an internal notification without retrying", async () => {
    const assistant = textAssistant(SILENT_REPLY_TOKEN);
    const input = makeTerminalInput({
      assistant,
      attemptOverrides: {
        assistantTexts: [SILENT_REPLY_TOKEN],
        currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      },
      runParams: {
        allowEmptyAssistantReplyAsSilent: false,
        trigger: "user",
        inputProvenance: { kind: "inter_session", sourceTool: "subagent_announce" },
      },
    });

    const resolved = await resolveEmbeddedRunTerminal(input);

    expectComplete(resolved);
    expect(resolved.result.payloads).toBeUndefined();
    expect(resolved.result.meta.terminalReply).toEqual({ disposition: "silent" });
    expect(resolved.result.meta.livenessState).toBe("working");
    expect(input.sessionPromptState.activateInternalPrompt).not.toHaveBeenCalled();
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

    const resolved = await resolveTerminal({
      attempt,
      runParams: { replyOperation: { turnKind: "visible" } as never },
    });

    expect(resolved).toMatchObject({
      result: {
        payloads: undefined,
        meta: { continuationPending: true },
        acceptedSessionSpawns: attempt.acceptedSessionSpawns,
      },
    });
  });

  const detachedImageAttempt = (
    overrides: Parameters<typeof makeEmbeddedRunnerAttempt>[0] = {},
  ) => {
    createMediaGenerationOperation({
      taskId: "task-image",
      runId: "tool:image_generate:run-image",
      taskKind: "image_generation",
      requesterSessionKey: "agent:main:telegram:group:-100",
      requesterAgentId: "main",
      status: "running",
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
    messagingToolSentTexts: [progressTarget.text],
    messagingToolSentTargets: [progressTarget],
  };

  it.each([false, true])(
    "settles a media turn only after its final source reply (%s)",
    async (sourceReplyFinal) => {
      const resolved = await resolveTerminal({
        attempt: detachedImageAttempt({
          ...progressAck,
          didDeliverSourceReplyViaMessageTool: true,
          ...(sourceReplyFinal
            ? {}
            : { messagingToolSentTargets: [{ ...progressTarget, sourceReplyFinal }] }),
          messagingToolSourceReplyPayloads: [{ text: progressTarget.text, sourceReplyFinal }],
        }),
        runParams: { replyOperation: { turnKind: "visible" } as never },
      });
      expectComplete(resolved);
      expect(resolved.result.meta.continuationPending).toBe(sourceReplyFinal ? undefined : true);
      if (!sourceReplyFinal) {
        expect(resolved.result.payloads).toBeUndefined();
      }
    },
  );

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
      const narrationBlock = {
        type: "text" as const,
        text,
        ...(narration === "commentary"
          ? { textSignature: JSON.stringify({ v: 1, id: "narration", phase: "commentary" }) }
          : {}),
      };
      const assistant = buildEmbeddedRunnerAssistant({
        provider,
        api,
        stopReason: "toolUse",
        content: narration === "none" ? [terminalCall] : [narrationBlock, terminalCall],
      });
      const toolResult = makeTextToolResult(
        terminalCall.id,
        terminalCall.name,
        "Cancelled.",
        isError,
        0,
      );
      const attempt = assistantAttempt(assistant, {
        assistantTexts: narration === "unphased" ? [text] : [],
        toolMetas: [{ toolName: terminalCall.name, toolCallId: terminalCall.id, terminate: true }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        messagesSnapshot: [
          { role: "user", content: [{ type: "text", text: "Ask." }], timestamp: 0 },
          assistant,
          ...(!isError ? [textAssistant("The question was already shown.")] : []),
          toolResult,
        ],
      });
      const input = makeTerminalInput({
        attempt,
        replayState: { hadPotentialSideEffects: true, replayInvalid: true },
      });
      input.prepared = await prepareAttempt({
        runParams: input.runParams,
        admittedRunContext: createTestAdmittedRunContext("run:terminal-resolution"),
        attempt,
        currentAttemptCompletedAssistant: assistant,
        provider,
        model: assistant.model,
        activeErrorContext: { provider, model: assistant.model },
        authProfileStore: input.profileFailureStore,
        contextRecoveryState: input.contextRecoveryState,
        terminalState: input.terminalState,
      });
      const resolved = await resolveEmbeddedRunTerminal(input);
      expectComplete(resolved);
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
    },
  );

  it.each(
    (["cross-chat send", "reaction", "group", "yield"] as const).flatMap((effect) =>
      ["NO_REPLY", " \tNO_REPLY\n"].map((text) => ({ effect, text })),
    ),
  )(
    "honors required external silence after $effect: $text without recovery",
    async ({ effect, text }) => {
      const assistant = textAssistant(text);
      const input = makeTerminalInput({
        assistant,
        attemptOverrides: {
          assistantTexts: [text],
          toolMetas: [
            { toolName: effect === "yield" ? "sessions_yield" : "message", replaySafe: false },
          ],
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
          yieldDetected: effect === "yield",
          replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
          ...(effect === "cross-chat send"
            ? { didSendViaMessagingTool: true, messagingToolSentTexts: ["Sent to another chat."] }
            : {}),
        },
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

      expectComplete(resolved);
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
        const assistant = textAssistant(text);
        const input = makeTerminalInput({
          assistant,
          attemptOverrides: {
            assistantTexts: [text],
            currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
          },
          finalAssistantRawText: text,
          payloadsWithToolMedia: silent ? [] : [{ text }],
          runParams: { lane, messageChannel: undefined },
        });
        const resolved = await resolveEmbeddedRunTerminal(input);
        if (silent) {
          expect(resolved).toEqual({ action: "retry" });
          expect(input.sessionPromptState.activateInternalPrompt).toHaveBeenCalledOnce();
        } else {
          expectComplete(resolved);
          expect(resolved.result.payloads).toEqual([{ text }]);
          expect(resolved.result.meta.terminalReply).toEqual({ disposition: "visible", text });
        }
      }
    },
  );

  it("completes optional empty output without recovery or a silent classification", async () => {
    const input = makeTerminalInput({ runParams: { terminalReplyExpectation: "optional" } });
    const resolved = await resolveEmbeddedRunTerminal(input);

    expectComplete(resolved);
    expect(resolved.result.meta.terminalReply).toEqual({ disposition: "empty" });
    expect(resolved.result.meta.error).toBeUndefined();
    expect(resolved.result.payloads).toBeUndefined();
    expect(input.sessionPromptState.activateInternalPrompt).not.toHaveBeenCalled();
  });

  it("retries reasoning-only output and surfaces a retained presentation after exhaustion", async () => {
    const assistant = reasoningAssistant("rs_terminal", "internal reasoning");
    const attempt = assistantAttempt(assistant, {
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    const retryInput = makeTerminalInput({
      attempt,
      runParams: { allowEmptyAssistantReplyAsSilent: true, terminalReplyExpectation: "required" },
    });

    await expect(resolveEmbeddedRunTerminal(retryInput)).resolves.toEqual({ action: "retry" });
    expect(retryInput.sessionPromptState.activateInternalPrompt).toHaveBeenCalledWith(
      REASONING_ONLY_RETRY_INSTRUCTION,
    );

    const exhaustedInput = makeTerminalInput({
      attempt,
      retryState: { reasoningOnlyAttempts: 2 },
      readTerminalToolPresentation: () =>
        "Web fetch completed.\nOrigin: https://example.com\nStatus: 200",
    });
    const exhausted = await resolveEmbeddedRunTerminal(exhaustedInput);

    expectComplete(exhausted);
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
    const answer = textAssistant(answerText);
    const reasoningOnly = reasoningAssistant("rs_retained", "The earlier answer is complete.");
    const attempt = {
      ...assistantAttempt(reasoningOnly, {
        assistantTexts: [answerText],
        messagesSnapshot: [
          { role: "user", content: "Run the operation.", timestamp: 0 },
          answer,
          reasoningOnly,
        ],
        toolMetas: [
          { toolName: "write", replaySafe: false },
          { toolName: "exec", replaySafe: false },
        ],
        itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      }),
      keptAnswer: { assistant: answer, messageIndex: 1 },
    };

    const resolved = await resolveTerminal({
      attempt,
      payloadsWithToolMedia: [{ text: answerText }],
      finalAssistantVisibleText: answerText,
      finalAssistantRawText: answerText,
    });

    expectComplete(resolved);
    expect(resolved.result.payloads).toEqual([{ text: answerText }]);
    expect(resolved.result.meta.error).toBeUndefined();
  });

  it("suppresses duplicate user persistence when retrying a missing assistant", async () => {
    const attempt = makeEmbeddedRunnerAttempt({
      lastAssistant: undefined,
      currentAttemptAssistant: undefined,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    const input = makeTerminalInput({ attempt });

    await expect(resolveEmbeddedRunTerminal(input)).resolves.toEqual({ action: "retry" });
    expect(input.sessionPromptState.suppressNextUserMessagePersistence).toBe(true);
    expect(input.sessionPromptState.activateInternalPrompt).not.toHaveBeenCalled();
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
    const input = makeTerminalInput({
      assistant,
      attemptOverrides: {
        currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      },
    });

    await expect(resolveEmbeddedRunTerminal(input)).resolves.toEqual({ action: "retry" });
    expect(input.sessionPromptState.activateCompactionContinuation).toHaveBeenCalledWith(
      expect.stringContaining("Continue from the compacted transcript"),
    );
    expect(input.armPostCompactionGuard).toHaveBeenCalledOnce();
  });

  it("reports exhausted finalization as a failed required reply", async () => {
    const resolved = await resolveTerminal({
      assistant: emptyAssistant(),
      attemptOverrides: {
        toolMetas: [{ toolName: "write", replaySafe: false }],
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      },
      runParams: { allowEmptyAssistantReplyAsSilent: true, terminalReplyExpectation: "required" },
      replayState: { hadPotentialSideEffects: true, replayInvalid: true },
      settledTurnFinalizationOutcome: "failed",
    });
    expectComplete(resolved);
    expect(resolved.result.payloads?.[0]).toMatchObject({ isError: true });
    expect(resolved.result.meta.error?.kind).toBe("incomplete_turn");
    expect(resolved.result.meta.terminalReply).toEqual({ disposition: "empty" });
    expect(resolved.result.meta.finalAssistantVisibleText).toBeUndefined();
    expect(resolved.result.meta.finalAssistantRawText).toBeUndefined();
  });

  it.each([
    ["partial text", "Here is the first half of the answer", undefined, true],
    ["terminal media", "Chart attached", ["https://example.invalid/chart.png"], false],
  ] satisfies [string, string, string[] | undefined, boolean][])(
    "adds a length-stop notice only for %s",
    async (_kind, text, toolMediaUrls, truncated) => {
      const resolved = await resolveTerminal({
        assistant: textAssistant(text, { stopReason: "length" }),
        attemptOverrides: {
          assistantTexts: [text],
          toolMediaUrls,
          currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
        },
        payloadsWithToolMedia: [{ text }],
      });
      expectComplete(resolved);
      expect(resolved.result.payloads).toEqual(
        truncated ? [{ text }, { text: TRUNCATED_REPLY_NOTICE_TEXT }] : [{ text }],
      );
      if (truncated) {
        expect(resolved.result.meta.error).toBeUndefined();
        expect(resolved.result.meta.livenessState).toBe("working");
      }
    },
  );
});
