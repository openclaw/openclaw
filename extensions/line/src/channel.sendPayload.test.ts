import { HTTPFetchError } from "@line/bot-sdk";
import { expectDefined } from "@openclaw/normalization-core";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { chunkMarkdownText as chunkMarkdownTextForLine } from "openclaw/plugin-sdk/reply-runtime";
import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { createQuickReply } from "./auto-reply-delivery.test-helpers.js";
import { linePlugin } from "./channel.js";
import { createRuntime, lineResult } from "./channel.sendPayload.test-support.js";
import { resolveLineGroupRequireMention } from "./group-policy.js";
import { lineOutboundAdapter } from "./outbound.js";
import {
  createPendingLineResponse,
  LINE_QUOTA_ACCOUNT,
  stubLineApiFetch,
} from "./probe.test-support.js";
import { recordLineQuoteToken } from "./quote-tokens.js";
import { setLineRuntime } from "./runtime.js";
import { createLineSendReceipt } from "./send-receipt.js";
import type { LineChannelData, LineConfig } from "./types.js";

const ssrfMocks = vi.hoisted(() => ({ resolvePinnedHostnameWithPolicy: vi.fn() }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  resolvePinnedHostnameWithPolicy: ssrfMocks.resolvePinnedHostnameWithPolicy,
}));

function lineConfig(line: LineConfig): OpenClawConfig {
  return { channels: { line } };
}
const cfg = lineConfig({});
const to = "line:user:U123";
const sendOptions = { verbose: false, accountId: "default", cfg };
const primaryContext = { cfg, to, accountId: "primary" };
const primaryOptions = { ...sendOptions, accountId: "primary" };
const videoUrl = "https://example.com/video.mp4";
const imageUrl = "https://example.com/photo.png";
const audioUrl = "https://example.com/voice.m4a";
const previewImageUrl = "https://example.com/preview.jpg";
const locationFixture = {
  title: "Meet here",
  address: "1 Main Street",
  latitude: 35.6895,
  longitude: 139.6917,
};
type SendContext = Parameters<NonNullable<typeof lineOutboundAdapter.sendPayload>>[0];
type SendOverrides = Partial<Omit<SendContext, "payload" | "text">>;
type Payload = Omit<SendContext["payload"], "channelData"> & { line?: LineChannelData };
let mocks: ReturnType<typeof createRuntime>["mocks"];

function send({ line, ...payload }: Payload, context: SendOverrides = {}) {
  return lineOutboundAdapter.sendPayload!({
    to,
    cfg,
    accountId: "default",
    text: payload.text ?? "",
    ...context,
    payload: { ...payload, ...(line ? { channelData: { line } } : {}) },
  });
}

function inlineMedia(mediaUrl: string, line: LineChannelData = {}, context: SendOverrides = {}) {
  return send({ mediaUrl, line: { quickReplies: ["One"], ...line } }, context);
}

function expectBatch(messages: readonly unknown[], target = to) {
  expect(mocks.pushMessagesLine).toHaveBeenCalledWith(target, messages, sendOptions);
}

function order(mock: { mock: { invocationCallOrder: number[] } }) {
  return expectDefined(mock.mock.invocationCallOrder[0], "delivery invocation");
}

function delivery(messageIds: readonly string[], threadId = "c1") {
  return expect.objectContaining({
    channel: "line",
    chatId: threadId,
    messageId: messageIds[0],
    receipt: expect.objectContaining({
      platformMessageIds: messageIds,
      primaryPlatformMessageId: messageIds[0],
      threadId,
      sentAt: 1_800_000_000_000,
    }),
  });
}

function refusal(status: number, monthlyLimit = false) {
  const statusText = monthlyLimit ? "Too Many Requests" : "provider rejection";
  return new HTTPFetchError(`${status} - ${statusText}`, {
    status,
    statusText,
    headers: new Headers(),
    body: monthlyLimit
      ? JSON.stringify({ message: "You have reached your monthly limit." })
      : statusText,
  });
}

beforeEach(() => {
  vi.setSystemTime(1_800_000_000_000);
  ssrfMocks.resolvePinnedHostnameWithPolicy.mockReset();
  ssrfMocks.resolvePinnedHostnameWithPolicy.mockResolvedValue({
    hostname: "example.com",
    addresses: ["93.184.216.34"],
  });
  const fixture = createRuntime();
  mocks = fixture.mocks;
  setLineRuntime(fixture.runtime);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

it("sends oversized tables in source order with quick replies on the final card", async () => {
  mocks.resolveTextChunkLimit.mockReturnValue(5000);
  mocks.chunkMarkdownText.mockImplementation(chunkMarkdownTextForLine);
  const markdown = `First\n\n| Small | Value |\n|---|---|\n| Kept | card |\n\nBetween\n\n| Name | Value |\n|---|---|\n| Large | ${"x".repeat(30_000)} |\n\nAfter\n\n\`\`\`js\nconsole.log("still a card")\n\`\`\``;
  await send({ text: markdown, line: { quickReplies: ["Continue"] } });
  expect(mocks.pushFlexMessage).toHaveBeenCalledOnce();
  const oversized = mocks.pushMessageLine.mock.calls.flatMap((args, index) =>
    args[1].includes("Large") ? [mocks.pushMessageLine.mock.invocationCallOrder[index]] : [],
  );
  expect(oversized).toHaveLength(1);
  expect(oversized[0]).toBeGreaterThan(order(mocks.pushFlexMessage));
  expect(oversized[0]).toBeLessThan(order(mocks.pushMessagesLine));
  expect(mocks.pushMessageLine.mock.calls.every((args) => args[1].length <= 5000)).toBe(true);
  expect(mocks.pushMessagesLine).toHaveBeenCalledExactlyOnceWith(
    to,
    [expect.objectContaining({ altText: "Code", quickReply: createQuickReply("Continue") })],
    expect.any(Object),
  );
  expect(mocks.pushTextMessageWithQuickReplies).not.toHaveBeenCalled();
});

it("rejects whitespace instead of fabricating a delivery", async () => {
  await expect(send({ text: "   " })).rejects.toThrow("Message must be non-empty for LINE sends");
  expect(mocks.pushMessageLine).not.toHaveBeenCalled();
  expect(mocks.pushMessagesLine).not.toHaveBeenCalled();
});

it("delivers a blank-title location instead of dropping it", async () => {
  const location = { ...locationFixture, title: " " };
  await send({ text: "Meet me there.", line: { location } });
  expect(mocks.pushLocationMessage).toHaveBeenCalledWith(to, location, expect.any(Object));
  expect(mocks.pushMessageLine).toHaveBeenCalledWith(to, "Meet me there.", expect.any(Object));
});

it("keeps a degraded location in the quick-reply inline batch", async () => {
  await send({
    line: {
      quickReplies: ["Continue"],
      location: { ...locationFixture, address: " " },
    },
  });
  expectBatch([
    {
      type: "text",
      text: "Meet here\n35.6895, 139.6917",
      quickReply: createQuickReply("Continue"),
    },
  ]);
  expect(mocks.pushTextMessageWithQuickReplies).not.toHaveBeenCalled();
});

it("preserves all finalized receipts when its delivery observer rejects", async () => {
  const failure = new Error("delivery observer unavailable");
  mocks.chunkMarkdownText.mockReturnValueOnce(["First", "Second", "Third"]);
  mocks.pushMessageLine
    .mockResolvedValueOnce(lineResult("m-first"))
    .mockResolvedValueOnce(lineResult("m-second"));
  const onDeliveryResult = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure);
  const caught = await send({ text: "Hello" }, { onDeliveryResult }).catch(
    (error: unknown) => error,
  );
  if (!isChannelPartialDeliveryError(caught)) {
    throw new Error("expected a partial LINE delivery error");
  }
  expect(caught.cause).toBe(failure);
  expect(caught.deliveryResult).toMatchObject({
    messageIds: ["m-first", "m-second"],
    receipt: { platformMessageIds: ["m-first", "m-second"] },
    visibleReplySent: true,
  });
  expect(mocks.pushMessageLine).toHaveBeenCalledTimes(2);
  expect(onDeliveryResult).toHaveBeenCalledTimes(2);
});

it("publishes completed Flex receipts before a later legacy text send fails", async () => {
  const tokenCfg = lineConfig({ channelAccessToken: "line-fixture-token" });
  const laterFailure = new Error("second LINE Flex send failed");
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ sentMessages: [{ id: "m-first-flex" }] }))
    .mockRejectedValueOnce(laterFailure);
  vi.stubGlobal("fetch", fetch);
  mocks.pushFlexMessage
    .mockResolvedValueOnce(lineResult("m-first-flex"))
    .mockRejectedValueOnce(laterFailure);
  const onDeliveryResult = vi.fn();
  await expect(
    lineOutboundAdapter.sendText!({
      to,
      text: "```js\nfirst()\n```\n\n```js\nsecond()\n```",
      accountId: "default",
      cfg: tokenCfg,
      onDeliveryResult,
    }),
  ).rejects.toThrow("second LINE Flex send failed");
  expect(onDeliveryResult).toHaveBeenCalledOnce();
  expect(onDeliveryResult).toHaveBeenCalledWith(delivery(["m-first-flex"]));
  expect(fetch).not.toHaveBeenCalled();
});

it("sends flex message without dropping text", async () => {
  await send(
    {
      text: "Now playing:",
      line: {
        flexMessage: { altText: "Now playing", contents: { type: "bubble" } },
      },
    },
    { to: "line:group:1" },
  );
  expect(mocks.pushFlexMessage).toHaveBeenCalledOnce();
  expect(mocks.pushMessageLine).toHaveBeenCalledWith("line:group:1", "Now playing:", sendOptions);
});

it("preserves inline batch receipts and bounds the Flex alternative text", async () => {
  const providerMessageIds = ["line-provider-first", "line-provider-second"] as const;
  mocks.pushMessagesLine.mockResolvedValueOnce({
    messageId: providerMessageIds[0],
    chatId: "C123",
    receipt: createLineSendReceipt({
      messageId: providerMessageIds[0],
      messageIds: providerMessageIds,
      chatId: "C123",
      kind: "card",
      messageCount: 2,
    }),
  });
  const onDeliveryResult = vi.fn();
  const result = await send(
    {
      line: {
        quickReplies: ["Confirm"],
        flexMessage: { altText: "a".repeat(1600), contents: { type: "bubble" } },
        location: locationFixture,
      },
    },
    { to: "line:group:C123", onDeliveryResult },
  );
  expect(mocks.pushFlexMessage).not.toHaveBeenCalled();
  expectBatch(
    [
      { type: "flex", altText: "a".repeat(1500), contents: { type: "bubble" } },
      expect.objectContaining({ type: "location", quickReply: createQuickReply("Confirm") }),
    ],
    "line:group:C123",
  );
  expect(mocks.createQuickReplyItems).toHaveBeenCalledWith(["Confirm"]);
  expect(result.messageId).toBe(providerMessageIds[0]);
  expect(result.receipt?.platformMessageIds).toEqual(providerMessageIds);
  expect(result.receipt?.parts.map((part) => part.platformMessageId)).toEqual(providerMessageIds);
  expect(result.receipt?.threadId).toBe("C123");
  expect(onDeliveryResult).toHaveBeenCalledWith(delivery(providerMessageIds, "C123"));
});

it("sends template message without dropping text", async () => {
  await send({
    text: "Choose one:",
    line: {
      templateMessage: {
        type: "confirm",
        text: "Continue?",
        confirmLabel: "Yes",
        confirmData: "yes",
        cancelLabel: "No",
        cancelData: "no",
      },
    },
  });
  expect(mocks.buildTemplateMessageFromPayload).toHaveBeenCalledOnce();
  expect(mocks.pushTemplateMessage).toHaveBeenCalledOnce();
  expect(mocks.pushMessageLine).toHaveBeenCalledWith(to, "Choose one:", sendOptions);
});

it("sends quick-reply-only payloads with fallback text", async () => {
  const result = await send({ line: { quickReplies: ["One", "Two"] } });
  expect(mocks.pushTextMessageWithQuickReplies).toHaveBeenCalledWith(
    to,
    "Options:\n- One\n- Two",
    ["One", "Two"],
    sendOptions,
  );
  expect(result).toEqual(delivery(["m-quick"]));
});

it.each([
  { target: "line:group:C123", tracking: {} },
  { target: to, tracking: { trackingId: "track-user" } },
])("gates inline video tracking on $target", async ({ target, tracking }) => {
  await inlineMedia(
    videoUrl,
    { mediaKind: "video", previewImageUrl, trackingId: "track-user" },
    { to: target },
  );
  expectBatch(
    [
      {
        type: "video",
        originalContentUrl: videoUrl,
        previewImageUrl,
        ...tracking,
        quickReply: createQuickReply("One"),
      },
    ],
    target,
  );
});

it.each([
  [imageUrl, { type: "image", originalContentUrl: imageUrl, previewImageUrl: imageUrl }],
  [audioUrl, { type: "audio", originalContentUrl: audioUrl, duration: 60000 }],
] as const)("validates and infers inline quick-reply media from %s", async (url, message) => {
  await inlineMedia(url);
  expectBatch([{ ...message, quickReply: createQuickReply("One") }]);
  expect(ssrfMocks.resolvePinnedHostnameWithPolicy).toHaveBeenCalledWith("example.com", {
    policy: { allowPrivateNetwork: false },
  });
});

it("rejects insecure generic media before quick-reply batch sends", async () => {
  const url = new URL("http://example.com/image.jpg");
  url.username = ["line", "user"].join("-");
  url.password = ["line", "fixture"].join("-");
  url.searchParams.set("auth", ["line", "query"].join("-"));
  await expect(inlineMedia(url.href)).rejects.toThrow(
    new Error("LINE outbound media URL must use HTTPS"),
  );
  expect(mocks.pushMessagesLine).not.toHaveBeenCalled();
});

it("rejects quick-reply inline video media without previewImageUrl", async () => {
  await expect(inlineMedia(videoUrl, { mediaKind: "video" })).rejects.toThrow(
    /require previewimageurl/i,
  );
});

it("returns a receipt for a quoted send through the registered text adapter", async () => {
  recordLineQuoteToken({
    accountId: "primary",
    chatId: "U123",
    messageId: "m-answered",
    quoteToken: "q-answered",
  });
  const result = await linePlugin.message!.send!.text!({
    ...primaryContext,
    text: "answering you",
    replyToId: "m-answered",
  });
  expect(mocks.pushMessageLine).toHaveBeenCalledWith(to, "answering you", {
    ...primaryOptions,
    quoteToken: "q-answered",
  });
  expect(result.receipt.platformMessageIds).toEqual(["m-text"]);
});

it("reports caption and media receipts through the registered media adapter", async () => {
  const onDeliveryResult = vi.fn();
  const result = await linePlugin.message!.send!.media!({
    ...primaryContext,
    text: "image",
    mediaUrl: imageUrl,
    onDeliveryResult,
  });
  expect(mocks.sendMessageLine).toHaveBeenCalledWith(to, "", {
    ...primaryOptions,
    mediaUrl: imageUrl,
  });
  expect(result.receipt.platformMessageIds).toEqual(["m-media"]);
  expect(onDeliveryResult).toHaveBeenCalledTimes(2);
  expect(onDeliveryResult.mock.calls.map(([receipt]) => receipt.messageId)).toEqual([
    "m-text",
    "m-media",
  ]);
});

it.each([
  { status: 400, retryable: false },
  { status: 429, retryable: true },
])("reports an initial LINE $status as a non-dispatch", async ({ status, retryable }) => {
  const rejection = refusal(status);
  mocks.pushMessageLine.mockRejectedValueOnce(rejection);
  await expect(send({ text: "hello" })).rejects.toMatchObject({
    name: "PlatformMessageNotDispatchedError",
    retryable,
    cause: rejection,
  });
});

it.each<[string, number | undefined, number | undefined, boolean, number]>([
  ["exhausted", 200, 200, false, 2],
  ["fractional allowance", 200.5, 201, true, 1],
  ["fractional usage", 200, 200.5, true, 2],
  ["available allowance", 200, 12, true, 2],
  ["unlimited", undefined, undefined, true, 1],
])("classifies a refusal with %s quota", async (_label, limit, used, retryable, requests) => {
  const rejection = refusal(429, true);
  mocks.pushMessageLine.mockRejectedValueOnce(rejection);
  const fetchMock = stubLineApiFetch(
    Response.json(limit === undefined ? { type: "none" } : { type: "limited", value: limit }),
    ...(used === undefined ? [] : [Response.json({ totalUsage: used })]),
  );
  await expect(send({ text: "hello" }, LINE_QUOTA_ACCOUNT)).rejects.toMatchObject({
    name: "PlatformMessageNotDispatchedError",
    cause: rejection,
    retryable,
    message: expect.stringContaining(
      retryable ? "429 - Too Many Requests" : "200/200 monthly messages used",
    ),
  });
  expect(mocks.pushMessageLine).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls.map(([input]) => resolveRequestUrl(input))[0]).toBe(
    "https://api.line.me/v2/bot/message/quota",
  );
  expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
    "Bearer quota-test-token",
  );
  expect(fetchMock).toHaveBeenCalledTimes(requests);
});

it("keeps a stalled allowance from holding back a retryable refusal", async () => {
  vi.useFakeTimers();
  const pending = createPendingLineResponse({ type: "none" });
  const fetchMock = stubLineApiFetch(pending.response);
  let delivered: Promise<unknown> | undefined;
  try {
    mocks.pushMessageLine.mockRejectedValueOnce(refusal(429, true));
    delivered = send({ text: "hello" }, LINE_QUOTA_ACCOUNT);
    const settled = expect(delivered).rejects.toMatchObject({
      name: "PlatformMessageNotDispatchedError",
      retryable: true,
      message: "429 - Too Many Requests",
    });
    await vi.advanceTimersByTimeAsync(2_500);
    await settled;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(pending.cancel).toHaveBeenCalledOnce();
  } finally {
    pending.finish();
    await vi.runAllTimersAsync();
    await delivered?.catch(() => {});
  }
});

it.each([false, true])(
  "keeps accepted media receipts for a later text refusal (observer=%s)",
  async (observed) => {
    const rejection = refusal(429);
    const onDeliveryResult = observed ? vi.fn() : undefined;
    mocks.pushTextMessageWithQuickReplies.mockRejectedValueOnce(rejection);
    const fetchMock = stubLineApiFetch(
      Response.json({ type: "limited", value: 200 }),
      Response.json({ totalUsage: 200 }),
    );
    await expect(
      send(
        {
          text: "Caption",
          mediaUrl: imageUrl,
          line: { quickReplies: ["Continue"] },
        },
        { ...LINE_QUOTA_ACCOUNT, onDeliveryResult },
      ),
    ).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      cause: rejection,
      deliveryResult: {
        messageIds: ["m-media"],
        receipt: { platformMessageIds: ["m-media"] },
        visibleReplySent: true,
      },
    });
    expect(mocks.sendMessageLine).toHaveBeenCalledOnce();
    expect(mocks.pushTextMessageWithQuickReplies).toHaveBeenCalledOnce();
    if (onDeliveryResult) {
      expect(order(onDeliveryResult)).toBeLessThan(order(mocks.pushTextMessageWithQuickReplies));
      expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(delivery(["m-media"]));
    }
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "preserves nested LINE partial evidence (prior acceptance=%s)",
  async (accepted) => {
    const rejection = refusal(400);
    const partial = createChannelPartialDeliveryError(rejection, {
      messageIds: ["accepted-child"],
      receipt: createLineSendReceipt({ messageId: "accepted-child", chatId: "c1", kind: "text" }),
      visibleReplySent: true,
    });
    if (accepted) {
      mocks.chunkMarkdownText.mockReturnValueOnce(["First", "Second"]);
      mocks.pushMessageLine.mockResolvedValueOnce(lineResult("accepted-first"));
    }
    mocks.pushMessageLine.mockRejectedValueOnce(partial);
    const caught = await send({ text: "hello" }).catch((error: unknown) => error);
    if (!accepted) {
      expect(caught).toBe(partial);
      return;
    }
    expect(caught).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      cause: rejection,
      deliveryResult: {
        messageIds: ["accepted-first", "accepted-child"],
        receipt: { platformMessageIds: ["accepted-first", "accepted-child"] },
        visibleReplySent: true,
      },
    });
  },
);

const pairingCfg = lineConfig({
  defaultAccount: "alpha",
  accounts: {
    alpha: { channelAccessToken: "token-alpha" },
    beta: { channelAccessToken: "token-beta" },
  },
});

it("pushes the approval from the approved account", async () => {
  await linePlugin.pairing!.notifyApproval!({
    cfg: pairingCfg,
    id: "U-paired",
    accountId: "beta",
  });
  expect(mocks.pushMessageLine).toHaveBeenCalledExactlyOnceWith(
    "U-paired",
    expect.any(String),
    expect.objectContaining({ accountId: "beta", channelAccessToken: "token-beta" }),
  );
});

it("uses account-level group mention settings when provided", () => {
  const groupCfg = lineConfig({
    groups: { "*": { requireMention: false } },
    accounts: { primary: { groups: { "group-1": { requireMention: true } } } },
  });
  expect(
    resolveLineGroupRequireMention({ cfg: groupCfg, accountId: "primary", groupId: "group-1" }),
  ).toBe(true);
});
