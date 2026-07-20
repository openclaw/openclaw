import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { Model } from "openclaw/plugin-sdk/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runBounded: vi.fn(),
  mirror: vi.fn(),
}));

vi.mock("./bounded-turn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bounded-turn.js")>()),
  runBoundedCodexAppServerTurn: mocks.runBounded,
}));

vi.mock("./transcript-mirror.js", () => ({
  codexTranscriptMirrorRuntime: { mirror: mocks.mirror },
}));

const { runCodexSettledTurnFinalization } = await import("./settled-turn-finalizer.js");

function createAttempt(): EmbeddedRunAttemptParams {
  return {
    prompt: "Produce the final user-visible answer now.",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    runId: "run-1",
    timeoutMs: 5_000,
    provider: "codex",
    modelId: "gpt-5.4",
    model: {
      id: "gpt-5.4",
      provider: "codex",
      api: "openai-chatgpt-responses",
    } as Model,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
    thinkLevel: "low",
  } as EmbeddedRunAttemptParams;
}

function createSettledAttempt(): EmbeddedRunAttemptResult {
  return {
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    timedOutDuringToolExecution: false,
    promptError: null,
    promptErrorSource: null,
    sessionIdUsed: "session-1",
    messagesSnapshot: [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "message", arguments: {} }],
      } as never,
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "message",
        content: [{ type: "text", text: "Message sent." }],
      } as never,
    ],
    assistantTexts: [],
    toolMetas: [{ toolName: "message", replaySafe: false }],
    lastAssistant: undefined,
    lastToolError: undefined,
    didSendViaMessagingTool: true,
    messagingToolSentTexts: ["update"],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    toolMediaUrls: ["/tmp/already-delivered.png"],
    toolAudioAsVoice: true,
    hasToolMediaBlockReply: true,
    successfulCronAdds: 1,
    cloudCodeAssistFormatError: false,
    attemptUsage: { input: 100, output: 20, total: 120 },
    replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
  };
}

describe("runCodexSettledTurnFinalization", () => {
  beforeEach(() => {
    mocks.runBounded.mockReset();
    mocks.runBounded.mockResolvedValue({
      text: "The update was sent successfully.",
      items: [],
      model: "gpt-5.4",
      usage: { input: 5, output: 4, cacheRead: 2, cacheWrite: 1, total: 12 },
    });
    mocks.mirror.mockReset();
    mocks.mirror.mockResolvedValue({
      assistantMirrorIdentitiesOwned: ["settled-finalizer:run-1"],
      userMessagesPresent: [],
    });
  });

  it("runs an isolated history-backed final turn and returns only its visible answer", async () => {
    const result = await runCodexSettledTurnFinalization(
      { attempt: createAttempt(), settledAttempt: createSettledAttempt() },
      { pluginConfig: {} },
    );

    expect(mocks.runBounded).toHaveBeenCalledWith(
      expect.objectContaining({
        isolation: "private-stdio",
        requireNoExternalCapabilities: true,
        historyItems: [
          expect.objectContaining({ type: "function_call", call_id: "call-1" }),
          expect.objectContaining({ type: "function_call_output", call_id: "call-1" }),
        ],
        input: [
          {
            type: "text",
            text: "Produce the final user-visible answer now.",
            text_elements: [],
          },
        ],
      }),
    );
    expect(mocks.mirror).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        idempotencyScope: "codex-settled-finalizer:run-1",
        messages: [expect.objectContaining({ role: "assistant" })],
      }),
    );
    expect(result).toMatchObject({
      assistantTranscriptOwned: true,
      assistantTexts: ["The update was sent successfully."],
      didSendViaMessagingTool: false,
      toolMediaUrls: undefined,
      toolAudioAsVoice: undefined,
      hasToolMediaBlockReply: false,
      successfulCronAdds: 0,
      attemptUsage: { input: 5, output: 4, cacheRead: 2, cacheWrite: 1, total: 12 },
      toolMetas: [],
      replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    });
    expect(result.messagesSnapshot).toHaveLength(3);
    expect(result.lastAssistant?.content).toEqual([
      { type: "text", text: "The update was sent successfully." },
    ]);
    expect(result.lastAssistant?.usage).toMatchObject({
      input: 5,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 12,
    });
  });

  it("rejects an empty final answer before transcript mutation", async () => {
    mocks.runBounded.mockResolvedValue({ text: " ", items: [], model: "gpt-5.4" });

    await expect(
      runCodexSettledTurnFinalization(
        { attempt: createAttempt(), settledAttempt: createSettledAttempt() },
        {},
      ),
    ).rejects.toThrow("completed without a visible answer");
    expect(mocks.mirror).not.toHaveBeenCalled();
  });
});
