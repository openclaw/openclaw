import { describe, expect, it } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import type { MessagingToolSend } from "../../pi-embedded-messaging.types.js";
import {
  buildEmbeddedRunExecutionTrace,
  buildEmbeddedRunTerminalResult,
  resolveEmbeddedRunStopReason,
} from "./terminal-result.js";

describe("terminal-result helpers", () => {
  it("prioritizes hosted client tool calls and yield over provider stop reasons", () => {
    expect(
      resolveEmbeddedRunStopReason({
        clientToolCall: { name: "web_search", params: {} },
        yieldDetected: true,
        assistantStopReason: "stop",
      }),
    ).toBe("tool_calls");
    expect(
      resolveEmbeddedRunStopReason({
        yieldDetected: true,
        assistantStopReason: "stop",
      }),
    ).toBe("end_turn");
    expect(resolveEmbeddedRunStopReason({ assistantStopReason: "max_tokens" })).toBe("max_tokens");
  });

  it("builds embedded execution trace with fallback metadata", () => {
    const trace = buildEmbeddedRunExecutionTrace({
      traceAttempts: [
        {
          provider: "openai",
          model: "gpt-5.4-mini",
          result: "fallback_model",
          stage: "assistant",
        },
      ],
      winnerProvider: "openai",
      winnerModel: "gpt-5.4",
      includeSuccessAttempt: true,
    });

    expect(trace).toMatchObject({
      winnerProvider: "openai",
      winnerModel: "gpt-5.4",
      fallbackUsed: true,
      runner: "embedded",
    });
    expect(trace?.attempts).toHaveLength(2);
    expect(trace?.attempts?.at(-1)).toMatchObject({
      provider: "openai",
      model: "gpt-5.4",
      result: "success",
      stage: "assistant",
    });
  });

  it("preserves the legacy execution-trace shape when no attempt row should be emitted", () => {
    const trace = buildEmbeddedRunExecutionTrace({
      traceAttempts: [],
      winnerProvider: "openai",
      winnerModel: "gpt-5.4",
      includeSuccessAttempt: false,
    });

    expect(trace).toMatchObject({
      winnerProvider: "openai",
      winnerModel: "gpt-5.4",
      fallbackUsed: false,
      runner: "embedded",
    });
    expect(trace?.attempts).toBeUndefined();
  });

  it("assembles a success terminal result without keeping metadata wiring in run.ts", () => {
    const result = buildEmbeddedRunTerminalResult({
      attempt: {
        agentHarnessResultClassification: undefined,
        clientToolCall: { name: "web_search", params: { query: "openclaw" } },
        diagnosticTrace: undefined,
        didSendDeterministicApprovalPrompt: true,
        didSendViaMessagingTool: true,
        finalPromptText: "final prompt",
        messagingToolSentMediaUrls: ["https://example.test/image.png"],
        messagingToolSentTargets: [
          {
            tool: "messaging.send",
            provider: "telegram",
            to: "chat-1",
          } satisfies MessagingToolSend,
        ],
        messagingToolSentTexts: ["sent"],
        successfulCronAdds: 1,
        systemPromptReport: undefined,
      },
      payloadsWithToolMedia: [{ text: "done" }],
      emptyAssistantReplyIsSilent: false,
      durationMs: 42,
      agentMeta: {
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5.4",
      },
      aborted: false,
      finalAssistantVisibleText: "done",
      finalAssistantRawText: "done",
      replayInvalid: false,
      livenessState: "working",
      stopReason: "tool_calls",
      traceAttempts: [],
      winnerProvider: "openai",
      winnerModel: "gpt-5.4",
      includeSuccessTraceAttempt: true,
      lastProfileId: "openai:default",
      thinkLevel: "high",
      reasoningLevel: "medium",
      verboseLevel: "low",
      blockReplyBreak: "message_end",
      toolSummary: { calls: 1, tools: ["web_search"] },
      autoCompactionCount: 2,
      toolCallIdFactory: () => "tool-id",
    });

    expect(result.payloads).toEqual([{ text: "done" }]);
    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.didSendDeterministicApprovalPrompt).toBe(true);
    expect(result.meta.pendingToolCalls).toEqual([
      {
        id: "tool-id",
        name: "web_search",
        arguments: JSON.stringify({ query: "openclaw" }),
      },
    ]);
    expect(result.meta.requestShaping).toEqual({
      authMode: "auth-profile",
      thinking: "high",
      reasoning: "medium",
      verbose: "low",
      blockStreaming: "message_end",
    });
    expect(result.meta.completion).toEqual({
      stopReason: "tool_calls",
      finishReason: "tool_calls",
    });
    expect(result.meta.contextManagement).toEqual({ lastTurnCompactions: 2 });
  });

  it("turns silent empty completions into the canonical silent reply token", () => {
    const result = buildEmbeddedRunTerminalResult({
      attempt: {
        agentHarnessResultClassification: "empty",
        clientToolCall: undefined,
        diagnosticTrace: undefined,
        didSendDeterministicApprovalPrompt: undefined,
        didSendViaMessagingTool: false,
        finalPromptText: undefined,
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
        messagingToolSentTexts: [],
        successfulCronAdds: undefined,
        systemPromptReport: undefined,
      },
      payloadsWithToolMedia: undefined,
      emptyAssistantReplyIsSilent: true,
      durationMs: 1,
      agentMeta: {
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5.4",
      },
      aborted: false,
      replayInvalid: undefined,
      livenessState: "working",
      traceAttempts: [],
      winnerProvider: "openai",
      winnerModel: "gpt-5.4",
      autoCompactionCount: 0,
    });

    expect(result.payloads).toEqual([{ text: SILENT_REPLY_TOKEN }]);
    expect(result.meta.terminalReplyKind).toBe("silent-empty");
  });
});
