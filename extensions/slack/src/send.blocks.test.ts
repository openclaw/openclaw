import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSendTestClient } from "./blocks.test-helpers.js";
import { SLACK_MESSAGE_TEXT_RECOMMENDED_LIMIT } from "./limits.js";
import { SLACK_QUESTION_FINALIZATION_BLOCKS } from "./reply-action-ids.js";
import {
  clearSlackThreadParticipationCache,
  hasSlackThreadParticipation,
} from "./sent-thread-cache.js";

const { sendMessageSlack, setSlackDefaultSendIdentity } = await import("./send.js");
const { slackPlugin } = await import("./channel.js");
const SLACK_TEST_CFG = { channels: { slack: { botToken: "xoxb-test" } } };
const SLACK_TEXT_LIMIT = 8000;
let client: ReturnType<typeof createSlackSendTestClient>;
let postMessage: typeof client.chat.postMessage;
beforeEach(() => {
  client = createSlackSendTestClient();
  postMessage = client.chat.postMessage;
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
  return postMessage.mock.calls[callIndex]![0];
}
const slackText = (text: string, type = "mrkdwn") => ({ type, text });
const section = (value: string) => ({ type: "section", text: slackText(value) });
const table = (caption: string) => ({
  type: "data_table",
  caption,
  rows: [[slackText("Account", "raw_text")], [slackText("Acme", "raw_text")]],
});
function posts() {
  return postMessage.mock.calls.map(([post]) => post);
}
function expectBoundedPlainText() {
  expect(posts().every((post) => post.mrkdwn === false)).toBe(true);
  expect(
    posts().every((post) => String(post.text).length <= SLACK_MESSAGE_TEXT_RECOMMENDED_LIMIT),
  ).toBe(true);
}

function interleavedNativeDataBlocks(): Array<Record<string, unknown>> {
  return [
    section("Before"),
    {
      type: "data_visualization",
      title: "Revenue mix",
      chart: {
        type: "pie",
        segments: [
          { label: "Product", value: 60 },
          { label: "Services", value: 40 },
        ],
      },
    },
    {
      type: "data_table",
      caption: "Pipeline report",
      rows: [
        [slackText("Account", "raw_text"), slackText("ARR", "raw_text")],
        [slackText("Acme", "raw_text"), { type: "raw_number", value: 125000, text: "$125k" }],
      ],
    },
    section("After"),
    {
      type: "actions",
      block_id: "private-block",
      elements: [
        {
          type: "button",
          action_id: "private-button",
          text: slackText("Approve", "plain_text"),
          value: "private-value",
        },
        {
          type: "static_select",
          action_id: "private-select",
          placeholder: slackText("Choose owner", "plain_text"),
          options: [{ text: slackText("Operations", "plain_text"), value: "private-option" }],
        },
      ],
    },
  ];
}

const INTERLEAVED_NATIVE_DATA_ACCESSIBILITY = [
  "Outside",
  "Before",
  "Revenue mix (pie chart)\n- Product: 60\n- Services: 40",
  "Pipeline report (table)\nAccount\tARR\nAcme\t$125k",
  "After",
  "Approve\nChoose owner\nOperations",
].join("\n\n");

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
    expect(postMessage).toHaveBeenCalled();
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

  it("rejects a successful Slack post that returns no message timestamp", async () => {
    postMessage.mockResolvedValueOnce({ ok: true, channel: "C123" });
    await expect(send("hello")).rejects.toThrow(
      "Slack chat.postMessage returned no message timestamp",
    );
  });

  it("preserves the first canonical response thread across chunked sends", async () => {
    postMessage
      .mockResolvedValueOnce({
        ts: "1781932190.115869",
        channel: "C123",
        message: {
          ts: "1781932190.115869",
          thread_ts: "1781803536.235489",
        },
      })
      .mockResolvedValueOnce({
        ts: "1781932191.000000",
        channel: "C123",
      });
    const message = "a".repeat(8500);
    const result = await send(message, {
      threadTs: "1781932168.648159",
      replyBroadcast: true,
    });
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postedMessage()).toMatchObject({
      thread_ts: "1781932168.648159",
      reply_broadcast: true,
    });
    expect(postedMessage(1).thread_ts).toBe("1781932168.648159");
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
  it("marks only the fallback card that actually contains the question controls", async () => {
    let messageCount = 0;
    postMessage.mockImplementation(async () => ({
      ok: true,
      ts: `171234.${String(++messageCount).padStart(3, "0")}`,
    }));
    postMessage.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });
    const questionActionId = "openclaw:question_button:2:1";
    const blocks = interleavedNativeDataBlocks();
    const actionBlock = blocks.at(-1) as { elements: Array<{ action_id: string }> };
    actionBlock.elements[0]!.action_id = questionActionId;
    blocks.push(section("After question"));
    const onDeliveryResult = vi.fn();

    const aggregateResult = await send("Outside", {
      blocks: blocks as never,
      nativeDataFallbackBaseText: "Outside",
      textLimit: 25,
      onDeliveryResult,
    });
    expect(postedMessage().text).toBe(`${INTERLEAVED_NATIVE_DATA_ACCESSIBILITY}\n\nAfter question`);
    for (const [post] of postMessage.mock.calls) {
      expect(post.text).not.toMatch(/private/u);
    }
    const delivered = onDeliveryResult.mock.calls.map(([result]) => result);
    expect(delivered.length).toBeGreaterThan(1);
    expect(delivered.filter((result) => result.meta)).toEqual([
      expect.objectContaining({
        meta: expect.objectContaining({ slackQuestionActionIds: [questionActionId] }),
      }),
    ]);
    expect(
      delivered.some((result) => result.receipt.parts[0]?.kind === "card" && !result.meta),
    ).toBe(true);
    expect(aggregateResult.receipt.parts).toMatchObject(
      delivered.map((result, index) => ({
        platformMessageId: result.messageId,
        kind: result.receipt.parts[0]?.kind,
        index,
      })),
    );
    const questionDelivery = delivered.find((delivery) => delivery.meta);
    expect(questionDelivery?.messageId).not.toBe(aggregateResult.messageId);
    expect(JSON.stringify(aggregateResult.meta)).toBe(
      JSON.stringify({
        slackQuestionActionIds: [questionActionId],
        slackQuestionMessageId: questionDelivery?.messageId,
      }),
    );
    expect(aggregateResult.meta?.[SLACK_QUESTION_FINALIZATION_BLOCKS]).toBe(
      questionDelivery?.meta?.[SLACK_QUESTION_FINALIZATION_BLOCKS],
    );
    expect(
      aggregateResult.meta?.[SLACK_QUESTION_FINALIZATION_BLOCKS]?.some(
        (block) => block.type === "actions" || block.type === "data_table",
      ),
    ).toBe(false);
  });

  it("uses resolved-limit blockless chunks for oversized native data with no survivors", async () => {
    const caption = "c".repeat(41_000);
    await send("", { blocks: [table(caption)] as never });
    expect(postMessage).toHaveBeenCalledTimes(11);
    expect(posts().every((post) => post.blocks === undefined)).toBe(true);
    expectBoundedPlainText();
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
    await send("", { blocks, authoredTextPlacement: "none" });
    expect(postMessage).toHaveBeenCalledTimes(20);
    expectBoundedPlainText();
    expect(posts().flatMap((post) => post.blocks as unknown[])).toEqual(blocks);
  });

  it("does not fall back from non-invalid_blocks native table errors", async () => {
    postMessage.mockRejectedValueOnce(
      Object.assign(new Error("An API error occurred: ratelimited"), {
        data: { error: "ratelimited" },
      }),
    );
    await expect(send("Overview", { blocks: [table("Pipeline")] as never })).rejects.toThrow(
      "ratelimited",
    );
    expect(postMessage).toHaveBeenCalledOnce();
  });

  it("posts user-target block messages directly without conversations.open", async () => {
    client.conversations.open.mockRejectedValueOnce(new Error("missing_scope"));
    postMessage.mockResolvedValueOnce({ ts: "171234.567", channel: "D123" });
    const result = await send(
      "",
      { blocks: [{ type: "divider" }], replyBroadcast: true },
      "user:U123",
    );
    expect(postedMessage()).not.toHaveProperty("reply_broadcast");
    expect(client.conversations.open).not.toHaveBeenCalled();
    expect(postedMessage()).toMatchObject({ channel: "U123", text: "Shared a Block Kit message" });
    expect(result).toMatchObject({ messageId: "171234.567", channelId: "D123" });
    expect(result.receipt.platformMessageIds).toEqual(["171234.567"]);
    expect(result.receipt.parts[0]?.raw).toMatchObject({ channelId: "D123" });
  });

  it("retries Slack postMessage DNS request errors without enabling broad write retries", async () => {
    postMessage
      .mockRejectedValueOnce(slackDnsRequestError())
      .mockResolvedValueOnce({ ts: "171234.999" });
    const result = await send("hello");
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ messageId: "171234.999", channelId: "C123" });
    expect(result.receipt.parts[0]).toMatchObject({
      platformMessageId: "171234.999",
      kind: "text",
    });
  });

  it("retries Slack conversations.open DNS request errors for threaded DMs", async () => {
    client.conversations.open
      .mockRejectedValueOnce(slackDnsRequestError())
      .mockResolvedValueOnce({ channel: { id: "D123" } });
    const result = await send("hello", { threadTs: "171234.100" }, "user:U123");
    expect(client.conversations.open).toHaveBeenCalledTimes(2);
    expect(postedMessage()).toMatchObject({ channel: "D123", thread_ts: "171234.100" });
    expect(result).toMatchObject({ messageId: "171234.567", channelId: "D123" });
    expect(result.receipt.threadId).toBe("171234.100");
  });

  it("caps long fallback text while preserving blocks", async () => {
    const blocks = [
      {
        type: "context",
        elements: Array.from({ length: 3 }, () => slackText("a".repeat(3000))),
      },
    ];
    await send("", { blocks });
    const post = postedMessage();
    expect(String(post.text).endsWith("…")).toBe(true);
    expect(post.blocks).toBe(blocks);
    expect(post.text).toHaveLength(SLACK_TEXT_LIMIT);
  });

  it.each<{
    name: string;
    options: Partial<Parameters<typeof sendMessageSlack>[2]>;
    error: RegExp;
  }>([
    {
      name: "rejects blocks combined with mediaUrl",
      options: {
        mediaUrl: "https://example.com/image.png",
        blocks: [{ type: "divider" }],
      },
      error: /does not support blocks with mediaUrl/i,
    },
    {
      name: "rejects replyBroadcast combined with mediaUrl",
      options: {
        mediaUrl: "https://example.com/image.png",
        threadTs: "171234.100",
        replyBroadcast: true,
      },
      error: /replyBroadcast is only supported for text or block thread replies/i,
    },
  ])("$name", async ({ options, error }) => {
    await expect(send("hi", options)).rejects.toThrow(error);
    expect(postMessage).not.toHaveBeenCalled();
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
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("retains earlier Slack delivery evidence when a later chunk is permanently rejected", async () => {
    const rejection = slackPlatformError("messages_tab_disabled");
    postMessage
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
    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it("does not classify a persistence callback failure as a Slack API rejection", async () => {
    const callbackError = slackPlatformError("messages_tab_disabled");
    postMessage.mockResolvedValueOnce({ ts: "171234.100", channel: "C123" });
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

  it.each([
    { needed: "chat:write.customize" },
    {
      response_metadata: { scopes: ["chat:write"], acceptedScopes: ["", " chat:write.customize "] },
    },
  ])("drops identity only for the customize scope: %j", async (details) => {
    postMessage.mockRejectedValueOnce(missingScope(details));
    const result = await send("hello", { identity: { iconEmoji: ":robot_face:" } });
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postedMessage(0)).toMatchObject({ icon_emoji: ":robot_face:" });
    expect(postedMessage(1)).toEqual({ channel: "C123", text: "hello", unfurl_links: false });
    expect(result.messageId).toBe("171234.567");
  });

  it("drops the full identity only after the username-only retry fails", async () => {
    postMessage.mockRejectedValueOnce(invalidIdentity()).mockRejectedValueOnce(invalidIdentity());
    await send("hello", { identity: { username: "Pulse", iconEmoji: "📟" } });
    expect(postMessage).toHaveBeenCalledTimes(3);
    expect(postedMessage(1)).toMatchObject({ username: "Pulse" });
    expect(postedMessage(1)).not.toHaveProperty("icon_emoji");
    expect(postedMessage(2)).toEqual({ channel: "C123", text: "hello", unfurl_links: false });
  });

  it("reuses the downgraded explicit identity for later chunks", async () => {
    setSlackDefaultSendIdentity("default", { username: "Relay" });
    postMessage.mockRejectedValueOnce(invalidIdentity());
    await send("alpha beta", { identity: { username: "Pulse", iconEmoji: "📟" }, textLimit: 5 });
    expect(postMessage).toHaveBeenCalledTimes(3);
    expect(postedMessage(0)).toMatchObject({ username: "Pulse", icon_emoji: "📟" });
    for (const index of [1, 2]) {
      expect(postedMessage(index)).toMatchObject({ username: "Pulse" });
      expect(postedMessage(index)).not.toHaveProperty("icon_emoji");
    }
  });

  it("preserves other missing-scope details without retrying identity", async () => {
    postMessage.mockRejectedValueOnce(
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
    expect(postMessage).toHaveBeenCalledOnce();
  });
});
