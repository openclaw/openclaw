import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  buildPayloads,
  expectSinglePayloadText,
  expectSingleToolErrorPayload,
} from "./payloads.test-helpers.js";

function makeAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    api: "responses",
    provider: "openai",
    model: "gpt-5",
    timestamp: Date.now(),
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: [{ type: "text", text }],
  } as AssistantMessage;
}

describe("buildEmbeddedRunPayloads tool-error warnings", () => {
  function expectNoPayloads(params: Parameters<typeof buildPayloads>[0]) {
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

    expect(payloads).toEqual([]);
  });

  it("falls back to final-answer assistant text when streamed text is unavailable", () => {
    const payloads = buildPayloads({
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

  it("falls back to final-answer assistant text when streamed text only contains blanks", () => {
    const payloads = buildPayloads({
      assistantTexts: ["   "],
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: "Fixed.",
            textSignature: JSON.stringify({
              v: 1,
              id: "item_final",
              phase: "final_answer",
            }),
          },
        ],
      } as AssistantMessage,
    });

    expectSinglePayloadText(payloads, "Fixed.");
  });

  it("suppresses exec tool errors when verbose mode is off", () => {
    expectNoPayloads({
      lastToolError: { toolName: "exec", error: "command failed" },
      verboseLevel: "off",
    });
  });

  it("surfaces exec tool errors for cron sessions even when verbose mode is off", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        timedOut: true,
        error:
          "Command timed out after 1800 seconds. If this command is expected to take longer, re-run with a higher timeout (e.g., exec timeout=300).",
      },
      sessionKey: "agent:main:cron:job-1",
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Exec",
      detail:
        "Command timed out after 1800 seconds. If this command is expected to take longer, re-run with a higher timeout (e.g., exec timeout=300).",
    });
  });

  it("surfaces timed-out exec tool errors for cron-triggered custom session keys", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "exec",
        timedOut: true,
        error: "Command timed out after 1800 seconds.",
      },
      sessionKey: "agent:main:project-alpha",
      isCronTrigger: true,
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Exec",
      detail: "Command timed out after 1800 seconds.",
    });
  });

  it("keeps non-timeout exec tool errors suppressed for cron sessions when verbose mode is off", () => {
    expectNoPayloads({
      lastToolError: { toolName: "exec", error: "Command not found" },
      sessionKey: "agent:main:cron:job-1",
      verboseLevel: "off",
    });
  });

  it("shows exec tool errors when verbose mode is on", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "exec", error: "command failed" },
      verboseLevel: "on",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Exec",
      detail: "command failed",
    });
  });

  it("keeps non-exec mutating tool failures visible", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "write", error: "permission denied" },
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Write",
      absentDetail: "permission denied",
    });
  });

  it.each([
    {
      name: "includes details for mutating tool failures when verbose is on",
      verboseLevel: "on" as const,
      detail: "permission denied",
      absentDetail: undefined,
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

  it.each([
    {
      name: "default relay failure",
      lastToolError: { toolName: "sessions_send", error: "delivery timeout" },
    },
    {
      name: "mutating relay failure",
      lastToolError: {
        toolName: "sessions_send",
        error: "delivery timeout",
        mutatingAction: true,
      },
    },
  ])("suppresses sessions_send errors for $name", ({ lastToolError }) => {
    expectNoPayloads({
      lastToolError,
      verboseLevel: "on",
    });
  });

  it("suppresses assistant text when a deterministic exec approval prompt was already delivered", () => {
    expectNoPayloads({
      assistantTexts: ["Approval is needed. Please run /approve abc allow-once"],
      didSendDeterministicApprovalPrompt: true,
    });
  });

  it("suppresses JSON NO_REPLY assistant payloads", () => {
    expectNoPayloads({
      assistantTexts: ['{"action":"NO_REPLY"}'],
    });
  });

  it("strips NO_REPLY text but keeps voice media directives", () => {
    const payloads = buildPayloads({
      assistantTexts: ["NO_REPLY\nMEDIA:/tmp/openclaw/tts-a/voice-a.opus\n[[audio_as_voice]]"],
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      mediaUrl: "/tmp/openclaw/tts-a/voice-a.opus",
      mediaUrls: ["/tmp/openclaw/tts-a/voice-a.opus"],
      audioAsVoice: true,
    });
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
    expect(payloads[0]).toMatchObject({
      text: "Attached image",
      mediaUrl: "/tmp/reply-image.png",
      mediaUrls: ["/tmp/reply-image.png"],
    });
  });

  it("uses raw final assistant text when visible-text extraction removed a media-only directive line", () => {
    const payloads = buildPayloads({
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
    expect(payloads[0]).toMatchObject({
      text: "Attached image",
      mediaUrl: "/tmp/reply-image.png",
      mediaUrls: ["/tmp/reply-image.png"],
    });
  });

  it("suppresses native reasoning payloads when thinking is disabled", () => {
    const payloads = buildPayloads({
      reasoningLevel: "on",
      thinkingLevel: "off",
      lastAssistant: {
        role: "assistant",
        stopReason: "stop",
        content: [
          {
            type: "thinking",
            thinking: "",
            thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_live", summary: [] }),
          },
          { type: "text", text: "THINKING-OFF-OK" },
        ],
      } as AssistantMessage,
    });

    expectSinglePayloadText(payloads, "THINKING-OFF-OK");
  });
});

describe("buildEmbeddedRunPayloads downgraded tool call detection", () => {
  it("surfaces downgraded text-form tool calls as an explicit error", () => {
    const payloads = buildPayloads({
      lastAssistant: makeAssistantMessage(
        `[Tool Call: read (ID: toolu_1)]\nArguments: {"path":"notes.md"}`,
      ),
    });

    expectSinglePayloadText(
      payloads,
      "⚠️ The model emitted a text-form tool call instead of executing a real tool. No tool action was actually run. Please retry, or switch to a provider/model with reliable tool calling.",
      true,
    );
  });

  it("does not add a second tool warning after a synthetic downgraded-tool error", () => {
    const payloads = buildPayloads({
      lastAssistant: makeAssistantMessage(
        `[Tool Call: read (ID: toolu_1)]\nArguments: {"path":"notes.md"}`,
      ),
      lastToolError: { toolName: "read", error: "permission denied" },
      verboseLevel: "on",
    });

    expectSinglePayloadText(
      payloads,
      "⚠️ The model emitted a text-form tool call instead of executing a real tool. No tool action was actually run. Please retry, or switch to a provider/model with reliable tool calling.",
      true,
    );
  });

  it("keeps normal replies that only quote downgraded tool markers", () => {
    const quotedToolMarkerReply =
      "For debugging, the transcript may include literal text like [Tool Call: read (ID: toolu_1)] before the real answer.";
    const payloads = buildPayloads({
      assistantTexts: [quotedToolMarkerReply],
      lastAssistant: makeAssistantMessage(quotedToolMarkerReply),
    });

    expectSinglePayloadText(payloads, quotedToolMarkerReply);
  });
});

describe("buildEmbeddedRunPayloads placeholder reply detection", () => {
  it("surfaces short non-executing placeholder replies as an explicit error", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Let me actually check that now instead of just saying I will. One sec."],
      lastAssistant: makeAssistantMessage(
        "Let me actually check that now instead of just saying I will. One sec.",
      ),
    });

    expectSinglePayloadText(
      payloads,
      "⚠️ The agent returned a placeholder reply without starting any real tool work. Please retry, or switch to a provider/model with reliable tool execution.",
      true,
    );
  });

  it("does not flag placeholder replies when structured tool activity occurred", () => {
    const payloads = buildPayloads({
      assistantTexts: ["Let me check that now. One sec."],
      lastAssistant: makeAssistantMessage("Let me check that now. One sec."),
      toolMetas: [{ toolName: "exec" }],
    });

    expectSinglePayloadText(payloads, "Let me check that now. One sec.");
  });

  it("keeps substantive plain-text answers that do not match placeholder heuristics", () => {
    const payloads = buildPayloads({
      assistantTexts: ["I checked the file and the config key is missing from the JSON payload."],
      lastAssistant: makeAssistantMessage(
        "I checked the file and the config key is missing from the JSON payload.",
      ),
    });

    expectSinglePayloadText(
      payloads,
      "I checked the file and the config key is missing from the JSON payload.",
    );
  });

  it("keeps normal replies that mention placeholder phrases inline", () => {
    const reply =
      "The benchmark completes in one sec on my machine, but it still needs CI confirmation.";
    const payloads = buildPayloads({
      assistantTexts: [reply],
      lastAssistant: makeAssistantMessage(reply),
    });

    expectSinglePayloadText(payloads, reply);
  });
});
