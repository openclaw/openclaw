// Tool-authored source replies take the existing source-reply path: delivered to
// the source even when automatic replies are suppressed, and mirrored into the
// transcript by delivery because no tool owns the transcript row yet.
import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import { buildPayloads } from "./payloads.test-helpers.js";

const toolAuthoredReply = {
  text: "Pedido SO1 creado. 18 botellas · total 459,85 €.",
  mediaUrls: ["/tmp/albaran.pdf"],
  idempotencyKey: "run-1:tool-source-reply:tc-1",
  sourceReplyFinal: true,
};

describe("tool-authored source reply payloads", () => {
  it.each(["automatic", "message_tool_only"] as const)(
    "delivers the reply and asks delivery to write its transcript row in %s mode",
    (sourceReplyDeliveryMode) => {
      const payloads = buildPayloads({
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
