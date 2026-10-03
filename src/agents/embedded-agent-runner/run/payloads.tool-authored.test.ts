// Tool-authored source replies become ordinary deliverable payloads: unlike
// internal-ui mirrors they have not reached the channel yet, so no suppression.
import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import { buildPayloads } from "./payloads.test-helpers.js";

describe("tool-authored source reply payloads", () => {
  it("delivers a tool-authored reply like assistant text with its media", () => {
    const payloads = buildPayloads({
      messagingToolSourceReplyPayloads: [
        {
          text: "Pedido SO1 creado. 18 botellas · total 459,85 €.",
          mediaUrls: ["/tmp/albaran.pdf"],
          toolAuthored: true,
          idempotencyKey: "run-1:tool-source-reply:tc-1",
          sourceReplyFinal: true,
        },
      ],
      sourceReplyDeliveryMode: "automatic",
      runId: "run-1",
      agentId: "vinalia",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      text: "Pedido SO1 creado. 18 botellas · total 459,85 €.",
      mediaUrls: ["/tmp/albaran.pdf"],
    });
    const metadata = getReplyPayloadMetadata(payloads[0] as object);
    expect(metadata?.deliverDespiteSourceReplySuppression).toBeUndefined();
    expect(metadata?.sourceReplyTranscriptMirror).toBeUndefined();
  });

  it("does not add an incomplete-turn warning when the tool-authored reply is the only output", () => {
    const payloads = buildPayloads({
      assistantTexts: [],
      messagingToolSourceReplyPayloads: [
        { text: "Hecho.", toolAuthored: true, sourceReplyFinal: true },
      ],
      sourceReplyDeliveryMode: "automatic",
      runId: "run-1",
    });

    expect(payloads.map((payload) => payload.text)).toEqual(["Hecho."]);
    expect(payloads.some((payload) => payload.isError)).toBe(false);
  });

  it("keeps internal-ui mirrors suppression-safe next to a tool-authored reply", () => {
    const payloads = buildPayloads({
      messagingToolSourceReplyPayloads: [
        { text: "mirrored webchat reply" },
        { text: "tool reply", toolAuthored: true, sourceReplyFinal: true },
      ],
      sourceReplyDeliveryMode: "automatic",
      runId: "run-1",
    });

    expect(payloads).toHaveLength(2);
    expect(
      getReplyPayloadMetadata(payloads[0] as object)?.deliverDespiteSourceReplySuppression,
    ).toBe(true);
    expect(
      getReplyPayloadMetadata(payloads[1] as object)?.deliverDespiteSourceReplySuppression,
    ).toBeUndefined();
  });
});
