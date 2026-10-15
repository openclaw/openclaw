// Payload tests cover successful embedded run replies, final-answer selection,
// message-tool source replies, media directives, and tool-error warning policy.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { resolveHeartbeatReplyPayload } from "../../../auto-reply/heartbeat-reply-payload.js";
import { selectHeartbeatToolResponse } from "../../../auto-reply/heartbeat-tool-response.js";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import { classifyHeartbeatAgentOutcome } from "../../../infra/heartbeat-delivery-normalization.js";
import type { InteractiveReply, MessagePresentation } from "../../../interactive/payload.js";
import { observeReplyDelivery } from "../../reply-completion.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import type { ProcessTerminalDiagnostic, ToolErrorSummary } from "../../tool-error-summary.js";
import {
  buildPayloads,
  expectSinglePayloadText,
  expectSingleToolErrorPayload,
} from "./payloads.test-helpers.js";
import { mergeAttemptToolMediaPayloads } from "./tool-media-payloads.js";

describe("buildEmbeddedRunPayloads tool-error warnings", () => {
  it.each(["observation-failed", "missing"] as const)(
    "retains delivery custody before selecting current text and media (%s)",
    async (observation) => {
      const errors: unknown[] = [];
      const sourceReplyDeliveryState = await observeReplyDelivery(
        async () => {
          if (observation === "observation-failed") {
            throw new Error("delivery observation unavailable");
          }
          return observation;
        },
        2,
        (error) => errors.push(error),
      );
      expect(errors).toHaveLength(observation === "observation-failed" ? 1 : 0);
      const payloads = buildPayloads({
        assistantTexts: ["Current answer.\nMEDIA:./current.pdf"],
        sourceReplyDeliveryState,
        sourceReplyDeliveryMode: "automatic",
        messagingToolSourceReplyPayloads: [{ text: "Earlier reply.", sourceReplyFinal: true }],
        verboseLevel: "full",
        lastToolError: { toolName: "exec", error: "verification failed" },
      });
      expect(payloads).toEqual([
        expect.objectContaining({ text: "Earlier reply." }),
        ...(observation === "missing"
          ? [expect.objectContaining({ text: "Current answer.", mediaUrl: "./current.pdf" })]
          : []),
      ]);
    },
  );

  function expectNoPayloads(params: Parameters<typeof buildPayloads>[0]) {
    // Many suppression cases should produce no channel reply at all; keep the
    // assertion explicit so accidental fallback text is obvious.
    const payloads = buildPayloads(params);
    expect(payloads).toHaveLength(0);
  }

  it("sanitizes every streamed text while preserving multiple visible answers", () => {
    const payloads = buildPayloads({
      assistantTexts: [
        '<tool_call>{"name":"exec","arguments":{"command":"secret"}}</tool_call>',
        "  </mm:think>First visible answer.  ",
        "\nSecond visible answer.\n",
      ],
    });

    expect(payloads.map((payload) => payload.text)).toStrictEqual([
      "First visible answer.",
      "Second visible answer.",
    ]);
  });

  it("keeps media directives while sanitizing streamed assistant text", () => {
    const payloads = buildPayloads({
      assistantTexts: [
        "<mm:think>private reasoning</mm:think>",
        "</mm:think>MEDIA:/tmp/reply-image.png\nAttached image",
      ],
      assistantMessageIndex: 1,
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("Attached image");
    expect(payloads[0]?.mediaUrl).toBe("/tmp/reply-image.png");
    expect(payloads[0]?.mediaUrls).toEqual(["/tmp/reply-image.png"]);
    expect(getReplyPayloadMetadata(payloads[0] as object)).toMatchObject({
      assistantMessageIndex: 1,
      assistantTranscriptMediaUrls: ["/tmp/reply-image.png"],
    });
  });

  it("marks runtime-persisted final replies as transcript owned", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Already persisted."],
      assistantTranscriptOwned: true,
      assistantTranscriptIdempotencyKey: "runtime-owned-assistant",
    });

    expect(payloads).toHaveLength(1);
    expect(getReplyPayloadMetadata(payloads[0] as object)).toMatchObject({
      assistantTranscriptOwned: true,
      assistantTranscriptIdempotencyKey: "runtime-owned-assistant",
    });
  });

  it("does not revive signed unphased text when explicit output_text final-answer text is empty", () => {
    expectNoPayloads({
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: "MEDIA:/tmp/old.png",
            textSignature: JSON.stringify({ v: 1, id: "item_old" }),
          },
          {
            type: "output_text",
            text: "   ",
            textSignature: JSON.stringify({
              v: 1,
              id: "item_final",
              phase: "final_answer",
            }),
          },
        ],
      } as AssistantMessage,
    });
  });

  it("keeps strict reasoning-tag stripping for legacy string fallback text", () => {
    const payloads = buildPayloads({
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: "Visible prefix <think>private reasoning tail",
      } as unknown as AssistantMessage,
    });

    expectSinglePayloadText(payloads, "Visible prefix");
  });

  it("uses the kept answer instead of pre-tool text for an empty terminal answer", () => {
    const lastAssistant = makeAgentAssistantMessage({
      api: "ollama",
      provider: "ollama",
      stopReason: "stop",
      content: [],
    });
    const payloads = buildPayloads({
      assistantTexts: ["I will read the file.", "Checking the next file."],
      lastAssistant,
      keptAnswer: {
        assistant: makeAgentAssistantMessage({
          content: [{ type: "text", text: "Completed answer." }],
        }),
        messageIndex: 1,
      },
    });
    expect(payloads.map((payload) => payload.text)).toEqual(["Completed answer."]);
  });

  it.each(["NO_REPLY"])(
    "buildEmbeddedRunPayloads selects each sealed and open segment's answer with middle answer %s",
    (middleAnswer) => {
      const answers = ["First answer.", middleAnswer, "Third answer."];
      const messages = answers.map((text) =>
        makeAgentAssistantMessage({ content: [{ type: "text", text }] }),
      );
      const payloads = buildPayloads({
        assistantTexts: answers.flatMap((text) => ["Checking first.", text]),
        answerSegments: messages.slice(0, 2).map((lastAssistant, index) => ({
          textEnd: (index + 1) * 2,
          messageEnd: (index + 1) * 2,
          finalMessageStart: (index + 1) * 2,
          lastAssistant,
        })),
        lastAssistant: messages[2],
        currentAssistant: messages[2],
        assistantMessageIndex: 6,
      });
      expect(payloads.map((payload) => payload.text)).toEqual(
        answers.filter((text) => text && text !== "NO_REPLY"),
      );
      expect(
        payloads.map((payload) => getReplyPayloadMetadata(payload)?.assistantMessageIndex),
      ).toEqual([2, 6]);
      expect(
        payloads.map((payload) => getReplyPayloadMetadata(payload)?.precedingInputAnswer),
      ).toEqual([true, undefined]);
    },
  );

  it("does not append a presentation failure after confirmed automatic source completion", () => {
    const payloads = buildPayloads({
      lastAssistant: makeAgentAssistantMessage({
        stopReason: "error",
        errorMessage: "presentation failed after delivery",
        content: [],
      }),
      lastToolError: { toolName: "message", error: "presentation failed after delivery" },
      didDeliverSourceReplyViaMessageTool: true,
      sourceReplyDeliveryMode: "automatic",
    });

    expect(payloads).toEqual([]);
  });

  it("preserves rich-only internal message-tool source replies", () => {
    const presentation = {
      blocks: [
        {
          type: "buttons",
          buttons: [{ label: "Approve", value: "approve" }],
        },
      ],
    } satisfies MessagePresentation;
    const interactive = {
      blocks: [
        {
          type: "buttons",
          buttons: [{ label: "Open", value: "open" }],
        },
      ],
    } satisfies InteractiveReply;

    const payloads = buildPayloads({
      assistantTexts: ["ordinary final should stay private"],
      didSendViaMessagingTool: true,
      messagingToolSourceReplyPayloads: [
        {
          presentation,
        },
        {
          interactive,
        },
      ],
      sourceReplyDeliveryMode: "message_tool_only",
      sessionKey: "agent:main",
      agentId: "main",
      runId: "run-1",
    });

    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({ presentation });
    expect(payloads[0]?.text).toBeUndefined();
    expect(payloads[1]).toMatchObject({ interactive });
    expect(payloads[1]?.text).toBeUndefined();
    expect(getReplyPayloadMetadata(payloads[0] as object)).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
      sourceReplyTranscriptMirror: {
        sessionKey: "agent:main",
        agentId: "main",
        idempotencyKey: "run-1:internal-source-reply:0",
      },
    });
    expect(getReplyPayloadMetadata(payloads[1] as object)).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
      sourceReplyTranscriptMirror: {
        sessionKey: "agent:main",
        agentId: "main",
        idempotencyKey: "run-1:internal-source-reply:1",
      },
    });
  });

  it("renders an intentional Gateway restart as status", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "gateway_exec",
        error: "OpenClaw dynamic tool call aborted.",
        executionStarted: true,
      },
      runAborted: true,
      runStopReason: "restart",
      toolResultFormat: "markdown",
    });

    expect(payloads).toEqual([{ text: "Gateway restarting…" }]);
  });

  it("keeps heartbeat exec commands and paths private without full verbosity", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        meta: "show last 20 lines of ~/.openclaw/workspace/memory/2026-06-04.md",
        error:
          "tail: cannot open '/home/user/.openclaw/workspace/memory/2026-06-04.md' for reading: No such file or directory",
      },
      isHeartbeatTrigger: true,
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Exec",
      absentDetail: "/home/user/.openclaw/workspace/memory/2026-06-04.md",
    });
  });

  it("adds a tool warning when a heartbeat failure leaves only reasoning", () => {
    const payloads = buildPayloads({
      isHeartbeatTrigger: true,
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "thinking", thinking: "Private reasoning only." }],
      } as AssistantMessage,
      lastToolError: {
        toolName: "message",
        error: "cross-context messaging denied",
        mutatingAction: true,
      },
      reasoningLevel: "on",
      thinkingLevel: "high",
    });

    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({ text: "Private reasoning only.", isReasoning: true });
    expect(resolveHeartbeatReplyPayload(payloads)).toMatchObject({
      text: "⚠️ Message failed",
      isError: true,
    });
    for (const payload of payloads) {
      expect(getReplyPayloadMetadata(payload)?.heartbeatTerminalToolFailure).toEqual({
        toolName: "message",
      });
    }
  });

  it("does not infer a terminal mutation from a mixed-action tool name", () => {
    const payloads = buildPayloads({
      heartbeatToolResponse: {
        outcome: "no_change",
        notify: false,
        summary: "Nothing needs attention.",
      },
      isHeartbeatTrigger: true,
      lastToolError: {
        toolName: "message",
        error: "message search failed",
      },
    });

    expectSinglePayloadText(payloads, "HEARTBEAT_OK");
    expect(
      getReplyPayloadMetadata(payloads[0] as object)?.heartbeatTerminalToolFailure,
    ).toBeUndefined();
  });

  it("shows exec tool error details when verbose mode is full", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "exec", error: "command failed" },
      verboseLevel: "full",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Exec",
      detail: "command failed",
    });
  });

  it.each([
    {
      name: "includes details for mutating tool failures when verbose is full",
      verboseLevel: "full" as const,
      detail: "permission denied",
      absentDetail: undefined,
    },
  ])("$name", ({ verboseLevel, detail, absentDetail }) => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "write", error: "permission denied" },
      verboseLevel,
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Write",
      detail,
      absentDetail,
    });
  });

  it("strips NO_REPLY text but keeps voice media directives", () => {
    const payloads = buildPayloads({
      assistantTexts: ["NO_REPLY\nMEDIA:/tmp/openclaw/tts-a/voice-a.opus\n[[audio_as_voice]]"],
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.mediaUrl).toBe("/tmp/openclaw/tts-a/voice-a.opus");
    expect(payloads[0]?.mediaUrls).toEqual(["/tmp/openclaw/tts-a/voice-a.opus"]);
    expect(payloads[0]?.audioAsVoice).toBe(true);
    expect(payloads[0]?.text).toBeUndefined();
  });

  it("preserves media directives when stored assistant text was reduced to visible text only", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Attached image"],
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: "MEDIA:/tmp/reply-image.png\nAttached image",
            textSignature: JSON.stringify({
              v: 1,
              id: "item_final",
              phase: "final_answer",
            }),
          },
        ],
      } as AssistantMessage,
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("Attached image");
    expect(payloads[0]?.mediaUrl).toBe("/tmp/reply-image.png");
    expect(payloads[0]?.mediaUrls).toEqual(["/tmp/reply-image.png"]);
  });
});

describe("cron completion after a delivered report", () => {
  const deliveredReport = {
    tool: "message",
    provider: "slack",
    to: "C_REPORTS",
    text: "The daily report is complete.",
  };
  const completedRun = {
    isCronTrigger: true,
    assistantTexts: ["NO_REPLY"],
    didSendViaMessagingTool: true,
    messagingToolSentTargets: [deliveredReport],
    lastToolError: {
      toolName: "codex_apps.slack.slack_read_thread",
      error: "429 RATE_LIMITED",
      mutatingAction: false,
    },
  };

  it.each([
    {
      name: "a send without visible content",
      messagingToolSentTargets: [{ ...deliveredReport, text: "", visible: false }],
    },
    { name: "a heartbeat", isHeartbeatTrigger: true },
  ])("still reports failure for $name", ({ name: _name, ...overrides }) => {
    expect(buildPayloads({ ...completedRun, ...overrides })).toEqual([
      expect.objectContaining({ isError: true }),
    ]);
  });
});

describe("buildEmbeddedRunPayloads delivery recovery", () => {
  it("uses persisted delivery facts for a recovered final assistant", () => {
    const payloads = buildPayloads({
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Recovered answer" }],
        openclawDelivery: {
          audioAsVoice: true,
          replyToCurrent: true,
          replyToId: "message-7",
          tts: {
            tagged: true,
            text: "Recovered speech",
          },
        },
      } as AssistantMessage,
    });

    expect(payloads).toEqual([
      expect.objectContaining({
        text: "Recovered answer",
        audioAsVoice: true,
        replyToCurrent: true,
        replyToId: "message-7",
      }),
    ]);
    expect(getReplyPayloadMetadata(payloads[0]!)?.tts).toEqual({
      tagged: true,
      text: "Recovered speech",
    });
  });
});

describe("quiet heartbeat failures", () => {
  it.each(["exec"])("does not notify after a failed %s and generated media", (toolName) => {
    const payloads = buildPayloads({
      assistantTexts: ["Everything is fine."],
      heartbeatToolResponse: {
        outcome: "no_change",
        notify: false,
        summary: "Nothing needs attention.",
      },
      isHeartbeatTrigger: true,
      lastToolError: { toolName, error: "operation failed", mutatingAction: true },
    });
    const merged = mergeAttemptToolMediaPayloads({
      payloads,
      toolMediaUrls: ["/tmp/heartbeat.png"],
      hostOwnedToolMediaUrls: ["/tmp/heartbeat.png"],
      toolAutoDeliveryMediaUrls: ["/tmp/heartbeat.opus"],
      toolAudioAsVoice: true,
      sourceReplyDeliveryMode: "message_tool_only",
    });
    expect(
      classifyHeartbeatAgentOutcome({
        agentRun: {
          agentRunFailed: false,
          heartbeatToolResponse: selectHeartbeatToolResponse(merged)?.response,
          heartbeatTerminalToolFailure: { toolName },
          replyPayload: resolveHeartbeatReplyPayload(merged),
        },
        useHeartbeatFailureCopy: true,
        hasRelayableExecCompletion: false,
        suppressUnmarkedSourceReplies: false,
        responsePrefix: undefined,
        ackMaxChars: 300,
      }),
    ).toMatchObject({ kind: "failure", reason: "agent-tool-failure", shouldSkipMain: true });
  });
});

describe("buildEmbeddedRunPayloads process-error warnings", () => {
  it("surfaces safe terminal diagnostics when verbose mode is off", () => {
    const dummyTelegramToken = `123456:${"A".repeat(28)}WXYZ`;
    const lastToolError: ToolErrorSummary = {
      toolName: "process",
      error: `SAFE_PROCESS_STDERR ${dummyTelegramToken}`,
      terminalDiagnostic: {
        kind: "process",
        sessionId: "wild-lagoon",
        reason: { kind: "exit", exitCode: 7 },
      },
    };
    const payloads = buildPayloads({ lastToolError, verboseLevel: "off" });

    expectSingleToolErrorPayload(payloads, {
      title: "Process",
      absentDetail: "SAFE_PROCESS_STDERR",
    });
    expect(payloads[0]?.text).not.toContain("wild-lagoon");
    expect(payloads[0]?.text).not.toContain(dummyTelegramToken);
    expect(payloads[0]?.text).toContain("exit 7");
    expect(payloads[0]?.text).not.toContain("/verbose");
  });

  it("shows a sanitized bounded error only at full verbosity", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "process",
        error: "SAFE_PROCESS_STDERR",
        terminalDiagnostic: {
          kind: "process",
          sessionId: "wild-lagoon",
          reason: { kind: "exit", exitCode: 7 },
        },
      },
      verboseLevel: "full",
    });

    expect(payloads[0]?.text).toContain("SAFE_PROCESS_STDERR");
    expect(payloads[0]?.text).not.toContain("/verbose full");
  });

  it.each([
    {
      label: "signal",
      reason: { kind: "signal", signal: "SIGKILL" } as const,
      expected: "signal SIGKILL",
    },
    {
      label: "overall timeout",
      reason: { kind: "timeout", timeoutKind: "overall-timeout" } as const,
      expected: "timed out",
    },
    {
      label: "no-output timeout",
      reason: { kind: "timeout", timeoutKind: "no-output-timeout" } as const,
      expected: "timed out waiting for output",
    },
  ])("renders $label without fabricating an exit code", ({ reason, expected }) => {
    const terminalDiagnostic: ProcessTerminalDiagnostic = {
      kind: "process",
      sessionId: "wild-lagoon",
      reason,
    };
    const payloads = buildPayloads({
      lastToolError: { toolName: "process", terminalDiagnostic },
      verboseLevel: "off",
    });

    expect(payloads[0]?.text).toContain(expected);
    expect(payloads[0]?.text).not.toMatch(/exit -?\d+/u);
  });
});
