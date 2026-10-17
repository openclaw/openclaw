import { describe, expect, it } from "vitest";
import { createXApiClient } from "./api.js";
import { sendXReply } from "./reply.js";
import { normalizeXReplyTarget } from "./target.js";
import { createXTestSpend } from "./test-support/spend.js";

function createReplyFixture() {
  const sent: { text: string; reply: { in_reply_to_tweet_id: string } }[] = [];
  const api = createXApiClient({
    spend: createXTestSpend(),
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
      visibleWorkSessions: [{ sessionKey: "work", url, publicRead: true }],
    });
    expect(result.postIds).toEqual(["101", "102"]);
    expect(sent.map((post) => post.reply.in_reply_to_tweet_id)).toEqual(["90", "101"]);
    expect(sent[0]!.text).toBe("界".repeat(140));
    expect(sent[1]!.text).toBe(`${"界".repeat(5)}\n${url}\n— signed 🦞`);
    expect(await api.spend.status()).toMatchObject({ dayUsd: 0.22, cycleUsd: 0.22 });
  });

  it("reports already-posted ids when a later chunk fails without replaying the first", async () => {
    let posts = 0;
    const api = createXApiClient({
      spend: createXTestSpend(),
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
    { label: "punctuation around URLs", value: "(https://example.com/a_(b)).", weight: 26 },
  ])("splits $label only above the 280-character weight limit", async ({ value, weight }) => {
    const { api, sent } = createReplyFixture();
    const prefix = "a".repeat(279 - weight);
    const output = value;
    await sendXReply({ api, text: `${prefix} ${value}`, replyToId: "90", signature: "" });
    expect(sent.map((post) => post.text)).toEqual([`${prefix} ${output}`]);
    sent.length = 0;
    await sendXReply({ api, text: `${prefix}a ${value}`, replyToId: "90", signature: "" });
    expect(sent.map((post) => post.text)).toEqual([`${prefix}a`, output]);
  });

  it.each([
    ["https://x.com/maintainer/status/123", "123"],
    ["https://x.com.evil.test/maintainer/status/123", undefined],
  ] as const)("resolves only post targets: %s", (input, expected) => {
    expect(normalizeXReplyTarget(input)).toBe(expected);
  });
});
