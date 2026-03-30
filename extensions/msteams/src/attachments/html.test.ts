import { describe, expect, it } from "vitest";
import {
  buildMSTeamsAttachmentPlaceholder,
  extractTeamsEmojiText,
} from "./html.js";
import type { MSTeamsAttachmentLike } from "./types.js";

function htmlAttachment(html: string): MSTeamsAttachmentLike {
  return {
    contentType: "text/html",
    content: html,
  };
}

describe("extractTeamsEmojiText", () => {
  it("extracts emoji from Teams CDN img tags", () => {
    const result = extractTeamsEmojiText([
      htmlAttachment(
        '<img src="https://statics.teams.cdn.office.net/evergreen-assets/personal-expressions/v2/assets/emoticons/wave/default/30_f.png" alt="👋">',
      ),
    ]);
    expect(result).toBe("👋");
  });

  it("extracts multiple emoji from a single attachment", () => {
    const result = extractTeamsEmojiText([
      htmlAttachment(
        '<img src="https://statics.teams.cdn.office.net/emoji/v1/thumbsup.png" alt="👍">' +
          '<img src="https://statics.teams.cdn.office.net/emoji/v1/fire.png" alt="🔥">',
      ),
    ]);
    expect(result).toBe("👍🔥");
  });

  it("returns null for non-emoji images", () => {
    const result = extractTeamsEmojiText([
      htmlAttachment(
        '<img src="https://graph.microsoft.com/v1.0/users/photo" alt="profile photo">',
      ),
    ]);
    expect(result).toBeNull();
  });

  it("returns null for mixed emoji and non-emoji", () => {
    const result = extractTeamsEmojiText([
      htmlAttachment(
        '<img src="https://statics.teams.cdn.office.net/emoji/v1/wave.png" alt="👋">' +
          '<img src="https://example.com/screenshot.png" alt="screenshot">',
      ),
    ]);
    expect(result).toBeNull();
  });

  it("returns null for empty attachments", () => {
    expect(extractTeamsEmojiText([])).toBeNull();
    expect(extractTeamsEmojiText(undefined)).toBeNull();
  });

  it("returns null when CDN hostname appears in query param but host is different", () => {
    const result = extractTeamsEmojiText([
      htmlAttachment(
        '<img src="https://evil.example.com/redirect?ref=statics.teams.cdn.office.net/emoji.png" alt="👋">',
      ),
    ]);
    expect(result).toBeNull();
  });

  it("returns null when non-HTML attachments are present alongside emoji", () => {
    const result = extractTeamsEmojiText([
      htmlAttachment(
        '<img src="https://statics.teams.cdn.office.net/emoji/v1/wave.png" alt="👋">',
      ),
      // Non-HTML attachment (e.g. a real image file)
      { contentType: "image/jpeg", content: null } as unknown as MSTeamsAttachmentLike,
    ]);
    expect(result).toBeNull();
  });

  it("returns null for img tag with alt but no src", () => {
    const result = extractTeamsEmojiText([
      htmlAttachment('<img alt="sneaky text">'),
    ]);
    expect(result).toBeNull();
  });

  it("returns null for img tag with non-CDN src", () => {
    const result = extractTeamsEmojiText([
      htmlAttachment(
        '<img src="https://example.com/image.png" alt="not emoji">',
      ),
    ]);
    expect(result).toBeNull();
  });
});

describe("buildMSTeamsAttachmentPlaceholder with emoji", () => {
  it("returns emoji text instead of <media:image> for emoji attachments", () => {
    const result = buildMSTeamsAttachmentPlaceholder([
      htmlAttachment(
        '<img src="https://statics.teams.cdn.office.net/evergreen-assets/personal-expressions/v2/assets/emoticons/wave/default/30_f.png" alt="👋">',
      ),
    ]);
    expect(result).toBe("👋");
    expect(result).not.toContain("media:image");
  });
});
