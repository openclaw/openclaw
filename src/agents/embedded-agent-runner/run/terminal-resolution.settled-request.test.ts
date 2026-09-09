import { describe, expect, it } from "vitest";
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
});
