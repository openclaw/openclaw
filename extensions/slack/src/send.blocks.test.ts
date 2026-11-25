import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as blocksFallback from "./blocks-fallback.js";
import { createSlackSendTestClient } from "./blocks.test-helpers.js";
import { SLACK_MESSAGE_TEXT_RECOMMENDED_LIMIT } from "./limits.js";
import {
  clearSlackThreadParticipationCache,
  hasSlackThreadParticipation,
} from "./sent-thread-cache.js";

const { sendMessageSlack, setSlackDefaultSendIdentity } = await import("./send.js");
const { slackPlugin } = await import("./channel.js");
const SLACK_TEST_CFG = { channels: { slack: { botToken: "xoxb-test" } } };
const SLACK_TEXT_LIMIT = 8000;
let client: ReturnType<typeof createSlackSendTestClient>;
beforeEach(() => {
  client = createSlackSendTestClient();
  clearSlackThreadParticipationCache();
  setSlackDefaultSendIdentity("default", undefined);
});
afterEach(() => setSlackDefaultSendIdentity("default", undefined));
function send(
  message: string,
  options: Partial<Parameters<typeof sendMessageSlack>[2]> = {},
  to = "channel:C123",
) {
  return sendMessageSlack(to, message, { cfg: SLACK_TEST_CFG, client, ...options });
}

function postedMessage(callIndex = 0) {
  return client.chat.postMessage.mock.calls[callIndex]![0];
}
const posts = () => client.chat.postMessage.mock.calls.map(([post]) => post);
const rawText = (text: string) => ({ type: "raw_text", text });
const table = (caption = "Pipeline", rows = [[rawText("Account")], [rawText("Acme")]]) => ({
  type: "data_table",
  caption,
  rows,
});

function slackDnsRequestError(): Error {
  return Object.assign(new Error("A request error occurred: getaddrinfo EAI_AGAIN slack.com"), {
    code: "slack_webapi_request_error",
    original: Object.assign(new Error("getaddrinfo EAI_AGAIN slack.com"), {
      code: "EAI_AGAIN",
      syscall: "getaddrinfo",
      hostname: "slack.com",
    }),
  });
}

describe("sendMessageSlack NO_REPLY literal", () => {
  // Producers prepare agent replies; message-tool text is literal channel content.
  it("delivers a literal NO_REPLY text like sibling channels", async () => {
    const result = await send("NO_REPLY");

    expect(client.chat.postMessage).toHaveBeenCalled();
    expect(result.messageId).toBe("171234.567");
  });
});

describe("sendMessageSlack chunking", () => {
  it.each([false, true])(
    "keeps emoji whole when plain text mode is %s",
    async (textIsSlackPlainText) => {
      const boundary = textIsSlackPlainText ? "  " : "";
      const prefix = boundary + "a".repeat(SLACK_TEXT_LIMIT - 2 - boundary.length);
      const family = "👨‍👩‍👧‍👦";

      await send(`${prefix}${family}Z${boundary}`, { textIsSlackPlainText });
      expect(posts().map((post) => post.text)).toEqual([prefix, `${family}Z${boundary}`]);
    },
  );

  it("keeps Slack mrkdwn code spans closed around protected tokens when chunking", async () => {
    const message = `\`${"a".repeat(SLACK_TEXT_LIMIT - 5)}<@U123>${"b".repeat(20)}\``;

    await send(message, { textIsSlackMrkdwn: true });
    const postedTexts = posts().map((post) => post.text);

    expect(postedTexts.length).toBeGreaterThan(1);
    const mentionChunk = postedTexts.find((text) => text?.includes("<@U123>"));
    expect(mentionChunk).toBeDefined();
    expect(mentionChunk?.startsWith("`")).toBe(true);
    expect(mentionChunk?.endsWith("`")).toBe(true);
    expect(postedTexts.every((text) => (text?.match(/`/gu) ?? []).length % 2 === 0)).toBe(true);
  });

  it("preserves the first canonical response thread across chunked sends", async () => {
    client.chat.postMessage
      .mockResolvedValueOnce({
        ts: "1781932190.115869",
        channel: "C123",
        message: {
          ts: "1781932190.115869",
          thread_ts: "1781803536.235489",
        },
      })
      .mockResolvedValueOnce({ ts: "1781932191.000000", channel: "C123" });
    const result = await send("a".repeat(8500), {
      threadTs: "1781932168.648159",
      replyBroadcast: true,
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(posts()).toMatchObject([
      { thread_ts: "1781932168.648159", reply_broadcast: true },
      { thread_ts: "1781932168.648159" },
    ]);
    expect(postedMessage(1)).not.toHaveProperty("reply_broadcast");
    expect(result).toMatchObject({
      threadTs: "1781803536.235489",
      receipt: { threadId: "1781803536.235489" },
    });
    expect(hasSlackThreadParticipation("default", "C123", "1781803536.235489")).toBe(true);
    expect(hasSlackThreadParticipation("default", "C123", "1781932168.648159")).toBe(false);
  });
});

describe("sendMessageSlack blocks", () => {
  it.each([false, true])(
    "uses the ordered accessibility text without rendering a discarded fallback (native=%s)",
    async (native) => {
      const fallback = vi.spyOn(blocksFallback, "buildSlackCompleteBlocksFallbackText");
      const blocks = native
        ? [table()]
        : [{ type: "section", text: { type: "plain_text", text: "Account: Acme" } }];
      try {
        await send("Overview", {
          blocks,
          ...(native ? {} : { authoredTextPlacement: "outside-blocks" as const }),
        });

        expect(client.chat.postMessage).toHaveBeenCalledOnce();
        expect(postedMessage()).toEqual({
          channel: "C123",
          text: native
            ? "Overview\n\nPipeline (table)\nAccount\nAcme"
            : "Overview\n\nAccount: Acme",
          blocks,
          mrkdwn: false,
          unfurl_links: false,
        });
        expect(postedMessage().blocks).toBe(blocks);
        expect(fallback).not.toHaveBeenCalled();
      } finally {
        fallback.mockRestore();
      }
    },
  );

  it("uses resolved-limit blockless chunks for oversized native data with no survivors", async () => {
    const caption = "c".repeat(41_000);
    await send("", { blocks: [table(caption)] as never });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(11);
    expect(posts().every((post) => post.blocks === undefined)).toBe(true);
    expect(posts().every((post) => post.mrkdwn === false)).toBe(true);
    expect(
      posts().every((post) => String(post.text).length <= SLACK_MESSAGE_TEXT_RECOMMENDED_LIMIT),
    ).toBe(true);
    expect(
      posts()
        .map((post) => post.text)
        .join(""),
    ).toBe(`${caption} (table)\nAccount\nAcme`);
  });

  it("splits non-native blocks before their accessibility text exceeds the send limit", async () => {
    const blocks = Array.from({ length: 20 }, (_entry, index) => ({
      type: "section",
      text: { type: "plain_text", text: `${String(index)}-${"x".repeat(2_990)}` },
    }));

    await send("", {
      blocks,
      authoredTextPlacement: "none",
    });

    expect(client.chat.postMessage).toHaveBeenCalledTimes(20);
    expect(
      posts().every((post) => String(post.text).length <= SLACK_MESSAGE_TEXT_RECOMMENDED_LIMIT),
    ).toBe(true);
    expect(posts().every((post) => post.mrkdwn === false)).toBe(true);
    expect(posts().flatMap((post) => post.blocks as unknown[])).toEqual(blocks);
  });

  it("does not fall back from non-invalid_blocks native table errors", async () => {
    client.chat.postMessage.mockRejectedValueOnce(
      Object.assign(new Error("An API error occurred: ratelimited"), {
        data: { error: "ratelimited" },
      }),
    );

    await expect(
      send("Overview", {
        blocks: [table()] as never,
      }),
    ).rejects.toThrow("ratelimited");
    expect(client.chat.postMessage).toHaveBeenCalledOnce();
  });

  it("posts user-target block messages directly without conversations.open", async () => {
    client.conversations.open.mockRejectedValueOnce(new Error("missing_scope"));
    client.chat.postMessage.mockResolvedValueOnce({ ts: "171234.567", channel: "D123" });

    const result = await send(
      "",
      {
        blocks: [{ type: "divider" }],
        replyBroadcast: true,
      },
      "user:U123",
    );

    expect(postedMessage()).not.toHaveProperty("reply_broadcast");
    expect(client.conversations.open).not.toHaveBeenCalled();
    expect(postedMessage()).toMatchObject({ channel: "U123", text: "Shared a Block Kit message" });
    expect(result).toMatchObject({
      messageId: "171234.567",
      channelId: "D123",
    });
    expect(result.receipt.platformMessageIds).toEqual(["171234.567"]);
    expect(result.receipt.parts[0]?.raw).toMatchObject({ channelId: "D123" });
  });

  it.each(["postMessage", "conversations.open"])(
    "retries DNS errors from %s",
    async (operation) => {
      const dm = operation === "conversations.open";
      const request = dm ? client.conversations.open : client.chat.postMessage;
      request
        .mockRejectedValueOnce(slackDnsRequestError())
        .mockResolvedValueOnce(dm ? { channel: { id: "D123" } } : { ts: "171234.999" });
      const result = await send(
        "hello",
        dm ? { threadTs: "171234.100" } : {},
        dm ? "user:U123" : "channel:C123",
      );
      expect(request).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({
        messageId: dm ? "171234.567" : "171234.999",
        channelId: dm ? "D123" : "C123",
      });
      if (dm) {
        expect(postedMessage()).toMatchObject({ channel: "D123", thread_ts: "171234.100" });
        expect(result.receipt.threadId).toBe("171234.100");
      } else {
        expect(result.receipt.parts[0]).toMatchObject({
          platformMessageId: "171234.999",
          kind: "text",
        });
      }
    },
  );

  it("caps long fallback text while preserving blocks", async () => {
    const longContextText = "a".repeat(3000);
    const blocks = [
      {
        type: "context",
        elements: Array.from({ length: 3 }, () => ({ type: "mrkdwn", text: longContextText })),
      },
    ];

    await send("", { blocks });

    const post = postedMessage();
    expect(String(post.text).endsWith("…")).toBe(true);
    expect(post.blocks).toBe(blocks);
    expect(post.text).toHaveLength(SLACK_TEXT_LIMIT);
  });

  it.each<[Partial<Parameters<typeof sendMessageSlack>[2]>, RegExp]>([
    [{ blocks: [{ type: "divider" }] }, /does not support blocks with mediaUrl/i],
    [
      { threadTs: "171234.100", replyBroadcast: true },
      /replyBroadcast is only supported for text or block thread replies/i,
    ],
  ])("rejects media with incompatible options: %j", async (options, error) => {
    await expect(
      send("hi", { mediaUrl: "https://example.com/image.png", ...options }),
    ).rejects.toThrow(error);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });
});

function slackPlatformError(code: string): Error {
  return Object.assign(new Error(`An API error occurred: ${code}`), {
    code: "slack_webapi_platform_error",
    data: { ok: false, error: code },
  });
}

describe("sendMessageSlack permanent provider rejections", () => {
  it("marks account_inactive from durable DM resolution as a permanent non-dispatch", async () => {
    const rejection = slackPlatformError("account_inactive");
    client.conversations.open.mockRejectedValueOnce(rejection);

    const caught = await send(
      "hello",
      { deliveryQueueId: "queue-dm-account-inactive" },
      "user:U123",
    ).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(caught).toMatchObject({ retryable: false, cause: rejection });
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("retains earlier Slack delivery evidence when a later chunk is permanently rejected", async () => {
    const rejection = slackPlatformError("messages_tab_disabled");
    client.chat.postMessage
      .mockResolvedValueOnce({ ts: "171234.100", channel: "C123" })
      .mockRejectedValueOnce(rejection);
    const delivered: string[] = [];

    const caught = await send("a".repeat(SLACK_TEXT_LIMIT + 1), {
      onDeliveryResult: (result) => {
        delivered.push(result.messageId);
      },
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(caught).toMatchObject({ retryable: false, cause: rejection });
    expect(delivered).toEqual(["171234.100"]);
    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
  });

  it("does not classify a persistence callback failure as a Slack API rejection", async () => {
    const callbackError = slackPlatformError("messages_tab_disabled");
    client.chat.postMessage.mockResolvedValueOnce({ ts: "171234.100", channel: "C123" });

    const caught = await send("hello", {
      blocks: [{ type: "divider" }],
      onDeliveryResult: () => {
        throw callbackError;
      },
    }).catch((error: unknown) => error);

    expect(caught).toBe(callbackError);
    expect(caught).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
  });
});

function missingScope(details: {
  needed?: string;
  response_metadata?: { scopes?: string[]; acceptedScopes?: string[] };
}) {
  return Object.assign(new Error("An API error occurred: missing_scope"), {
    data: { error: "missing_scope", ...details },
  });
}
const invalidIdentity = () =>
  Object.assign(new Error("invalid_arguments"), {
    data: { error: "invalid_arguments" },
  });

describe("sendMessageSlack identity and target fallback", () => {
  it("uses the relay identity on a folded session target", async () => {
    setSlackDefaultSendIdentity("default", {
      username: "Relay",
      iconUrl: "https://example.com/bot.png",
    });
    const target = slackPlugin.messaging?.resolveSessionTarget?.({
      kind: "channel",
      id: "c08gqh53ejm",
    });
    expect(target).toBe("channel:c08gqh53ejm");
    await send("hello", {}, target);
    expect(postedMessage(0)).toEqual({
      channel: "C08GQH53EJM",
      text: "hello",
      username: "Relay",
      icon_url: "https://example.com/bot.png",
      unfurl_links: false,
    });
  });

  it("drops identity for the customize scope in response metadata", async () => {
    client.chat.postMessage.mockRejectedValueOnce(
      missingScope({
        response_metadata: {
          scopes: ["chat:write"],
          acceptedScopes: ["", " chat:write.customize "],
        },
      }),
    );
    const result = await send("hello", { identity: { iconEmoji: ":robot_face:" } });
    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(postedMessage(0)).toMatchObject({ icon_emoji: ":robot_face:" });
    expect(postedMessage(1)).toEqual({ channel: "C123", text: "hello", unfurl_links: false });
    expect(result.messageId).toBe("171234.567");
  });

  it("drops the full identity only after the username-only retry fails", async () => {
    client.chat.postMessage
      .mockRejectedValueOnce(invalidIdentity())
      .mockRejectedValueOnce(invalidIdentity());
    await send("hello", { identity: { username: "Pulse", iconEmoji: "📟" } });
    expect(client.chat.postMessage).toHaveBeenCalledTimes(3);
    expect(postedMessage(1)).toMatchObject({ username: "Pulse" });
    expect(postedMessage(1)).not.toHaveProperty("icon_emoji");
    expect(postedMessage(2)).toEqual({ channel: "C123", text: "hello", unfurl_links: false });
  });

  it("reuses the downgraded explicit identity for later chunks", async () => {
    setSlackDefaultSendIdentity("default", { username: "Relay" });
    client.chat.postMessage.mockRejectedValueOnce(invalidIdentity());
    await send("alpha beta", { identity: { username: "Pulse", iconEmoji: "📟" }, textLimit: 5 });
    expect(client.chat.postMessage).toHaveBeenCalledTimes(3);
    expect(postedMessage(0)).toMatchObject({ username: "Pulse", icon_emoji: "📟" });
    for (const index of [1, 2]) {
      expect(postedMessage(index)).toMatchObject({ username: "Pulse" });
      expect(postedMessage(index)).not.toHaveProperty("icon_emoji");
    }
  });

  it("preserves other missing-scope details without retrying identity", async () => {
    client.chat.postMessage.mockRejectedValueOnce(
      missingScope({
        needed: "im:write",
        response_metadata: {
          scopes: [" chat:write ", "", " users:read "],
          acceptedScopes: [" im:write ", " mpim:write "],
        },
      }),
    );
    await expect(send("hello", { identity: { username: "Bot" } })).rejects.toThrow(
      "An API error occurred: missing_scope (needed: im:write; granted: chat:write, users:read; accepted: im:write, mpim:write)",
    );
    expect(client.chat.postMessage).toHaveBeenCalledOnce();
  });
});
