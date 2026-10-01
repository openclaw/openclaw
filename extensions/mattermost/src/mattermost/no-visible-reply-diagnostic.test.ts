// Mattermost tests cover no visible reply diagnostic plugin behavior.
import { describe, expect, it } from "vitest";
import {
  evaluateMattermostNoVisibleReply,
  formatMattermostNoVisibleReplyLog,
} from "./no-visible-reply-diagnostic.js";

describe("evaluateMattermostNoVisibleReply", () => {
  it("flags substantive text payloads that delivered empty (regression: #80501)", () => {
    const violation = evaluateMattermostNoVisibleReply({
      outcome: "empty",
      payload: { text: "Here is the result of the work I did..." },
    });
    expect(violation).toStrictEqual({
      reason: "no-visible-reply-after-final-delivery",
      outcome: "empty",
      finalTextLength: "Here is the result of the work I did...".length,
      mediaUrlCount: 0,
    });
  });

  it("flags payloads with media URLs that delivered empty (regression: #80501)", () => {
    const violation = evaluateMattermostNoVisibleReply({
      outcome: "empty",
      payload: { mediaUrl: "https://example.org/a.png" },
    });
    expect(violation).toStrictEqual({
      reason: "no-visible-reply-after-final-delivery",
      outcome: "empty",
      finalTextLength: 0,
      mediaUrlCount: 1,
    });
  });

  it("follows the SDK legacy media fallback when counting media URLs", () => {
    const violation = evaluateMattermostNoVisibleReply({
      outcome: "empty",
      payload: {
        mediaUrl: "https://example.org/a.png",
        mediaUrls: ["https://example.org/b.png", "https://example.org/c.png"],
      },
    });
    expect(violation?.mediaUrlCount).toBe(2);
  });

  it("does not flag empty outcome when the payload was nominally empty (no text or media at all)", () => {
    expect(
      evaluateMattermostNoVisibleReply({
        outcome: "empty",
        payload: {},
      }),
    ).toBeNull();
    expect(
      evaluateMattermostNoVisibleReply({
        outcome: "empty",
        payload: { text: "" },
      }),
    ).toBeNull();
    expect(
      evaluateMattermostNoVisibleReply({
        outcome: "empty",
        payload: { text: "   \n\t  " },
      }),
    ).toBeNull();
  });

  it("trims whitespace when measuring finalTextLength", () => {
    const violation = evaluateMattermostNoVisibleReply({
      outcome: "empty",
      payload: { text: "   hello   " },
    });
    expect(violation?.finalTextLength).toBe("hello".length);
  });
});

describe("formatMattermostNoVisibleReplyLog", () => {
  it("falls back to unknown when agentId is undefined", () => {
    const line = formatMattermostNoVisibleReplyLog({
      violation: {
        reason: "no-visible-reply-after-final-delivery",
        outcome: "empty",
        finalTextLength: 1,
        mediaUrlCount: 0,
      },
      to: "channel:x",
      accountId: "y",
      agentId: undefined,
    });
    expect(line).toContain("agentId=unknown");
  });
});
