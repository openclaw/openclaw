import { describe, expect, it } from "vitest";
import { normalizeMentionTagsForCard, normalizeMentionTagsForText } from "./mention.js";

describe("mention tag normalization", () => {
  it("converts text-style mentions to card-style mentions", () => {
    const input = `<at user_id="ou_123">Emma</at> hello <at user_id='all'>Everyone</at>`;
    const output = normalizeMentionTagsForCard(input);
    expect(output).toBe("<at id=ou_123></at> hello <at id=all></at>");
  });

  it("converts card-style mentions to text-style mentions with display names", () => {
    const input = "<at id=ou_123></at> hi";
    const output = normalizeMentionTagsForText(input, { ou_123: "Emma" });
    expect(output).toBe('<at user_id="ou_123">Emma</at> hi');
  });

  it("falls back to id when card mention has no mapped display name", () => {
    const input = "<at id=ou_999></at>";
    const output = normalizeMentionTagsForText(input);
    expect(output).toBe('<at user_id="ou_999">ou_999</at>');
  });

  it("keeps non-mention text unchanged", () => {
    const input = "plain text";
    expect(normalizeMentionTagsForCard(input)).toBe(input);
    expect(normalizeMentionTagsForText(input)).toBe(input);
  });
});
