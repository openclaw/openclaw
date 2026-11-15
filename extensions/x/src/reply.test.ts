import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendXDelivery } from "./send.js";
import { normalizeXReplyTarget } from "./target.js";
import { createXTestApi as createXApiClient } from "./test-support/api-client.js";
import { client, config, fixture, post as makePost } from "./test-support/monitor-fixture.js";

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  getXApi: vi.fn(),
}));
afterEach(() => clearRuntimeConfigSnapshot());

function createReplyFixture(signature = "", failSecondPost = false) {
  const cfg = { ...config, channels: { x: { ...config.channels?.x, replySignature: signature } } };
  fixture({ posts: [], cfg });
  const sent: { text: string; reply: { in_reply_to_tweet_id: string } }[] = [];
  const api = createXApiClient({
    fetch: async (input, init) => {
      if (input.endsWith("/oauth2/token")) {
        return Response.json({ access_token: "access" });
      }
      if (typeof init?.body !== "string") {
        throw new Error("Expected a serialized reply request body");
      }
      sent.push(JSON.parse(init.body));
      return failSecondPost && sent.length === 2
        ? new Response(null, { status: 403 })
        : Response.json({ data: { id: String(100 + sent.length) } });
    },
  });
  client.getXApi.mockResolvedValue(api);
  const send = (
    text: string,
    visibleWorkSessions?: Parameters<typeof sendXDelivery>[0]["visibleWorkSessions"],
  ) => sendXDelivery({ cfg, text, to: "x:90", mention: makePost("90", "10"), visibleWorkSessions });
  return { api, sent, send };
}

describe("X public reply delivery", () => {
  it("honors URL and Unicode weights and reserves the signature for the last self-reply", async () => {
    const { api, sent, send } = createReplyFixture("— signed 🦞");
    const url = `https://example.com/sessions/${"a".repeat(300)}`;
    const result = await send("界".repeat(145), [{ sessionKey: "work", url, publicRead: true }]);
    expect(result.receipt.platformMessageIds).toEqual(["101", "102"]);
    expect(sent.map((post) => post.reply.in_reply_to_tweet_id)).toEqual(["90", "101"]);
    expect(sent[0]!.text).toBe("界".repeat(140));
    expect(sent[1]!.text).toBe(`${"界".repeat(5)}\n${url}\n— signed 🦞`);
    expect(await api.spend.status()).toMatchObject({ dayUsd: 0.22, cycleUsd: 0.22 });
  });

  it("reports already-posted ids when a later chunk fails without replaying the first", async () => {
    const { sent, send } = createReplyFixture("", true);
    await expect(send("a".repeat(300))).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      message:
        "X reply chain failed after one or more posts were sent | X API /2/tweets failed (HTTP 403) | OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED",
      deliveryResult: {
        visibleReplySent: true,
        receipt: { platformMessageIds: ["101"] },
        content: "a".repeat(280),
      },
    });
    expect(sent).toHaveLength(2);
  });

  it.each([
    { label: "punctuation around URLs", value: "(https://example.com/a_(b)).", weight: 26 },
  ])("splits $label only above the 280-character weight limit", async ({ value, weight }) => {
    const { sent, send } = createReplyFixture();
    const prefix = "a".repeat(279 - weight);
    const output = value;
    await send(`${prefix} ${value}`);
    expect(sent.map((post) => post.text)).toEqual([`${prefix} ${output}`]);
    sent.length = 0;
    await send(`${prefix}a ${value}`);
    expect(sent.map((post) => post.text)).toEqual([`${prefix}a`, output]);
  });

  it.each([
    ["https://x.com/maintainer/status/123", "123"],
    ["https://x.com.evil.test/maintainer/status/123", undefined],
  ] as const)("resolves only post targets: %s", (input, expected) => {
    expect(normalizeXReplyTarget(input)).toBe(expected);
  });
});
