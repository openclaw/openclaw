// Tool-authored source replies take the existing source-reply path: delivered to
// the source even when automatic replies are suppressed, and mirrored into the
// transcript by delivery because no tool owns the transcript row yet.
import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { buildPayloads } from "./payloads.test-helpers.js";

const toolAuthoredReply = {
  text: "Pedido SO1 creado. 18 botellas · total 459,85 €.",
  mediaUrls: ["/tmp/albaran.pdf"],
  idempotencyKey: "run-1:tool-source-reply:tc-1",
  sourceReplyFinal: true,
  toolAuthored: true as const,
  toolAuthoredForToolCallId: "tc-1",
};

const toolAssistant = makeAgentAssistantMessage({
  stopReason: "toolUse",
  content: [
    { type: "text", text: "I will check the order now." },
    { type: "toolCall", id: "tc-1", name: "order_status", arguments: {} },
  ],
});

describe("tool-authored source reply payloads", () => {
  it.each(["automatic", "message_tool_only"] as const)(
    "delivers the reply and asks delivery to write its transcript row in %s mode",
    (sourceReplyDeliveryMode) => {
      const payloads = buildPayloads({
        assistantTexts: ["I will check the order now."],
        lastAssistant: toolAssistant,
        messagingToolSourceReplyPayloads: [toolAuthoredReply],
        sourceReplyDeliveryMode,
        sessionKey: "agent:vinalia:telegram:123",
        runId: "run-1",
        agentId: "vinalia",
      });

      expect(payloads).toHaveLength(1);
      expect(payloads[0]).toMatchObject({
        text: toolAuthoredReply.text,
        mediaUrls: ["/tmp/albaran.pdf"],
      });
      const metadata = getReplyPayloadMetadata(payloads[0] as object);
      expect(metadata?.deliverDespiteSourceReplySuppression).toBe(true);
      expect(metadata?.sourceReplyTranscriptMirror).toEqual({
        sessionKey: "agent:vinalia:telegram:123",
        agentId: "vinalia",
        text: toolAuthoredReply.text,
        mediaUrls: ["/tmp/albaran.pdf"],
        idempotencyKey: "run-1:tool-source-reply:tc-1",
      });
    },
  );

  it.each(["automatic", "message_tool_only"] as const)(
    "preserves earlier and later input answers around a tool-authored reply in %s mode",
    (sourceReplyDeliveryMode) => {
      const earlier = makeAgentAssistantMessage({
        content: [{ type: "text", text: "Earlier answer." }],
      });
      const later = makeAgentAssistantMessage({
        content: [{ type: "text", text: "Later answer." }],
      });
      const payloads = buildPayloads({
        sourceReplyDeliveryMode,
        assistantTexts: ["Earlier answer.", "I will check the order now.", "Later answer."],
        answerSegments: [
          { textEnd: 1, messageEnd: 1, finalMessageStart: 1, lastAssistant: earlier },
          { textEnd: 2, messageEnd: 2, finalMessageStart: 2, lastAssistant: toolAssistant },
        ],
        lastAssistant: later,
        messagingToolSourceReplyPayloads: [toolAuthoredReply],
      });
      expect(payloads.map((payload) => payload.text)).toEqual([
        "Earlier answer.",
        toolAuthoredReply.text,
        "Later answer.",
      ]);
    },
  );

  it.each(["turnId", "responseId"] as const)(
    "does not attach a later reply to an earlier input that reused the same call ID (%s)",
    (identity) => {
      const earlier = {
        ...toolAssistant,
        [identity]: "earlier-turn",
        content: [
          { type: "text" as const, text: "Earlier answer." },
          { type: "toolCall" as const, id: "tc-1", name: "order_status", arguments: {} },
        ],
      };
      const payloads = buildPayloads({
        assistantTexts: ["Earlier answer.", "I will check the order now."],
        answerSegments: [
          { textEnd: 1, messageEnd: 1, finalMessageStart: 1, lastAssistant: earlier },
        ],
        lastAssistant: { ...toolAssistant, [identity]: "current-turn" },
        messagingToolSourceReplyPayloads: [
          { ...toolAuthoredReply, toolAuthoredForTurnId: "current-turn" },
        ],
      });
      expect(payloads.map((payload) => payload.text)).toEqual([
        "Earlier answer.",
        toolAuthoredReply.text,
      ]);
    },
  );

  it("preserves a sealed earlier answer before the current tool-authored final", () => {
    const earlier = makeAgentAssistantMessage({
      content: [{ type: "text", text: "Earlier answer." }],
    });
    const payloads = buildPayloads({
      assistantTexts: ["Earlier answer.", "I will check the order now."],
      answerSegments: [{ textEnd: 1, messageEnd: 1, finalMessageStart: 1, lastAssistant: earlier }],
      lastAssistant: toolAssistant,
      messagingToolSourceReplyPayloads: [toolAuthoredReply],
    });
    expect(payloads.map((payload) => payload.text)).toEqual([
      "Earlier answer.",
      toolAuthoredReply.text,
    ]);
  });

  it("does not let an earlier tool-authored reply hide a later assistant failure", () => {
    const failed = makeAgentAssistantMessage({
      stopReason: "error",
      content: [],
      errorMessage: "Provider request failed.",
    });
    const payloads = buildPayloads({
      sourceReplyDeliveryMode: "message_tool_only",
      assistantTexts: ["I will check the order now."],
      answerSegments: [
        { textEnd: 1, messageEnd: 1, finalMessageStart: 1, lastAssistant: toolAssistant },
      ],
      lastAssistant: failed,
      messagingToolSourceReplyPayloads: [toolAuthoredReply],
    });
    expect(payloads[0]?.text).toBe(toolAuthoredReply.text);
    expect(payloads.some((payload) => payload.isError)).toBe(true);
  });

  it("does not let an earlier authored reply hide later tool failure with no answer", () => {
    const payloads = buildPayloads({
      assistantTexts: ["I will check the order now."],
      answerSegments: [
        { textEnd: 1, messageEnd: 1, finalMessageStart: 1, lastAssistant: toolAssistant },
      ],
      messagingToolSourceReplyPayloads: [toolAuthoredReply],
      lastToolError: { toolName: "read", error: "Missing file" },
    });
    expect(payloads[0]?.text).toBe(toolAuthoredReply.text);
    expect(payloads.some((payload) => payload.isError)).toBe(true);
  });

  it("does not add an incomplete-turn warning when the tool-authored reply is the only output", () => {
    const payloads = buildPayloads({
      assistantTexts: [],
      messagingToolSourceReplyPayloads: [{ text: "Hecho.", sourceReplyFinal: true }],
      sourceReplyDeliveryMode: "automatic",
      runId: "run-1",
    });

    expect(payloads.map((payload) => payload.text)).toEqual(["Hecho."]);
    expect(payloads.some((payload) => payload.isError)).toBe(false);
  });
});
