import { describe, expect, it } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { setReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { isReplaySafeToolCall } from "../../tool-mutation.js";
import { buildAttemptReplayMetadata } from "./attempt-terminal-evidence.js";
import { buildEmbeddedRunPayloads } from "./payloads.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";
import {
  createTerminalToolPresentationTracker,
  resolveEmbeddedRunTerminal,
  resolveSettledTurnFinalizationRequest,
} from "./terminal-resolution.js";
import { makeTerminalInput } from "./terminal-resolution.test-support.js";

const SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION =
  "Your turn ended without a final reply. If the user still needs a reply, write it now. If your completed actions already answered the request, answer exactly NO_REPLY. Continue from the current transcript. Do not repeat completed tool calls or restart from scratch. Tools are unavailable in this step: it is a text-only pass, so reply with plain text and do not attempt any tool call.";
const REQUIRED_RESULT_TOOL_TERMINAL_CONTINUATION_INSTRUCTION =
  "Your turn ended without a final result. Continue from the current transcript and produce the required result now. NO_REPLY is not allowed. Do not repeat completed tool calls or restart from scratch. Tools are unavailable in this step: it is a text-only pass, so reply with plain text and do not attempt any tool call.";

describe("resolveSettledTurnFinalizationRequest", () => {
  it.each([
    { toolName: "read", missingEvidence: false, keepsTools: true },
    { toolName: "read", toolError: true, missingEvidence: false, keepsTools: true },
    { toolName: "write", missingEvidence: false, keepsTools: false },
    { toolName: "read", missingEvidence: true, keepsTools: false },
  ])(
    "routes an empty stop after $toolName (error=$toolError, missing evidence=$missingEvidence, keeps tools=$keepsTools)",
    async ({ toolName, toolError = false, missingEvidence, keepsTools }) => {
      const toolAssistant = buildEmbeddedRunnerAssistant({
        stopReason: "toolUse",
        content: [
          { type: "toolCall", id: "file-1", name: toolName, arguments: { path: "index.txt" } },
        ],
      });
      const assistant = buildEmbeddedRunnerAssistant({ content: [] });
      const toolMetas = [
        {
          toolName,
          toolCallId: "file-1",
          isError: toolError,
          replaySafe: isReplaySafeToolCall(toolName, { path: "index.txt" }),
        },
      ];
      const attempt = makeEmbeddedRunnerAttempt({
        assistantTexts: [],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        messagesSnapshot: [
          { role: "user", content: "Read index.txt, then the files it lists.", timestamp: 0 },
          toolAssistant,
          makeTextToolResult("file-1", toolName, "remaining.txt", toolError, 1),
          assistant,
        ],
        toolMetas,
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        lastToolError: toolError ? { toolName, error: "File unavailable" } : undefined,
        // Earlier attempts' effects must not override this attempt's explicit evidence.
        replayMetadata: { hadPotentialSideEffects: !missingEvidence, replaySafe: missingEvidence },
        currentAttemptReplayMetadata: missingEvidence
          ? undefined
          : buildAttemptReplayMetadata({
              toolMetas,
              didSendViaMessagingTool: false,
              messagingToolSentTexts: [],
              messagingToolSentMediaUrls: [],
            }),
      });
      const input = makeTerminalInput({
        attempt,
        activeErrorContext: { provider: "groq", model: "openai/gpt-oss-120b" },
        modelApi: "openai-completions",
        runParams: { terminalReplyExpectation: "result-required" },
      });
      const finalization = resolveSettledTurnFinalizationRequest({
        ...input,
        payloadsWithToolMedia: [],
        hasTerminalToolPresentation: false,
        settledTurnFinalizationAvailable: true,
      });
      if (!keepsTools) {
        expect(finalization).toBe(REQUIRED_RESULT_TOOL_TERMINAL_CONTINUATION_INSTRUCTION);
        return;
      }
      // No isolated finalizer: the normal attempt retains its transcript and tools.
      expect(finalization).toBeNull();
      expect(await resolveEmbeddedRunTerminal(input)).toEqual({ action: "retry" });
      expect(input.sessionPromptState.activateInternalPrompt).toHaveBeenCalledWith(
        expect.stringContaining("using tools for any remaining work"),
      );
      expect(input.sessionPromptState.activateInternalPrompt).toHaveBeenCalledWith(
        expect.stringContaining("Do not repeat completed tool calls"),
      );
      if (toolError) {
        expect(input.sessionPromptState.activateInternalPrompt).toHaveBeenCalledWith(
          expect.stringContaining("If a tool failed, say so; never claim completion or success."),
        );
      }
      expect(input.retryState.emptyResponseAttempts).toBe(1);
      expect((await resolveEmbeddedRunTerminal(input)).action).toBe("complete");
      expect(input.sessionPromptState.activateInternalPrompt).toHaveBeenCalledTimes(1);
    },
  );

  it("requests isolated finalization only when empty settled-tool turns owe a result", () => {
    const assistant = buildEmbeddedRunnerAssistant({ content: [{ type: "text", text: "" }] });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      toolMetas: [{ toolName: "write", meta: "path=note.txt", replaySafe: false }],
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    });
    const terminalState = resolveEmbeddedRunAttemptTerminalState({ attempt, assistant });
    const request = (terminalReplyExpectation: "required" | "optional" | "result-required") =>
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
    expect(request("result-required")).toBe(REQUIRED_RESULT_TOOL_TERMINAL_CONTINUATION_INSTRUCTION);
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
    ).toBe(REQUIRED_RESULT_TOOL_TERMINAL_CONTINUATION_INSTRUCTION);
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
      content: [{ type: "toolCall", id: "tool-rejected", name: "dispatch_action", arguments: {} }],
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
        makeTextToolResult(
          "tool-rejected",
          "dispatch_action",
          "Required argument missing",
          true,
          0,
        ),
        silentAssistant,
      ],
      toolMetas: [
        {
          toolName: "dispatch_action",
          toolCallId: "tool-rejected",
          isError: true,
          replaySafe: true,
        },
      ],
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      lastToolError: { toolName: "dispatch_action", error: "Required argument missing" },
    });
    const request = (terminalReplyExpectation: "required" | "optional" | "result-required") =>
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

    expect(request("required")).toBeNull();
    expect(request("optional")).toBeNull();
    expect(request("result-required")).toContain(
      REQUIRED_RESULT_TOOL_TERMINAL_CONTINUATION_INSTRUCTION,
    );
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
