import { describe, expect, it } from "vitest";
import { buildMentionEntities, formatMentionText, parseMentions } from "./mentions.js";
describe("parseMentions", () => {
  it("parses single mention", () => {
    const result = parseMentions("Hello @[John Doe](28:a1b2c3-d4e5f6)!");
    expect(result.text).toBe("Hello <at>John Doe</at>!");
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toEqual({
      type: "mention",
      text: "<at>John Doe</at>",
      mentioned: {
        id: "28:a1b2c3-d4e5f6",
        name: "John Doe"
      }
    });
  });
  it("parses multiple mentions", () => {
    const result = parseMentions("Hey @[Alice](28:aaa) and @[Bob](28:bbb), can you review this?");
    expect(result.text).toBe("Hey <at>Alice</at> and <at>Bob</at>, can you review this?");
    expect(result.entities).toHaveLength(2);
    expect(result.entities[0]).toEqual({
      type: "mention",
      text: "<at>Alice</at>",
      mentioned: {
        id: "28:aaa",
        name: "Alice"
      }
    });
    expect(result.entities[1]).toEqual({
      type: "mention",
      text: "<at>Bob</at>",
      mentioned: {
        id: "28:bbb",
        name: "Bob"
      }
    });
  });
  it("handles text without mentions", () => {
    const result = parseMentions("Hello world!");
    expect(result.text).toBe("Hello world!");
    expect(result.entities).toHaveLength(0);
  });
  it("handles empty text", () => {
    const result = parseMentions("");
    expect(result.text).toBe("");
    expect(result.entities).toHaveLength(0);
  });
  it("handles mention with spaces in name", () => {
    const result = parseMentions("@[John Peter Smith](28:a1b2c3)");
    expect(result.text).toBe("<at>John Peter Smith</at>");
    expect(result.entities[0]?.mentioned.name).toBe("John Peter Smith");
  });
  it("trims whitespace from id and name", () => {
    const result = parseMentions("@[ John Doe ]( 28:a1b2c3 )");
    expect(result.entities[0]).toEqual({
      type: "mention",
      text: "<at>John Doe</at>",
      mentioned: {
        id: "28:a1b2c3",
        name: "John Doe"
      }
    });
  });
  it("handles Japanese characters in mention at start of message", () => {
    const input = "@[\u30BF\u30CA\u30AB \u30BF\u30ED\u30A6](a1b2c3d4-e5f6-7890-abcd-ef1234567890) \u30B9\u30AD\u30EB\u5316\u5B8C\u4E86\u3057\u307E\u3057\u305F\uFF01";
    const result = parseMentions(input);
    expect(result.text).toBe("<at>\u30BF\u30CA\u30AB \u30BF\u30ED\u30A6</at> \u30B9\u30AD\u30EB\u5316\u5B8C\u4E86\u3057\u307E\u3057\u305F\uFF01");
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toEqual({
      type: "mention",
      text: "<at>\u30BF\u30CA\u30AB \u30BF\u30ED\u30A6</at>",
      mentioned: {
        id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        name: "\u30BF\u30CA\u30AB \u30BF\u30ED\u30A6"
      }
    });
    const entityText = result.entities[0]?.text;
    expect(result.text).toContain(entityText);
    expect(result.text.indexOf(entityText)).toBe(0);
  });
  it("skips mention-like patterns with non-Teams IDs (e.g. in code blocks)", () => {
    const input = "@[\u30BF\u30CA\u30AB \u30BF\u30ED\u30A6](a1b2c3d4-e5f6-7890-abcd-ef1234567890) \u30B9\u30AD\u30EB\u5316\u5B8C\u4E86\u3057\u307E\u3057\u305F\uFF01\u{1F4CB}\n\n**\u4F5C\u6210\u3057\u305F\u30B9\u30AD\u30EB:** `teams-mention`\n- \u6A5F\u80FD: Teams\u3067\u306E\u30E1\u30F3\u30B7\u30E7\u30F3\u5F62\u5F0F `@[\u8868\u793A\u540D](\u30E6\u30FC\u30B6\u30FCID)`\n\n**\u8FFD\u52A0\u5BFE\u5FDC:**\n- \u30E6\u30FC\u30B6\u30FC\u306EID `a1b2c3d4-e5f6-7890-abcd-ef1234567890` \u3092\u767B\u9332\u6E08\u307F";
    const result = parseMentions(input);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]?.mentioned.id).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(result.entities[0]?.mentioned.name).toBe("\u30BF\u30CA\u30AB \u30BF\u30ED\u30A6");
    expect(result.text).toContain("`@[\u8868\u793A\u540D](\u30E6\u30FC\u30B6\u30FCID)`");
  });
  it("accepts Bot Framework IDs (28:xxx)", () => {
    const result = parseMentions("@[Bot](28:abc-123)");
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]?.mentioned.id).toBe("28:abc-123");
  });
  it("accepts Bot Framework IDs with non-hex payloads (29:xxx)", () => {
    const result = parseMentions("@[Bot](29:08q2j2o3jc09au90eucae)");
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]?.mentioned.id).toBe("29:08q2j2o3jc09au90eucae");
  });
  it("accepts org-scoped IDs with extra segments (8:orgid:...)", () => {
    const result = parseMentions("@[User](8:orgid:2d8c2d2c-1111-2222-3333-444444444444)");
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]?.mentioned.id).toBe("8:orgid:2d8c2d2c-1111-2222-3333-444444444444");
  });
  it("accepts AAD object IDs (UUIDs)", () => {
    const result = parseMentions("@[User](a1b2c3d4-e5f6-7890-abcd-ef1234567890)");
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]?.mentioned.id).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });
  it("rejects non-ID strings as mention targets", () => {
    const result = parseMentions("See @[docs](https://example.com) for details");
    expect(result.entities).toHaveLength(0);
    expect(result.text).toBe("See @[docs](https://example.com) for details");
  });
});
describe("buildMentionEntities", () => {
  it("builds entities from mention info", () => {
    const mentions = [
      { id: "28:aaa", name: "Alice" },
      { id: "28:bbb", name: "Bob" }
    ];
    const entities = buildMentionEntities(mentions);
    expect(entities).toHaveLength(2);
    expect(entities[0]).toEqual({
      type: "mention",
      text: "<at>Alice</at>",
      mentioned: {
        id: "28:aaa",
        name: "Alice"
      }
    });
    expect(entities[1]).toEqual({
      type: "mention",
      text: "<at>Bob</at>",
      mentioned: {
        id: "28:bbb",
        name: "Bob"
      }
    });
  });
  it("handles empty list", () => {
    const entities = buildMentionEntities([]);
    expect(entities).toHaveLength(0);
  });
});
describe("formatMentionText", () => {
  it("formats text with single mention", () => {
    const text = "Hello @John!";
    const mentions = [{ id: "28:xxx", name: "John" }];
    const result = formatMentionText(text, mentions);
    expect(result).toBe("Hello <at>John</at>!");
  });
  it("formats text with multiple mentions", () => {
    const text = "Hey @Alice and @Bob";
    const mentions = [
      { id: "28:aaa", name: "Alice" },
      { id: "28:bbb", name: "Bob" }
    ];
    const result = formatMentionText(text, mentions);
    expect(result).toBe("Hey <at>Alice</at> and <at>Bob</at>");
  });
  it("handles case-insensitive matching", () => {
    const text = "Hey @alice and @ALICE";
    const mentions = [{ id: "28:aaa", name: "Alice" }];
    const result = formatMentionText(text, mentions);
    expect(result).toBe("Hey <at>Alice</at> and <at>Alice</at>");
  });
  it("handles text without mentions", () => {
    const text = "Hello world";
    const mentions = [{ id: "28:xxx", name: "John" }];
    const result = formatMentionText(text, mentions);
    expect(result).toBe("Hello world");
  });
  it("escapes regex metacharacters in names", () => {
    const text = "Hey @John(Test) and @Alice.Smith";
    const mentions = [
      { id: "28:xxx", name: "John(Test)" },
      { id: "28:yyy", name: "Alice.Smith" }
    ];
    const result = formatMentionText(text, mentions);
    expect(result).toBe("Hey <at>John(Test)</at> and <at>Alice.Smith</at>");
  });
});
