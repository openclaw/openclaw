import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
} from "../../../auto-reply/reply-payload.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import {
  markCoreTtsAttemptResult,
  markCoreTtsToolResult,
  transferCoreTtsToolResultProvenance,
} from "../../tools/tts-tool-result-provenance.js";
import { createUsageAccumulator } from "../usage-accumulator.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import type { buildEmbeddedRunPayloads } from "./payloads.js";
import {
  assistantMessage,
  attemptResult,
  prepareAttempt,
} from "./terminal-preparation.test-support.js";
const payloadMocks = vi.hoisted(() => ({
  buildEmbeddedRunPayloads: vi.fn<typeof buildEmbeddedRunPayloads>(),
}));

vi.mock("./payloads.js", () => ({
  buildEmbeddedRunPayloads: payloadMocks.buildEmbeddedRunPayloads,
}));

describe("prepareEmbeddedRunTerminal", () => {
  it("retains a saved receipt without claiming terminal transcript ownership", async () => {
    const prepared = await prepareAttempt({
      attempt: attemptResult({
        assistantTranscriptOwned: false,
        assistantTranscriptIdempotencyKey: "saved-partial",
      }),
      terminalState: {
        outcome: { reason: "completed", status: "ok", stopReason: "stop" },
        signalOwnedInterruption: false,
      },
    });
    expect(prepared.agentMeta.terminalReceipt?.assistantTranscriptIdempotencyKey).toBe(
      "saved-partial",
    );
  });
  beforeEach(() => {
    payloadMocks.buildEmbeddedRunPayloads.mockReset().mockReturnValue([]);
  });

  it.each([
    {
      name: "core-attested delivered media",
      attestedMediaUrls: ["/tmp/reply.opus"],
      forgePublicField: false,
      transferToolResult: undefined,
      expectedMarkedMedia: ["/tmp/reply.opus"],
    },
    {
      name: "an external harness field",
      attestedMediaUrls: [],
      forgePublicField: true,
      transferToolResult: undefined,
      expectedMarkedMedia: [],
    },
    {
      name: "core-attested but non-delivered media",
      attestedMediaUrls: ["/tmp/other.opus"],
      forgePublicField: false,
      transferToolResult: undefined,
      expectedMarkedMedia: [],
    },
    {
      name: "a transferred core TTS result",
      attestedMediaUrls: [],
      forgePublicField: false,
      transferToolResult: "core" as const,
      expectedMarkedMedia: ["/tmp/reply.opus"],
    },
    {
      name: "a transferred plugin result",
      attestedMediaUrls: [],
      forgePublicField: false,
      transferToolResult: "plugin" as const,
      expectedMarkedMedia: [],
    },
  ])("accepts only $name for source-suppression delivery", async (testCase) => {
    payloadMocks.buildEmbeddedRunPayloads.mockReturnValueOnce([
      { text: "PRIVATE_FINAL_83636_MUST_NOT_APPEAR" },
    ]);
    const attempt = attemptResult({
      toolMediaUrls: ["/tmp/reply.opus"],
      toolAudioAsVoice: true,
      toolTrustedLocalMedia: true,
    });
    const admittedRunContext = createTestAdmittedRunContext("run-focused");
    if (testCase.attestedMediaUrls.length > 0) {
      markCoreTtsAttemptResult(
        attempt,
        testCase.attestedMediaUrls,
        admittedRunContext.operationalRunInstance,
      );
    }
    if (testCase.forgePublicField) {
      Reflect.set(attempt, "toolAutoDeliveryMediaUrls", ["/tmp/reply.opus"]);
    }
    if (testCase.transferToolResult) {
      const toolResult =
        testCase.transferToolResult === "core"
          ? markCoreTtsToolResult({}, ["/tmp/reply.opus"])
          : {};
      transferCoreTtsToolResultProvenance(
        toolResult,
        attempt,
        ["/tmp/reply.opus"],
        admittedRunContext.operationalRunInstance,
      );
    }

    const prepared = await prepareAttempt({
      attempt,
      admittedRunContext,
      sourceReplyDeliveryMode: "message_tool_only",
      terminalState: {
        outcome: { reason: "completed", status: "ok", stopReason: "stop" },
        signalOwnedInterruption: false,
      },
    });
    const markedMedia = (prepared.payloadsWithToolMedia ?? []).filter(
      (payload) => getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression === true,
    );

    expect(markedMedia.flatMap((payload) => payload.mediaUrls ?? [])).toEqual(
      testCase.expectedMarkedMedia,
    );
    expect(markedMedia.every((payload) => !payload.text)).toBe(true);
  });

  it.each([
    {
      assistantTexts: ["Earlier", "  Latest 😀  ", "\t\r\n"],
      expected: "Latest 😀",
      expectedRaw: "  Latest 😀  ",
    },
    {
      assistantTexts: ["Earlier", "\ufeff\u2003Latest\u00a0", "\u2028"],
      expected: "Latest",
      expectedRaw: "\ufeff\u2003Latest\u00a0",
    },
    { assistantTexts: ["Earlier", " \u200b "], expected: "Earlier" },
    { assistantTexts: [" \u200b\u200d\u2060 "], expected: undefined },
    {
      assistantTexts: ["  First line \n second line  "],
      expected: "First line \n second line",
      expectedRaw: "  First line \n second line  ",
    },
    {
      assistantTexts: ["Earlier", " \ud800text\udc00 "],
      expected: "\ud800text\udc00",
      expectedRaw: " \ud800text\udc00 ",
    },
    { assistantTexts: ["", " \t\r\n", "\ufeff\u2003"], expected: undefined },
    { assistantTexts: [], expected: undefined },
  ])(
    "selects final fallback text without changing its source %#",
    async ({ assistantTexts, expected, expectedRaw = expected }) => {
      const original = [...assistantTexts];
      const prepared = await prepareAttempt({
        attempt: attemptResult({
          assistantTexts,
          messagesSnapshot: [],
          lastAssistant: undefined,
          currentAttemptAssistant: undefined,
          currentAttemptCompletedAssistant: undefined,
        }),
        terminalState: {
          outcome: { reason: "completed", status: "ok", stopReason: "stop" },
          signalOwnedInterruption: false,
        },
      });

      expect(prepared.finalAssistantVisibleText).toBe(expected ?? "");
      expect(prepared.finalAssistantRawText).toBe(expectedRaw);
      expect(assistantTexts).toEqual(original);
    },
  );

  it.each([
    { stopReason: "stop", thinking: false, keepAnswer: false },
    { stopReason: "length", thinking: true, keepAnswer: false },
    { stopReason: "stop", thinking: false, keepAnswer: true },
  ] as const)(
    "keeps pre-tool text out of empty $stopReason terminal metadata (thinking=$thinking, kept=$keepAnswer)",
    async ({ stopReason, thinking, keepAnswer }) => {
      const terminal: AssistantMessage = {
        ...assistantMessage(stopReason),
        api: "ollama",
        provider: "ollama",
        content: thinking ? [{ type: "thinking", thinking: "Considering the file." }] : [],
      };
      const keptAnswer = {
        assistant: {
          ...assistantMessage(),
          content: [{ type: "text" as const, text: "Completed answer." }],
        },
        messageIndex: 1,
      };
      const prepared = await prepareAttempt({
        attempt: attemptResult({
          assistantTexts: ["I will read the file."],
          toolMetas: [{ toolName: "read" }],
          messagesSnapshot: [terminal],
          lastAssistant: terminal,
          currentAttemptAssistant: terminal,
          currentAttemptCompletedAssistant: terminal,
          keptAnswer: keepAnswer ? keptAnswer : undefined,
        }),
        currentAttemptCompletedAssistant: terminal,
        terminalState: {
          outcome: { reason: "completed", status: "ok", stopReason },
          signalOwnedInterruption: false,
        },
      });
      const expected = keepAnswer ? "Completed answer." : undefined;
      expect(prepared.finalAssistantVisibleText).toBe(expected ?? "");
      expect(prepared.finalAssistantRawText).toBe(expected);
    },
  );

  it("keeps an empty final message free of substituted text and diagnostic final text", async () => {
    const emptyFinal = { ...assistantMessage("stop"), content: [] };
    const prepared = await prepareAttempt({
      attempt: attemptResult({
        assistantTexts: ["Checking now"],
        lastAssistant: emptyFinal,
        currentAttemptAssistant: emptyFinal,
        currentAttemptCompletedAssistant: emptyFinal,
      }),
      currentAttemptCompletedAssistant: emptyFinal,
      terminalState: {
        outcome: { reason: "completed", status: "ok", stopReason: "stop" },
        signalOwnedInterruption: false,
      },
    });

    expect(prepared.finalAssistantRawText).toBeUndefined();
    expect(prepared.finalAssistantMessageRawText).toBe("");
  });

  it("marks narration from a completed tool-call message when the next message never finished", async () => {
    const toolTurn = {
      ...assistantMessage("toolUse"),
      content: [
        { type: "text" as const, text: "Checking now" },
        { type: "toolCall" as const, id: "tool_1", name: "exec", arguments: {} },
      ],
    };
    const prepared = await prepareAttempt({
      attempt: attemptResult({
        assistantTexts: ["Checking now"],
        lastAssistant: toolTurn,
        currentAttemptAssistant: toolTurn,
        currentAttemptCompletedAssistant: toolTurn,
      }),
      currentAttemptCompletedAssistant: toolTurn,
      terminalState: {
        outcome: { reason: "completed", status: "ok", stopReason: "stop" },
        signalOwnedInterruption: false,
      },
    });

    expect(prepared.finalAssistantMessageRawText).toBe("");
  });

  it("prefers a later partial message over an earlier completed tool-call message", async () => {
    const toolTurn = {
      ...assistantMessage("toolUse"),
      content: [
        { type: "text" as const, text: "Checking now" },
        { type: "toolCall" as const, id: "tool_1", name: "exec", arguments: {} },
      ],
    };
    const partial = {
      ...assistantMessage("aborted"),
      content: [{ type: "text" as const, text: "Here is the partial answer" }],
    };
    const prepared = await prepareAttempt({
      attempt: attemptResult({
        assistantTexts: ["Checking now", "Here is the partial answer"],
        lastAssistant: partial,
        currentAttemptAssistant: partial,
        currentAttemptCompletedAssistant: toolTurn,
      }),
      currentAttemptCompletedAssistant: toolTurn,
      terminalState: {
        outcome: { reason: "completed", status: "ok", stopReason: "stop" },
        signalOwnedInterruption: false,
      },
    });

    expect(prepared.finalAssistantMessageRawText).toBe("Here is the partial answer");
  });

  it("does not mark the model's own final text as a fallback", async () => {
    const final = {
      ...assistantMessage("stop"),
      content: [{ type: "text" as const, text: "Done" }],
    };
    const prepared = await prepareAttempt({
      attempt: attemptResult({
        assistantTexts: ["Checking now", "Done"],
        lastAssistant: final,
        currentAttemptAssistant: final,
        currentAttemptCompletedAssistant: final,
      }),
      currentAttemptCompletedAssistant: final,
      terminalState: {
        outcome: { reason: "completed", status: "ok", stopReason: "stop" },
        signalOwnedInterruption: false,
      },
    });

    expect(prepared.finalAssistantRawText).toBe("Done");
    expect(prepared.finalAssistantMessageRawText).toBe("Done");
  });

  it.each(["error", "aborted"] as const)(
    "does not use %s assistant text as final terminal text",
    async (stopReason) => {
      const { prepareEmbeddedRunTerminal } = await import("./terminal-preparation.js");
      const assistant = assistantMessage(stopReason);
      const prepared = prepareEmbeddedRunTerminal({
        runParams: {
          admittedRunContext: createTestAdmittedRunContext("run-1"),
          sessionId: "session-1",
          runId: "run-1",
          workspaceDir: "/tmp/openclaw-test",
          prompt: "hi",
          trigger: "user",
          timeoutMs: 60_000,
        },
        attempt: attemptResult({
          lastAssistant: assistant,
          currentAttemptAssistant: assistant,
          currentAttemptCompletedAssistant: assistant,
        }),
        currentAttemptCompletedAssistant: assistant,
        provider: "openai",
        model: "gpt-5.4",
        activeErrorContext: { provider: "openai", model: "gpt-5.4" },
        authProfileStore: { version: 1, profiles: {} },
        sessionIdUsed: "session-1",
        outerContextTokenMeta: {},
        usageAccumulator: createUsageAccumulator(),
        contextRecoveryState: createEmbeddedRunContextRecoveryState(),
        resolvedToolResultFormat: "markdown",
        terminalState: {
          outcome:
            stopReason === "aborted"
              ? { reason: "aborted", status: "error", stopReason }
              : { reason: "failed", status: "error", stopReason, error: "provider failed" },
          signalOwnedInterruption: false,
        },
      });

      expect(prepared.finalAssistantVisibleText).toBe("");
      expect(prepared.finalAssistantRawText).toBeUndefined();
    },
  );

  it.each([true, false])(
    "uses current-attempt attribution instead of stale session evidence (completed: %s)",
    async (completed) => {
      const { prepareEmbeddedRunTerminal } = await import("./terminal-preparation.js");
      const finalText = "The requested update is complete.";
      const nativeSelection = { provider: "native-provider", model: "native-model" };
      const staleAssistant = {
        ...assistantMessage("toolUse"),
        content: [{ type: "toolCall" as const, id: "tool_1", name: "update_plan", arguments: {} }],
      };
      const currentAssistant = {
        ...assistantMessage("stop"),
        ...nativeSelection,
        content: [{ type: "text" as const, text: finalText }],
        usage: {
          ...assistantMessage("stop").usage,
          input: 200,
          output: 20,
          totalTokens: 220,
        },
      };
      const completedAssistant = completed ? currentAssistant : undefined;
      const prepared = prepareEmbeddedRunTerminal({
        runParams: {
          admittedRunContext: createTestAdmittedRunContext("run-current"),
          sessionId: "session-current",
          runId: "run-current",
          workspaceDir: "/tmp/openclaw-test",
          prompt: "hi",
          trigger: "user",
          timeoutMs: 60_000,
        },
        attempt: attemptResult({
          assistantTexts: ["Analysis...", finalText],
          toolMetas: [{ toolName: "update_plan" }],
          lastAssistant: staleAssistant,
          currentAttemptAssistant: currentAssistant,
          currentAttemptCompletedAssistant: completedAssistant,
          runtimeModelSelection: nativeSelection,
        }),
        currentAttemptCompletedAssistant: completedAssistant,
        provider: "openai",
        model: "gpt-5.4",
        activeErrorContext: { provider: "openai", model: "gpt-5.4" },
        authProfileStore: { version: 1, profiles: {} },
        sessionIdUsed: "session-current",
        outerContextTokenMeta: {},
        usageAccumulator: createUsageAccumulator(),
        contextRecoveryState: createEmbeddedRunContextRecoveryState(),
        resolvedToolResultFormat: "markdown",
        terminalState: {
          outcome: { reason: "completed", status: "ok", stopReason: "stop" },
          signalOwnedInterruption: false,
        },
      });

      expect(prepared.finalAssistantVisibleText).toBe(finalText);
      expect(prepared.finalAssistantRawText).toBe(finalText);
      expect(prepared.agentMeta).toMatchObject({
        ...nativeSelection,
        runtimeModelSelection: nativeSelection,
      });
      expect(payloadMocks.buildEmbeddedRunPayloads).toHaveBeenCalledWith(
        expect.objectContaining({
          lastAssistant: completedAssistant,
          currentAssistant: completedAssistant ?? null,
        }),
      );
      if (completed) {
        expect(prepared.agentMeta.lastCallUsage).toMatchObject({
          input: 200,
          output: 20,
          total: 220,
        });
      } else {
        expect(prepared.agentMeta.lastCallUsage).toBeUndefined();
      }
    },
  );

  it("keeps legacy CLI aggregates while marking latest context usage unavailable", async () => {
    const { prepareEmbeddedRunTerminal } = await import("./terminal-preparation.js");
    const assistant = {
      ...assistantMessage("stop"),
      api: "cli",
      usage: {
        input: 128_814,
        output: 3_000,
        cacheRead: 992_953,
        cacheWrite: 0,
        totalTokens: 1_124_767,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    } satisfies AssistantMessage;
    const aggregate = {
      input: 128_814,
      output: 3_000,
      cacheRead: 992_953,
      total: 1_124_767,
    };
    const usageAccumulator = Object.assign(createUsageAccumulator(), aggregate);
    const prepared = prepareEmbeddedRunTerminal({
      runParams: {
        admittedRunContext: createTestAdmittedRunContext("run-cli-usage"),
        sessionId: "session-cli-usage",
        runId: "run-cli-usage",
        workspaceDir: "/tmp/openclaw-test",
        prompt: "hi",
        trigger: "user",
        timeoutMs: 60_000,
      },
      attempt: attemptResult({
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        currentAttemptCompletedAssistant: assistant,
      }),
      currentAttemptCompletedAssistant: assistant,
      provider: "openai",
      model: "gpt-5.4",
      activeErrorContext: { provider: "openai", model: "gpt-5.4" },
      authProfileStore: { version: 1, profiles: {} },
      sessionIdUsed: "session-cli-usage",
      outerContextTokenMeta: {},
      usageAccumulator,
      lastRunPromptUsage: { input: 42_000, output: 1_000, total: 43_000 },
      contextRecoveryState: createEmbeddedRunContextRecoveryState(),
      resolvedToolResultFormat: "markdown",
      terminalState: {
        outcome: { reason: "completed", status: "ok", stopReason: "stop" },
        signalOwnedInterruption: false,
      },
    });

    expect(prepared.agentMeta.usage).toEqual(aggregate);
    expect(prepared.agentMeta.lastCallUsage).toEqual({
      contextUsage: { state: "unavailable" },
    });
    expect(prepared.agentMeta.promptTokens).toBeUndefined();
  });

  it("projects a Code Mode cron tool failure into terminal metadata", async () => {
    const { prepareEmbeddedRunTerminal } = await import("./terminal-preparation.js");
    const assistant = assistantMessage("stop");
    const prepared = prepareEmbeddedRunTerminal({
      runParams: {
        admittedRunContext: createTestAdmittedRunContext("run-1"),
        sessionId: "session-1",
        runId: "run-1",
        workspaceDir: "/tmp/openclaw-test",
        prompt: "hi",
        trigger: "cron",
        timeoutMs: 60_000,
      },
      attempt: attemptResult({
        codeModeEngaged: true,
        lastToolError: {
          toolName: "exec",
          errorCode: "invalid_input",
          error:
            "Unknown tool id: MCP.notes.read. Use openclaw.tools.search to find a tool, openclaw.tools.describe to inspect it, then openclaw.tools.call with the exact id or name.",
        },
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        currentAttemptCompletedAssistant: assistant,
      }),
      currentAttemptCompletedAssistant: assistant,
      provider: "openai",
      model: "gpt-5.4",
      activeErrorContext: { provider: "openai", model: "gpt-5.4" },
      authProfileStore: { version: 1, profiles: {} },
      sessionIdUsed: "session-1",
      outerContextTokenMeta: {},
      usageAccumulator: createUsageAccumulator(),
      contextRecoveryState: createEmbeddedRunContextRecoveryState(),
      resolvedToolResultFormat: "markdown",
      terminalState: {
        outcome: { reason: "completed", status: "ok", stopReason: "stop" },
        signalOwnedInterruption: false,
      },
    });

    expect(prepared.failureSignal).toBeUndefined();
    expect(prepared.terminalToolFailure).toEqual({
      source: "tool",
      toolName: "exec",
      code: "UNKNOWN_TOOL_ID",
    });
  });

  it("recovers current final text and tool media after a prompt-timeout race", async () => {
    const completedText = "Completed answer block before the timeout.";
    const partialText = "Partial final response before the timeout.";
    const finalText = "Complete final response after the timeout.";
    const finalAssistant = {
      ...assistantMessage("stop"),
      content: [{ type: "text" as const, text: finalText }],
    };
    const completedPayload = setReplyPayloadMetadata(
      { text: completedText },
      { assistantMessageIndex: 0 },
    );
    const partialPayload = setReplyPayloadMetadata(
      { text: partialText },
      { assistantMessageIndex: 1 },
    );
    payloadMocks.buildEmbeddedRunPayloads.mockReturnValueOnce([completedPayload, partialPayload]);

    const prepared = await prepareAttempt({
      replyDeliveryState: "delivered",
      sourceReplyDeliveryState: "missing",
      attempt: attemptResult({
        terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
        assistantTexts: [completedText, partialText],
        toolMediaUrls: ["https://example.test/recovered-output.png"],
        lastAssistant: finalAssistant,
        currentAttemptAssistant: finalAssistant,
        currentAttemptCompletedAssistant: finalAssistant,
      }),
      currentAttemptCompletedAssistant: finalAssistant,
      terminalState: {
        outcome: {
          reason: "hard_timeout",
          status: "timeout",
          timeoutPhase: "provider",
          providerStarted: true,
        },
        signalOwnedInterruption: false,
      },
    });

    expect(prepared.hasSuccessfulFinalAssistantAfterPromptTimeout).toBe(true);
    expect(prepared.recoveredFinalAssistantPayloadsAfterPromptTimeout).toEqual([
      expect.objectContaining({
        mediaUrl: "https://example.test/recovered-output.png",
        text: completedText,
      }),
      { text: finalText },
    ]);
    expect(getReplyPayloadMetadata(partialPayload)?.localTranscriptDeliveryConfirmed).toBe(true);
    const [kept, text] = prepared.recoveredFinalAssistantPayloadsAfterPromptTimeout!;
    expect(getReplyPayloadMetadata(kept!)?.localTranscriptDeliveryConfirmed).toBe(true);
    expect(getReplyPayloadMetadata(text!)?.localTranscriptDeliveryConfirmed).toBeUndefined();
  });

  it("does not recover stale session text after the current prompt times out", async () => {
    const staleAssistant = {
      ...assistantMessage("stop"),
      content: [{ type: "text" as const, text: "Stale answer from the prior attempt." }],
    };

    const prepared = await prepareAttempt({
      attempt: attemptResult({
        terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
        assistantTexts: [],
        lastAssistant: staleAssistant,
        currentAttemptAssistant: undefined,
        currentAttemptCompletedAssistant: undefined,
      }),
      currentAttemptCompletedAssistant: undefined,
      terminalState: {
        outcome: {
          reason: "hard_timeout",
          status: "timeout",
          timeoutPhase: "provider",
          providerStarted: true,
        },
        signalOwnedInterruption: false,
      },
    });

    expect(prepared.finalAssistantVisibleText).toBe("");
    expect(prepared.recoveredFinalAssistantPayloadsAfterPromptTimeout).toBeUndefined();
    expect(prepared.hasSuccessfulFinalAssistantAfterPromptTimeout).toBe(false);
  });

  it("excludes cleanup and earlier completed assistants from clean-yield payloads", async () => {
    const completedAssistant = assistantMessage("stop");
    const yieldedAssistant = {
      ...assistantMessage("aborted"),
      content: [
        { type: "toolCall" as const, id: "yield-1", name: "sessions_yield", arguments: {} },
      ],
    };
    const attempt = attemptResult({
      assistantTexts: [],
      lastAssistant: yieldedAssistant,
      currentAttemptAssistant: undefined,
      currentAttemptCompletedAssistant: completedAssistant,
      yieldDetected: true,
    });

    await prepareAttempt({
      attempt,
      currentAttemptCompletedAssistant: completedAssistant,
      terminalState: {
        outcome: { reason: "completed", status: "ok", stopReason: "stop" },
        signalOwnedInterruption: false,
      },
    });

    expect(payloadMocks.buildEmbeddedRunPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ lastAssistant: undefined, currentAssistant: null }),
    );
  });

  it("carries the canonical restart reason into terminal payload rendering", async () => {
    await prepareAttempt({
      attempt: attemptResult({
        lastToolError: {
          toolName: "gateway_exec",
          error: "OpenClaw dynamic tool call aborted.",
        },
      }),
      terminalState: {
        outcome: { reason: "cancelled", status: "error", stopReason: "restart" },
        signalOwnedInterruption: true,
      },
    });

    expect(payloadMocks.buildEmbeddedRunPayloads).toHaveBeenCalledWith(
      expect.objectContaining({ runAborted: true, runStopReason: "restart" }),
    );
  });

  it.each([
    { continuesConversation: false, warns: true },
    { continuesConversation: true, warns: false },
  ])(
    "keeps a failed command's NO_REPLY silent only when the heartbeat continues a conversation ($continuesConversation)",
    async ({ continuesConversation, warns }) => {
      const actual = await vi.importActual<{
        buildEmbeddedRunPayloads: typeof buildEmbeddedRunPayloads;
      }>("./payloads.js");
      payloadMocks.buildEmbeddedRunPayloads.mockImplementation(actual.buildEmbeddedRunPayloads);
      const silent: AssistantMessage = {
        ...assistantMessage("stop"),
        content: [{ type: "text", text: "NO_REPLY" }],
      };
      const prepared = await prepareAttempt({
        attempt: attemptResult({
          assistantTexts: ["NO_REPLY"],
          messagesSnapshot: [silent],
          lastAssistant: silent,
          currentAttemptAssistant: silent,
          currentAttemptCompletedAssistant: silent,
          lastToolError: { toolName: "exec", error: "Command exited with code 1" },
        }),
        heartbeat: { continuesConversation },
        terminalState: {
          outcome: { reason: "completed", status: "ok", stopReason: "stop" },
          signalOwnedInterruption: false,
        },
      });

      expect(prepared.payloads.some((payload) => payload.isError === true)).toBe(warns);
    },
  );
});
