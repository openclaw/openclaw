import { describe, expect, it } from "vitest";
import { createXApiClient } from "./api.js";
import { appendVisibleWorkSession, chunkXReply, sendXReply, xWeightedLength } from "./reply.js";
import { normalizeXReplyTarget } from "./target.js";

describe("X public reply delivery", () => {
  it("honors URL and Unicode weights and reserves the signature for the last self-reply", async () => {
    const sent: { text: string; reply: { in_reply_to_tweet_id: string } }[] = [];
    const url = `https://example.com/sessions/${"a".repeat(300)}`;
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
        const body = JSON.parse(init.body);
        sent.push(body);
        return Response.json({ data: { id: String(100 + sent.length) } });
      },
    });
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
    expect(xWeightedLength(sent[0]!.text)).toBe(280);
    expect(xWeightedLength(sent[1]!.text)).toBe(46);
    expect(xWeightedLength("👨‍👩‍👧‍👦 🇦🇹 e\u0301")).toBe(7);
    expect(xWeightedLength("👨‍🐶")).toBe(5);
    expect(chunkXReply(`${"a".repeat(256)} ${url}`, "")).toHaveLength(1);
    expect(chunkXReply(`${"a".repeat(257)} ${url}`, "")).toHaveLength(2);
    expect(appendVisibleWorkSession(`already ${url}`, [{ sessionKey: "work", url }])).toBe(
      `already ${url}`,
    );
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

  it("counts bare domains as links and preserves long URLs while splitting near the limit", () => {
    const longUrl = `${"a".repeat(60)}.example.software/${"path".repeat(100)}`;
    expect(chunkXReply(`${"a".repeat(256)} x.co`, "")).toEqual([`${"a".repeat(256)} x.co`]);
    expect(chunkXReply(`${"a".repeat(257)} x.co`, "")).toEqual(["a".repeat(257), "x.co"]);
    expect(chunkXReply(`${"a".repeat(256)} ${longUrl}`, "")).toEqual([
      `${"a".repeat(256)} ${longUrl}`,
    ]);
    expect(xWeightedLength("example.software")).toBe(23);
    expect(xWeightedLength("(https://example.com/a_(b)).")).toBe(26);
    expect(xWeightedLength("mailto:maintainer@example.com")).toBe(29);
    expect(xWeightedLength("maintainer@example.com")).toBe(22);
    expect(xWeightedLength("ftp://example.com/file")).toBe(22);
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
