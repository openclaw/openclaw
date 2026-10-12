import { describe, expect, it } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { setReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { buildEmbeddedRunPayloads } from "./payloads.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";
import {
  createTerminalToolPresentationTracker,
  resolveSettledTurnFinalizationRequest,
} from "./terminal-resolution.js";
import { mergeAttemptToolMediaPayloads } from "./tool-media-payloads.js";

type SettledTurnRequestParams = Parameters<typeof resolveSettledTurnFinalizationRequest>[0];
type SettledTurnPayloads = NonNullable<SettledTurnRequestParams["payloadsWithToolMedia"]>;

const SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION =
  "The previous assistant turn completed its tool calls but did not produce a user-visible answer. Continue from the current transcript and produce the final user-visible answer now. Do not repeat completed tool calls or restart from scratch. Tools are unavailable in this step: it is a text-only pass, so reply with plain text and do not attempt any tool call.";

describe("resolveSettledTurnFinalizationRequest", () => {
  it("requests isolated finalization only for a required settled-tool turn", () => {
    const assistant = buildEmbeddedRunnerAssistant({ content: [{ type: "text", text: "" }] });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      toolMetas: [{ toolName: "write", meta: "path=note.txt", replaySafe: false }],
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    const terminalState = resolveEmbeddedRunAttemptTerminalState({ attempt, assistant });
    const request = (terminalReplyExpectation: "required" | "optional") =>
      resolveSettledTurnFinalizationRequest({
        runParams: {
          sessionId: "session:settled",
          runId: "run:settled",
          terminalReplyExpectation,
        } as never,
        attempt,
        activeErrorContext: { provider: "openai", model: "gpt-5.6-luna" },
        modelApi: "openai-responses",
        executionContract: undefined,
        payloadsWithToolMedia: [],
        hasTerminalToolPresentation: false,
        terminalState,
        settledTurnFinalizationAvailable: true,
      });

    expect(request("required")).toBe(SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION);
    expect(request("optional")).toBeNull();
    expect(
      resolveSettledTurnFinalizationRequest({
        runParams: {
          sessionId: "session:settled-heartbeat",
          runId: "run:settled-heartbeat",
          trigger: "heartbeat",
        } as never,
        attempt,
        activeErrorContext: { provider: "openai", model: "gpt-5.6-luna" },
        modelApi: "openai-responses",
        executionContract: undefined,
        payloadsWithToolMedia: [],
        hasTerminalToolPresentation: false,
        terminalState,
        settledTurnFinalizationAvailable: true,
      }),
    ).toBeNull();
  });

  it("requires an available finalizer and no visible structured error", () => {
    const assistant = buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool-1", name: "exec", arguments: {} }],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      toolMetas: [{ toolName: "exec", isError: true, replaySafe: false }],
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      messagesSnapshot: [
        assistant,
        { role: "toolResult", toolCallId: "tool-1", toolName: "exec", isError: true } as never,
      ],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      lastToolError: { toolName: "exec", error: "post-processing error" },
    });
    const terminalState = resolveEmbeddedRunAttemptTerminalState({ attempt, assistant });
    const request = (overrides: {
      payloadsWithToolMedia?: Parameters<
        typeof resolveSettledTurnFinalizationRequest
      >[0]["payloadsWithToolMedia"];
      settledTurnFinalizationAvailable?: boolean;
    }) =>
      resolveSettledTurnFinalizationRequest({
        runParams: {
          sessionId: "session:settled-policy",
          runId: "run:settled-policy",
          trigger: "user",
          terminalReplyExpectation: "required",
        } as never,
        attempt,
        activeErrorContext: { provider: "openai", model: "gpt-5.6-luna" },
        modelApi: "openai-responses",
        executionContract: undefined,
        payloadsWithToolMedia: overrides.payloadsWithToolMedia ?? [],
        hasTerminalToolPresentation: false,
        terminalState,
        settledTurnFinalizationAvailable: overrides.settledTurnFinalizationAvailable ?? true,
      });

    expect(
      request({
        payloadsWithToolMedia: [
          {
            text: "Review the failed operation.",
            isError: true,
            channelData: { structuredError: true },
          },
        ],
      }),
    ).toBeNull();
    expect(request({ settledTurnFinalizationAvailable: false })).toBeNull();
    expect(
      request({ payloadsWithToolMedia: [{ text: "⚠️ 🛠️ Exec failed", isError: true }] }),
    ).toBeNull();
    expect(
      request({
        payloadsWithToolMedia: buildEmbeddedRunPayloads({
          assistantTexts: [],
          lastAssistant: assistant,
          lastToolError: attempt.lastToolError,
          sessionKey: "session:settled-policy",
        }),
      }),
    ).toContain(SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION);
  });

  it("preserves optional authored silence after a settled tool failure", () => {
    const toolAssistant = buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool-rejected", name: "tool_call", arguments: {} }],
    });
    const silentAssistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: "NO_REPLY" }],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: ["NO_REPLY"],
      lastAssistant: silentAssistant,
      currentAttemptAssistant: silentAssistant,
      messagesSnapshot: [
        toolAssistant,
        makeTextToolResult("tool-rejected", "tool_call", "Required argument missing", true, 0),
        silentAssistant,
      ],
      toolMetas: [
        { toolName: "tool_call", toolCallId: "tool-rejected", isError: true, replaySafe: true },
      ],
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      lastToolError: { toolName: "tool_call", error: "Required argument missing" },
    });
    const request = (terminalReplyExpectation: "required" | "optional") =>
      resolveSettledTurnFinalizationRequest({
        runParams: {
          sessionId: "session:rejected-silent",
          runId: "run:rejected-silent",
          workspaceDir: "/tmp/openclaw-test",
          prompt: "Review the completed work.",
          timeoutMs: 60_000,
          terminalReplyExpectation,
        },
        attempt,
        activeErrorContext: { provider: "openai", model: "gpt-5.6-luna" },
        modelApi: "openai-responses",
        executionContract: undefined,
        payloadsWithToolMedia: buildEmbeddedRunPayloads({
          assistantTexts: attempt.assistantTexts,
          lastAssistant: silentAssistant,
          lastToolError: attempt.lastToolError,
          sessionKey: "session:rejected-silent",
        }),
        hasTerminalToolPresentation: false,
        terminalState: resolveEmbeddedRunAttemptTerminalState({
          attempt,
          assistant: silentAssistant,
        }),
        settledTurnFinalizationAvailable: true,
      });

    expect(request("required")).toContain(SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION);
    expect(request("optional")).toBeNull();
  });

  it("finalizes after successful tools despite pre-tool progress and a stale error (#132762)", () => {
    const failedAssistant = buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool-failed", name: "exec", arguments: {} }],
    });
    const progress = "I’ll inspect the file before answering.";
    const terminalAssistant = buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [
        { type: "text", text: progress },
        { type: "toolCall", id: "tool-succeeded", name: "read", arguments: {} },
      ],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [progress],
      lastAssistantTextMessageIndex: 3,
      messagesSnapshot: [
        { role: "user", content: "Inspect the file.", timestamp: 0 },
        failedAssistant,
        makeTextToolResult("tool-failed", "exec", "Command exited with code 1", true, 1),
        terminalAssistant,
        makeTextToolResult("tool-succeeded", "read", "The requested value", false, 2),
      ],
      toolMetas: [
        { toolName: "exec", toolCallId: "tool-failed", isError: true, replaySafe: false },
        { toolName: "read", toolCallId: "tool-succeeded", isError: false, replaySafe: true },
      ],
      itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
      lastAssistant: terminalAssistant,
      currentAttemptAssistant: terminalAssistant,
      lastToolError: { toolName: "exec", error: "Command exited with code 1" },
      replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    });

    const request = (
      payloadsWithToolMedia = buildEmbeddedRunPayloads({
        assistantTexts: attempt.assistantTexts,
        assistantMessageIndex: attempt.lastAssistantTextMessageIndex,
        lastAssistant: terminalAssistant,
        currentAssistant: terminalAssistant,
        lastToolError: attempt.lastToolError,
        sessionKey: "session:stale-error",
      }),
    ) =>
      resolveSettledTurnFinalizationRequest({
        runParams: {
          sessionId: "session:stale-error",
          runId: "run:stale-error",
          workspaceDir: "/tmp/openclaw-test",
          prompt: "Inspect the file.",
          timeoutMs: 60_000,
          trigger: "user",
          terminalReplyExpectation: "required",
        },
        attempt,
        activeErrorContext: { provider: "openai", model: "gpt-4.1-mini" },
        modelApi: "openai-responses",
        executionContract: undefined,
        payloadsWithToolMedia,
        hasTerminalToolPresentation: false,
        terminalState: resolveEmbeddedRunAttemptTerminalState({
          attempt,
          assistant: terminalAssistant,
        }),
        settledTurnFinalizationAvailable: true,
      });

    expect(request()).toBe(SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION);
    expect(
      request([
        setReplyPayloadMetadata(
          { text: progress },
          {
            assistantMessageIndex: 3,
            assistantTranscriptOwned: true,
            assistantTranscriptIdempotencyKey: "progress-owned",
          },
        ),
      ]),
    ).toBe(SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION);
    expect(request([{ text: progress, mediaUrls: ["file:///tmp/result.png"] }])).toBeNull();
    expect(request([{ text: progress, channelData: { notice: "Ready" } }])).toBeNull();
    expect(
      request([
        setReplyPayloadMetadata({ text: progress }, { deliverDespiteSourceReplySuppression: true }),
      ]),
    ).toBeNull();
    expect(
      request([
        setReplyPayloadMetadata(
          { text: progress },
          {
            assistantMessageIndex: 3,
            sourceReplyTranscriptMirror: { sessionKey: "session:stale-error" },
          },
        ),
      ]),
    ).toBeNull();
    attempt.settledTurnFinalizationContext = {
      source: "openclaw-transcript",
      messages: attempt.messagesSnapshot,
    };
    expect(
      request([
        { text: progress },
        setReplyPayloadMetadata(
          { text: "The provider connection ended.", isError: true },
          { terminalProviderError: true },
        ),
      ]),
    ).toBe(SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION);

    const finalAnswer = "The file contains the requested value.";
    attempt.assistantTexts.push(finalAnswer);
    attempt.messagesSnapshot.push(
      buildEmbeddedRunnerAssistant({ content: [{ type: "text", text: finalAnswer }] }),
    );
    expect(request([{ text: finalAnswer }])).toBeNull();
  });

  const settledTurnPayloadRequest = (
    attempt: ReturnType<typeof makeEmbeddedRunnerAttempt>,
    terminalState: ReturnType<typeof resolveEmbeddedRunAttemptTerminalState>,
    payloadsWithToolMedia: SettledTurnPayloads,
  ) =>
    resolveSettledTurnFinalizationRequest({
      runParams: {
        sessionId: "session:settled-empty-payload",
        runId: "run:settled-empty-payload",
        workspaceDir: "/synthetic",
        prompt: "produce the final user-visible answer",
        timeoutMs: 60_000,
        trigger: "user",
        terminalReplyExpectation: "required",
      },
      attempt,
      activeErrorContext: { provider: "ollama-cloud", model: "glm-5.3-flash" },
      modelApi: "ollama",
      executionContract: undefined,
      payloadsWithToolMedia,
      hasTerminalToolPresentation: false,
      terminalState,
      settledTurnFinalizationAvailable: true,
    });

  const settledToolAttempt = () => {
    const assistant = buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool-1", name: "edit", arguments: {} }],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      toolMetas: [{ toolName: "edit", toolCallId: "tool-1", isError: false, replaySafe: true }],
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      messagesSnapshot: [
        assistant,
        makeTextToolResult("tool-1", "edit", "edited note.txt", false, 0),
      ],
      currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    });
    return {
      attempt,
      terminalState: resolveEmbeddedRunAttemptTerminalState({ attempt, assistant }),
    };
  };

  // Every tool settled successfully and the model produced no reply. A payload that
  // carries neither text nor content is not delivery evidence and must leave the
  // settled-tool continuation retry available (#169501).
  const emptyContentCases: Array<[string, SettledTurnPayloads]> = [
    ["no payload entries", []],
    ["empty text", [{ text: "" }]],
    ["whitespace-only text", [{ text: "   " }]],
    ["bare reasoning flag", [{ text: "", isReasoning: true }]],
    ["empty media list", [{ text: "", mediaUrls: [] }]],
    ["empty structured container", [{ text: "", channelData: {} }]],
  ];
  it.each(emptyContentCases)(
    "keeps the settled-tool continuation without payload content: %s",
    (_name: string, payloads: SettledTurnPayloads) => {
      const { attempt, terminalState } = settledToolAttempt();
      expect(settledTurnPayloadRequest(attempt, terminalState, payloads)).toBe(
        SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION,
      );
    },
  );

  // Legal controls: content the turn actually produced stays delivery evidence.
  const deliveryContentCases: Array<[string, SettledTurnPayloads]> = [
    ["visible answer text", [{ text: "Edited note.txt." }]],
    ["non-empty media", [{ text: "", mediaUrls: ["file:///tmp/note.txt"] }]],
    ["non-empty structured content", [{ text: "", channelData: { kind: "progress" } }]],
  ];
  it.each(deliveryContentCases)(
    "treats payload content as delivery evidence: %s",
    (_name: string, payloads: SettledTurnPayloads) => {
      const { attempt, terminalState } = settledToolAttempt();
      expect(settledTurnPayloadRequest(attempt, terminalState, payloads)).toBeNull();
    },
  );

  // The shipped producer that can hand the classifier a content-less payload: a tool asks
  // for voice delivery but returns no media, so the tool-media projection appends a payload
  // whose only non-text values are delivery booleans (#169501). A payload with nothing to
  // deliver must not consume the settled-tool continuation.
  it("keeps the continuation when the tool-media projection appends a payload without media", () => {
    const projected = mergeAttemptToolMediaPayloads({ payloads: [], toolAudioAsVoice: true });
    expect(projected).toHaveLength(1);
    expect(projected?.[0]?.text).toBeUndefined();
    expect(projected?.[0]?.mediaUrls ?? []).toEqual([]);
    expect(projected?.[0]?.mediaUrl).toBeUndefined();
    expect(projected?.[0]?.audioAsVoice).toBe(true);

    const { attempt, terminalState } = settledToolAttempt();
    expect(settledTurnPayloadRequest(attempt, terminalState, projected ?? [])).toBe(
      SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION,
    );
  });
});

describe("terminal presentation and delivery state", () => {
  it("carries presentation across retries until a newer tool outcome replaces it", () => {
    const tracker = createTerminalToolPresentationTracker();
    const firstOrdinal = tracker.allocateOrdinal();
    tracker.observe({
      toolCallOrdinal: firstOrdinal,
      terminalPresentation: "Fetched https://example.com",
    });

    expect(tracker.read()).toBe("Fetched https://example.com");

    const retryOrdinal = tracker.allocateOrdinal();
    expect(tracker.read()).toBe("Fetched https://example.com");
    tracker.observe({ toolCallOrdinal: retryOrdinal });
    tracker.observe({
      toolCallOrdinal: firstOrdinal,
      terminalPresentation: "stale presentation",
    });

    expect(tracker.read()).toBeUndefined();
  });
});
