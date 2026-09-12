import { describe, expect, it } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { setReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { buildEmbeddedRunPayloads } from "./payloads.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";
import { resolveSettledTurnFinalizationRequest } from "./terminal-resolution.js";

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

  it("keeps explicit silence terminal across required and optional settled turns", () => {
    const toolUseAssistant = buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool-1", name: "write", arguments: {} }],
    });
    const silentAssistant = buildEmbeddedRunnerAssistant({
      stopReason: "stop",
      content: [{ type: "text", text: SILENT_REPLY_TOKEN }],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [SILENT_REPLY_TOKEN],
      toolMetas: [{ toolName: "write", toolCallId: "tool-1", replaySafe: false }],
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      messagesSnapshot: [
        { role: "user", content: [{ type: "text", text: "[OpenClaw heartbeat poll]" }] },
        toolUseAssistant,
        { role: "toolResult", toolCallId: "tool-1", toolName: "write", isError: false },
        silentAssistant,
      ] as never,
      lastAssistant: silentAssistant,
      currentAttemptAssistant: silentAssistant,
      replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });

    const request = (runParams: {
      trigger: "heartbeat" | "user";
      terminalReplyExpectation?: "required";
    }) =>
      resolveSettledTurnFinalizationRequest({
        runParams: {
          sessionId: "session:settled-silent",
          runId: "run:settled-silent",
          allowEmptyAssistantReplyAsSilent: true,
          ...runParams,
        } as never,
        attempt,
        activeErrorContext: { provider: "openai", model: "gpt-5.6-luna" },
        modelApi: "openai-responses",
        executionContract: undefined,
        payloadsWithToolMedia: [],
        hasTerminalToolPresentation: false,
        terminalState: resolveEmbeddedRunAttemptTerminalState({
          attempt,
          assistant: silentAssistant,
        }),
        settledTurnFinalizationAvailable: true,
      });

    expect(request({ trigger: "heartbeat" })).toBeNull();
    expect(request({ trigger: "user", terminalReplyExpectation: "required" })).toBeNull();
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
