// Payload tests cover successful embedded run replies, final-answer selection,
// message-tool source replies, media directives, and tool-error warning policy.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import type { InteractiveReply, MessagePresentation } from "../../../interactive/payload.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import type { ProcessTerminalDiagnostic, ToolErrorSummary } from "../../tool-error-summary.js";
import {
  buildPayloads,
  expectSinglePayloadText,
  expectSingleToolErrorPayload,
} from "./payloads.test-helpers.js";

describe("buildEmbeddedRunPayloads tool-error warnings", () => {
  function expectNoPayloads(params: Parameters<typeof buildPayloads>[0]) {
    // Many suppression cases should produce no channel reply at all; keep the
    // assertion explicit so accidental fallback text is obvious.
    const payloads = buildPayloads(params);
    expect(payloads).toHaveLength(0);
  }

  it("does not fall back to commentary-only assistant text when streamed text was suppressed", () => {
    const payloads = buildPayloads({
      lastAssistant: {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          {
            type: "text",
            text: "Need update cron messages to use finalBrief/briefPath.",
            textSignature: JSON.stringify({
              v: 1,
              id: "item_commentary",
              phase: "commentary",
            }),
          },
        ],
      } as AssistantMessage,
    });

    expect(payloads).toStrictEqual([]);
  });

  it("suppresses streamed text that only contains hidden reasoning", () => {
    const payloads = buildPayloads({
      assistantTexts: ["<mm:think>private reasoning</mm:think>"],
    });

    expect(payloads).toStrictEqual([]);
  });

  it("keeps indented code intact when preparing the final channel payload", () => {
    const text = `    ${"A".repeat(128)}\n\n    ${"B".repeat(128)}`;
    expectSinglePayloadText(buildPayloads({ assistantTexts: [text] }), text);
  });

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
      assistantTexts: ["</mm:think>MEDIA:/tmp/reply-image.png\nAttached image"],
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

  it("keeps literal mid-answer reasoning-looking tags in final-answer text", () => {
    const text = "Before <think>literal tag text after";
    const payloads = buildPayloads({
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [
          {
            type: "text",
            text,
            textSignature: JSON.stringify({
              v: 1,
              id: "item_final",
              phase: "final_answer",
            }),
          },
        ],
      } as AssistantMessage,
    });

    expectSinglePayloadText(payloads, text);
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

  it("uses the final assistant answer when one streamed text contains progress and final text", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Need inspect.\n\nDone."],
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: "Need inspect.",
            textSignature: JSON.stringify({
              v: 1,
              id: "item_commentary",
              phase: "commentary",
            }),
          },
          {
            type: "text",
            text: "Done.",
            textSignature: JSON.stringify({
              v: 1,
              id: "item_final",
              phase: "final_answer",
            }),
          },
        ],
      } as AssistantMessage,
    });

    expectSinglePayloadText(payloads, "Done.");
  });

  it("keeps a current one-chunk reply when only a stale transcript assistant is available", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Current room event reply."],
      currentAssistant: null,
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: "Previous transcript reply.",
            textSignature: JSON.stringify({
              v: 1,
              id: "item_previous",
              phase: "final_answer",
            }),
          },
        ],
      } as AssistantMessage,
    });

    expectSinglePayloadText(payloads, "Current room event reply.");
  });

  it.each([
    { stopReason: "stop", thinking: false, keepAnswer: false },
    { stopReason: "length", thinking: true, keepAnswer: false },
    { stopReason: "stop", thinking: false, keepAnswer: true },
  ] as const)(
    "does not use pre-tool text for an empty $stopReason answer (thinking=$thinking, kept=$keepAnswer)",
    ({ stopReason, thinking, keepAnswer }) => {
      const lastAssistant = makeAgentAssistantMessage({
        api: "ollama",
        provider: "ollama",
        stopReason,
        content: thinking ? [{ type: "thinking", thinking: "Still considering the result." }] : [],
      });
      const payloads = buildPayloads({
        assistantTexts: ["I will read the file.", "Checking the next file."],
        lastAssistant,
        keptAnswer: keepAnswer
          ? {
              assistant: makeAgentAssistantMessage({
                content: [{ type: "text", text: "Completed answer." }],
              }),
              messageIndex: 1,
            }
          : undefined,
      });
      expect(payloads.map((payload) => payload.text)).toEqual(
        keepAnswer ? ["Completed answer."] : [],
      );
    },
  );

  it.each(["Second answer.", "NO_REPLY", ""])(
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
      ).toEqual(middleAnswer === "Second answer." ? [2, 4, 6] : [2, 6]);
      expect(
        payloads.map((payload) => getReplyPayloadMetadata(payload)?.precedingInputAnswer),
      ).toEqual(middleAnswer === "Second answer." ? [true, true, undefined] : [true, undefined]);
    },
  );

  it("turns internal message-tool source replies into suppression-safe final payloads", () => {
    // message_tool_only source replies are already delivered internally but
    // still need mirror metadata so transcript/persistence can record them.
    const payloads = buildPayloads({
      assistantTexts: ["ordinary final should stay private"],
      didSendViaMessagingTool: true,
      messagingToolSourceReplyPayloads: [
        {
          text: "sent through message tool",
          mediaUrls: ["/tmp/reply.png"],
        },
      ],
      sourceReplyDeliveryMode: "message_tool_only",
      sessionKey: "agent:main",
      agentId: "main",
      runId: "run-1",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      text: "sent through message tool",
      mediaUrl: "/tmp/reply.png",
      mediaUrls: ["/tmp/reply.png"],
    });
    expect(getReplyPayloadMetadata(payloads[0] as object)).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
      sourceReplyTranscriptMirror: {
        sessionKey: "agent:main",
        agentId: "main",
        text: "sent through message tool",
        mediaUrls: ["/tmp/reply.png"],
        idempotencyKey: "run-1:internal-source-reply:0",
      },
    });
  });

  it("keeps progress delivery from publishing the private terminal assistant text", () => {
    const payloads = buildPayloads({
      assistantTexts: ["ordinary final should stay private"],
      didSendViaMessagingTool: true,
      didDeliverSourceReplyViaMessageTool: true,
      messagingToolSentTargets: [
        {
          tool: "message",
          provider: "discord",
          to: "channel:C1",
          sourceReplyFinal: false,
        },
      ],
      sourceReplyDeliveryMode: "message_tool_only",
      sessionKey: "agent:main",
      agentId: "main",
      runId: "run-1",
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

  it("surfaces declined Codex native command errors for aborted empty turns", () => {
    const payloads = buildPayloads({
      assistantTexts: [],
      lastToolError: {
        toolName: "bash",
        error: "codex native tool blocked",
        mutatingAction: true,
      },
      runAborted: true,
      runStopReason: "aborted",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Bash",
      absentDetail: "codex native tool blocked",
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

  it("keeps automation exec commands and paths private without full verbosity", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        meta: "show last 20 lines of ~/.openclaw/workspace/memory/2026-06-04.md",
        error:
          "tail: cannot open '/home/user/.openclaw/workspace/memory/2026-06-04.md' for reading: No such file or directory",
      },
      isCronTrigger: true,
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Exec",
      absentDetail: "/home/user/.openclaw/workspace/memory/2026-06-04.md",
    });
  });

  it("surfaces an unresolved mutation when an automation finishes with NO_REPLY", () => {
    expectSingleToolErrorPayload(
      buildPayloads({
        assistantTexts: ["NO_REPLY"],
        isCronTrigger: true,
        lastToolError: {
          toolName: "message",
          error: "cross-context messaging denied",
          mutatingAction: true,
        },
      }),
      { title: "Message", absentDetail: "cross-context messaging denied" },
    );
  });

  it("does not duplicate a visible acknowledgement of a mutating failure", () => {
    const text = "Message send failed because cross-context messaging was denied.";
    expectSinglePayloadText(
      buildPayloads({
        assistantTexts: [text],
        isCronTrigger: true,
        lastToolError: {
          toolName: "message",
          error: "cross-context messaging denied",
          mutatingAction: true,
        },
      }),
      text,
    );
  });

  it("keeps an unresolved automation failure visible beside reasoning-only output", () => {
    const payloads = buildPayloads({
      isCronTrigger: true,
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
    expect(payloads[1]).toMatchObject({ text: "⚠️ Message failed", isError: true });
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
      name: "keeps mutating tool failures compact when verbose is on",
      verboseLevel: "on" as const,
      detail: undefined,
      absentDetail: "permission denied",
    },
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

  it("suppresses assistant text when a deterministic exec approval prompt was already delivered", () => {
    expectNoPayloads({
      assistantTexts: ["Approval is needed. Please run /approve abc allow-once"],
      didSendDeterministicApprovalPrompt: true,
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

  it("keeps media directives when collapsing accumulated pre-tool text to the final answer", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Preparing the image...", "Attached image"],
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

  it.each([true, undefined])(
    "does not replace a delivered report with a failed verification read (final=%s)",
    (sourceReplyFinal) => {
      expect(
        buildPayloads({
          ...completedRun,
          messagingToolSentTargets: [{ ...deliveredReport, sourceReplyFinal }],
        }),
      ).toEqual([]);
    },
  );

  it.each([
    { name: "an unconfirmed send", messagingToolSentTargets: [] },
    {
      name: "an explicitly progress-only send",
      messagingToolSentTargets: [{ ...deliveredReport, sourceReplyFinal: false }],
    },
    {
      name: "a send without visible content",
      messagingToolSentTargets: [{ ...deliveredReport, text: "", visible: false }],
    },
    { name: "an aborted run", runAborted: true },
    { name: "a run without a final answer", assistantTexts: [] },
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

  it("does not recover delivery facts by parsing a pre-upgrade assistant", () => {
    const payloads = buildPayloads({
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "[[reply_to:message-7]] Recovered answer" }],
      } as AssistantMessage,
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("Recovered answer");
    expect(payloads[0]).not.toHaveProperty("replyToCurrent");
    expect(payloads[0]).not.toHaveProperty("replyToId");
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
