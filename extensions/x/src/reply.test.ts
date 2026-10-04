import { describe, expect, it } from "vitest";
import { createXApiClient } from "./api.js";
import { sendXReply } from "./reply.js";
import { normalizeXReplyTarget } from "./target.js";

function createReplyFixture() {
  const sent: { text: string; reply: { in_reply_to_tweet_id: string } }[] = [];
  const api = createXApiClient({
    clientId: "client",
    clientSecret: "secret",
    refreshToken: "refresh",
    saveRefreshToken: async () => {},
    fetch: async (input, init) => {
      if (input.endsWith("/oauth2/token")) {
        return Response.json({ access_token: "access" });
      }
      if (typeof init?.body !== "string") {
        throw new Error("Expected a serialized reply request body");
      }
      sent.push(JSON.parse(init.body));
      return Response.json({ data: { id: String(100 + sent.length) } });
    },
  });
  return { api, sent };
}

describe("X public reply delivery", () => {
  it("honors URL and Unicode weights and reserves the signature for the last self-reply", async () => {
    const { api, sent } = createReplyFixture();
    const url = `https://example.com/sessions/${"a".repeat(300)}`;
    const result = await sendXReply({
      api,
      text: "界".repeat(145),
      replyToId: "x:90",
      signature: "— signed 🦞",
      visibleWorkSessions: [{ sessionKey: "work", url }],
    });
    expect(result.postIds).toEqual(["101", "102"]);
    expect(sent.map((post) => post.reply.in_reply_to_tweet_id)).toEqual(["90", "101"]);
    expect(sent[0]!.text).toBe("界".repeat(140));
    expect(sent[1]!.text).toBe(`${"界".repeat(5)}\n${url}\n— signed 🦞`);
  });

  it("reports already-posted ids when a later chunk fails without replaying the first", async () => {
    let posts = 0;
    const api = createXApiClient({
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh",
      saveRefreshToken: async () => {},
      fetch: async (input) => {
        if (input.endsWith("/oauth2/token")) {
          return Response.json({ access_token: "access" });
        }
        posts++;
        return posts === 1
          ? Response.json({ data: { id: "101" } })
          : new Response(null, { status: 403 });
      },
    });
    await expect(
      sendXReply({ api, text: "a".repeat(300), replyToId: "90", signature: "" }),
    ).rejects.toMatchObject({ postIds: ["101"], text: "a".repeat(280) });
    expect(posts).toBe(2);
  });

  it.each([
    { label: "HTTP URLs", value: `https://example.com/${"a".repeat(300)}`, weight: 23 },
    { label: "bare domains", value: "x.co", weight: 23 },
    {
      label: "long bare URLs with modern TLDs",
      value: `${"a".repeat(60)}.example.software/${"path".repeat(100)}`,
      weight: 23,
    },
    { label: "punctuation around URLs", value: "(https://example.com/a_(b)).", weight: 26 },
    { label: "email links", value: "mailto:maintainer@example.com", weight: 29 },
    { label: "bare email addresses", value: "maintainer@example.com", weight: 22 },
    { label: "FTP URLs", value: "ftp://example.com/file", weight: 22 },
    { label: "family emoji", value: "👨‍👩‍👧‍👦", weight: 2 },
    { label: "flag emoji", value: "🇦🇹", weight: 2 },
    { label: "combining characters", value: "e\u0301", normalized: "é", weight: 1 },
    { label: "nonstandard ZWJ sequences", value: "👨‍🐶", weight: 5 },
  ])(
    "splits $label only above the 280-character weight limit",
    async ({ value, normalized, weight }) => {
      const { api, sent } = createReplyFixture();
      const prefix = "a".repeat(279 - weight);
      const output = normalized ?? value;
      await sendXReply({ api, text: `${prefix} ${value}`, replyToId: "90", signature: "" });
      expect(sent.map((post) => post.text)).toEqual([`${prefix} ${output}`]);
      sent.length = 0;
      await sendXReply({ api, text: `${prefix}a ${value}`, replyToId: "90", signature: "" });
      expect(sent.map((post) => post.text)).toEqual([`${prefix}a`, output]);
    },
  );

  it("keeps an existing visible session URL once and adds the default signature", async () => {
    const { api, sent } = createReplyFixture();
    const url = "https://example.com/sessions/work";
    await sendXReply({
      api,
      text: `already ${url}`,
      replyToId: "90",
      visibleWorkSessions: [{ sessionKey: "work", url }],
    });
    expect(sent.map((post) => post.text)).toEqual([`already ${url}\n🤖 automated reply`]);
  });

  it.each([
    ["x:123", "123"],
    ["https://x.com/maintainer/status/123", "123"],
    ["https://x.com.evil.test/maintainer/status/123", undefined],
    ["https://x.com/maintainer", undefined],
  ] as const)("resolves only post targets: %s", (input, expected) => {
    expect(normalizeXReplyTarget(input)).toBe(expected);
  });
});
