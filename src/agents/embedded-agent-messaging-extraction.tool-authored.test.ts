// Tool-authored source replies: a `canDeliverSourceReply` tool hands the host a
// finished reply in `details.sourceReply`; nothing has been sent yet.
import { describe, expect, it } from "vitest";
import {
  extractMessagingToolSourceReplyPayload,
  extractToolAuthoredSourceReplyPayload,
  resolveToolAuthoredSourceReplyFinal,
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
      toolAuthored: true,
    });
    // The same result is not an already-sent internal-ui mirror.
    expect(extractMessagingToolSourceReplyPayload(result)).toBeUndefined();
  });

  it.each([
    { label: "no sourceReply", details: { ok: true, final_answer: "text only" } },
    { label: "empty sourceReply", details: { sourceReply: {} } },
    { label: "whitespace text", details: { sourceReply: { text: "   " } } },
    { label: "non-record sourceReply", details: { sourceReply: "plain string" } },
  ])("ignores results with $label", ({ details }) => {
    expect(extractToolAuthoredSourceReplyPayload({ content: [], details })).toBeUndefined();
  });

  it("treats the reply as final unless the tool says otherwise", () => {
    expect(
      resolveToolAuthoredSourceReplyFinal({ details: { sourceReply: { text: "done" } } }),
    ).toBe(true);
    expect(
      resolveToolAuthoredSourceReplyFinal({
        details: { sourceReply: { text: "working…", final: false } },
      }),
    ).toBe(false);
    expect(resolveToolAuthoredSourceReplyFinal({ details: {} })).toBe(true);
  });
});
