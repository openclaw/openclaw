import { describe, expect, it } from "vitest";
import { buildMentionedCardContent, buildMentionedMessage, type MentionTarget } from "./mention.js";

const EMMA: MentionTarget = {
  openId: "ou_emma",
  name: "Emma",
  key: "@_user_1",
};

const ERIC: MentionTarget = {
  openId: "ou_eric",
  name: "Eric",
  key: "@_user_2",
};

describe("mention builders", () => {
  it("prefixes missing card mentions", () => {
    const text = buildMentionedCardContent([EMMA], "hello");
    expect(text).toContain('<at id="ou_emma"></at>');
    expect(text.endsWith("hello")).toBe(true);
  });

  it("does not duplicate card mention already present in message", () => {
    const text = buildMentionedCardContent([EMMA], '<at id="ou_emma"></at> hello');
    expect(text).toBe('<at id="ou_emma"></at> hello');
  });

  it("does not duplicate text mention already present in message", () => {
    const text = buildMentionedMessage([EMMA], '<at user_id="ou_emma">Emma</at> hello');
    expect(text).toBe('<at user_id="ou_emma">Emma</at> hello');
  });

  it("adds only missing targets when message already contains one mention", () => {
    const text = buildMentionedCardContent([EMMA, ERIC], '<at id="ou_emma"></at> continue');
    expect(text.startsWith('<at id="ou_eric"></at>')).toBe(true);
    expect(text).toContain('<at id="ou_emma"></at> continue');
  });

  it("treats id and user_id as the same target identity", () => {
    const text = buildMentionedCardContent([EMMA], '<at user_id="ou_emma"/> go');
    expect(text).toBe('<at user_id="ou_emma"/> go');
  });
});
