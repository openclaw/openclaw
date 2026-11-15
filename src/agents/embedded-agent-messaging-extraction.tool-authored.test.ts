// Tool-authored source replies: a `canDeliverSourceReply` tool hands the host a
// finished reply in `details.sourceReply`; nothing has been sent yet.
import { describe, expect, it } from "vitest";
import {
  extractMessagingToolSourceReplyPayload,
  extractToolAuthoredSourceReplyPayload,
} from "./embedded-agent-messaging-extraction.js";

describe("tool-authored source replies", () => {
  it("reads text, media and attachments without requiring the internal-ui sink", () => {
    const result = {
      content: [{ type: "text", text: '{"ok":true}' }],
      details: {
        ok: true,
        sourceReply: {
          text: "Pedido SO1 creado. 18 botellas · total 459,85 €.",
          mediaUrls: ["/tmp/albaran.pdf"],
          attachments: [{ path: "/tmp/albaran.pdf", mimeType: "application/pdf" }],
        },
      },
    };

    expect(extractToolAuthoredSourceReplyPayload(result)).toEqual({
      text: "Pedido SO1 creado. 18 botellas · total 459,85 €.",
      mediaUrls: ["/tmp/albaran.pdf"],
      attachments: [{ path: "/tmp/albaran.pdf", mimeType: "application/pdf" }],
    });
    // The same result is not an already-sent internal-ui mirror.
    expect(extractMessagingToolSourceReplyPayload(result)).toBeUndefined();
  });

  it("admits a media-only reply", () => {
    expect(
      extractToolAuthoredSourceReplyPayload({
        details: { sourceReply: { mediaUrls: ["/tmp/flyer.png"] } },
      }),
    ).toEqual({ mediaUrls: ["/tmp/flyer.png"] });
  });

  it.each([
    { message: "Internal diagnostic" },
    { mediaUrl: "/tmp/internal-report.pdf" },
    { mediaUrls: ["/tmp/internal-report.pdf"] },
  ])("does not restore withdrawn reply content from top-level details: %j", (details) => {
    expect(
      extractToolAuthoredSourceReplyPayload({ details: { ...details, sourceReply: {} } }),
    ).toBeUndefined();
  });

  it("keeps a media-only reply separate from unrelated result and delivery metadata", () => {
    expect(
      extractToolAuthoredSourceReplyPayload({
        details: {
          message: "Internal diagnostic",
          mediaUrl: "/tmp/internal-report.pdf",
          audioAsVoice: true,
          idempotencyKey: "internal-operation",
          sourceReplyTranscriptOwner: true,
          sourceReply: { mediaUrls: ["/tmp/public-report.pdf"] },
        },
      }),
    ).toEqual({ mediaUrls: ["/tmp/public-report.pdf"] });
  });

  it("preserves top-level fallbacks for already-sent internal message mirrors", () => {
    expect(
      extractMessagingToolSourceReplyPayload({
        details: {
          sourceReplySink: "internal-ui",
          deliveryStatus: "sent",
          message: "Delivered report",
          mediaUrl: "/tmp/report.pdf",
          audioAsVoice: true,
          idempotencyKey: "delivered-message",
          sourceReplyTranscriptOwner: true,
          sourceReply: {},
        },
      }),
    ).toEqual({
      text: "Delivered report",
      mediaUrl: "/tmp/report.pdf",
      audioAsVoice: true,
      idempotencyKey: "delivered-message",
      transcriptOwner: true,
    });
  });

  it.each([
    { label: "no sourceReply", details: { ok: true, final_answer: "text only" } },
    { label: "empty sourceReply", details: { sourceReply: {} } },
    { label: "whitespace text", details: { sourceReply: { text: "   " } } },
    { label: "non-record sourceReply", details: { sourceReply: "plain string" } },
    // Delivery only admits text or media, so attachments alone cannot end a turn.
    {
      label: "attachment-only sourceReply",
      details: { sourceReply: { attachments: [{ path: "/tmp/albaran.pdf" }] } },
    },
    // Delivery drops blank media, so blank entries alone cannot end a turn.
    { label: "blank mediaUrls", details: { sourceReply: { mediaUrls: ["", "   "] } } },
    { label: "blank mediaUrl", details: { sourceReply: { mediaUrl: "  " } } },
    {
      label: "blank mediaUrls shadowing a mediaUrl",
      details: { sourceReply: { mediaUrls: [" "], mediaUrl: "/tmp/flyer.png" } },
    },
    // A non-final reply is not deliverable; the model keeps the turn.
    { label: "final: false", details: { sourceReply: { text: "Comprobando…", final: false } } },
  ])("ignores results with $label", ({ details }) => {
    expect(extractToolAuthoredSourceReplyPayload({ content: [], details })).toBeUndefined();
  });
});
