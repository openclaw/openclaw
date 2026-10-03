import { HTTPFetchError } from "@line/bot-sdk";
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
  const messages = [
    ...mocks.pushFlexMessage.mock.calls.map((args, index) => ({
      position: mocks.pushFlexMessage.mock.invocationCallOrder[index]!,
      type: args[1] === "Code" ? "code-card" : "table-card",
    })),
    ...mocks.pushMessageLine.mock.calls.map((args, index) => ({
      position: mocks.pushMessageLine.mock.invocationCallOrder[index]!,
      type: args[1].includes("Large") ? "oversized-table-text" : "text",
    })),
    ...mocks.pushMessagesLine.mock.calls.flatMap((args, index) =>
      args[1].map((message) => ({
        position: mocks.pushMessagesLine.mock.invocationCallOrder[index]!,
        type:
          "altText" in message && message.altText === "Code"
            ? "code-card"
            : "altText" in message && message.altText === "Table"
              ? "table-card"
              : message.type === "text" && message.text?.includes("Large")
                ? "oversized-table-text"
                : message.type,
      })),
    ),
  ]
    .toSorted((left, right) => left.position - right.position)
    .map((message) => message.type)
    .filter((type) => type !== "text");
  expect(messages).toEqual(["table-card", "oversized-table-text", "code-card"]);
  const textParts = [
    ...mocks.pushMessageLine.mock.calls.map((args) => args[1]),
    ...mocks.pushMessagesLine.mock.calls.flatMap((args) =>
      args[1].flatMap((message) => (message.type === "text" ? [message.text ?? ""] : [])),
    ),
  ];
  const oversized = textParts.filter((text) => text.includes("Large"));
  expect(oversized).toHaveLength(1);
  expect(textParts.every((text) => text.length <= 5000)).toBe(true);
  expect(mocks.pushMessagesLine.mock.calls.at(-1)).toEqual([
    to,
    [
      expect.objectContaining({ type: "text", text: "After" }),
      expect.objectContaining({ altText: "Code", quickReply: createQuickReply("Continue") }),
    ],
    expect.any(Object),
  ]);
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
  expectBatch([
    { type: "text", text: "1 Main Street\n35.6895, 139.6917" },
    { type: "text", text: "Meet me there." },
  ]);
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

it("preserves the finalized receipt when its delivery observer rejects", async () => {
  const onDeliveryResult = vi.fn(async () => {
    throw new Error("delivery observer unavailable");
  });
  const caught = await send({ text: "Hello" }, { onDeliveryResult }).catch(
    (error: unknown) => error,
  );
  if (!isChannelPartialDeliveryError(caught)) {
    throw new Error("expected a partial LINE delivery error");
  }
  expect(caught.deliveryResult).toMatchObject({
    messageIds: ["m-text"],
    receipt: { primaryPlatformMessageId: "m-text" },
    visibleReplySent: true,
  });
  expect(onDeliveryResult).toHaveBeenCalledOnce();
});

it("publishes completed batch receipts before a later batch send fails", async () => {
  const laterFailure = new Error("second LINE batch send failed");
  mocks.pushMessagesLine
    .mockResolvedValueOnce(lineResult("m-first-batch"))
    .mockRejectedValueOnce(laterFailure);
  const onDeliveryResult = vi.fn();
  const text = Array.from(
    { length: 6 },
    (_, index) => `\`\`\`js\nmessage${index + 1}()\n\`\`\``,
  ).join("\n\n");
  await expect(
    lineOutboundAdapter.sendText!({
      to,
      text,
      accountId: "default",
      cfg,
      onDeliveryResult,
    }),
  ).rejects.toThrow("second LINE batch send failed");
  expect(mocks.pushMessagesLine).toHaveBeenCalledTimes(2);
  expect(mocks.pushMessagesLine.mock.calls[0]?.[1]).toHaveLength(5);
  expect(mocks.pushMessagesLine.mock.calls[1]?.[1]).toHaveLength(1);
  expect(onDeliveryResult).toHaveBeenCalledOnce();
  expect(onDeliveryResult).toHaveBeenCalledWith(
    expect.objectContaining({
      messageId: "m-first-batch",
      receipt: expect.objectContaining({ platformMessageIds: ["m-first-batch"] }),
    }),
  );
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
  expectBatch(
    [
      { type: "flex", altText: "Now playing", contents: { type: "bubble" } },
      { type: "text", text: "Now playing:" },
    ],
    "line:group:1",
  );
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
  expectBatch([
    expect.objectContaining({ type: "template" }),
    { type: "text", text: "Choose one:" },
  ]);
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
  expect(result.receipt?.platformMessageIds).toEqual(["m-text"]);
});

it("reports caption and media receipts through the registered media adapter", async () => {
  const onDeliveryResult = vi.fn();
  const result = await linePlugin.message!.send!.media!({
    ...primaryContext,
    text: "image",
    mediaUrl: imageUrl,
    onDeliveryResult,
  });
  expect(mocks.pushMessagesLine).toHaveBeenCalledExactlyOnceWith(
    to,
    [
      { type: "text", text: "image" },
      { type: "image", originalContentUrl: imageUrl, previewImageUrl: imageUrl },
    ],
    primaryOptions,
  );
  expect(result.receipt.platformMessageIds).toEqual(["m-batch"]);
  expect(onDeliveryResult).toHaveBeenCalledOnce();
  expect(onDeliveryResult.mock.calls.map(([receipt]) => receipt.messageId)).toEqual(["m-batch"]);
});

it("sends media-only payloads through the declared outbound runtime", async () => {
  const result = await linePlugin.message!.send!.media!({
    ...primaryContext,
    text: "",
    mediaUrl: imageUrl,
  });
  expect(mocks.sendMessageLine).toHaveBeenCalledExactlyOnceWith(to, "", {
    ...primaryOptions,
    mediaUrl: imageUrl,
  });
  expect(result.receipt.platformMessageIds).toEqual(["m-media"]);
});

it("recovers every rejected mixed-batch part once after an atomic rejection", async () => {
  mocks.pushMessagesLine
    .mockRejectedValueOnce(refusal(400))
    .mockResolvedValueOnce(lineResult("m-flex"))
    .mockResolvedValueOnce(lineResult("m-location"))
    .mockResolvedValueOnce(lineResult("m-text"));

  const result = await send({
    text: "Caption",
    line: {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
      location: locationFixture,
    },
  });

  expect(
    mocks.pushMessagesLine.mock.calls.map(([, batch]) => batch.map(({ type }) => type)),
  ).toEqual([["flex", "location", "text"], ["flex"], ["location"], ["text"]]);
  expect(result.receipt?.platformMessageIds).toEqual(["m-text"]);
});

it("does not replay accepted batches while recovering rejected rich messages", async () => {
  const codeBlocks = Array.from(
    { length: 7 },
    (_, index) => `\`\`\`js\nconsole.log(${index})\n\`\`\``,
  ).join("\n\n");
  const onDeliveryResult = vi.fn();
  mocks.pushMessagesLine
    .mockResolvedValueOnce(lineResult("m-first-batch"))
    .mockRejectedValueOnce(refusal(400))
    .mockResolvedValueOnce(lineResult("m-recovered-rich"))
    .mockRejectedValueOnce(refusal(400));

  let error: unknown;
  try {
    await send({ text: codeBlocks }, { onDeliveryResult });
  } catch (caught) {
    error = caught;
  }

  if (!isChannelPartialDeliveryError(error)) {
    throw new Error("Expected a partial-delivery result after one rejected rich message");
  }
  expect(error.deliveryResult.visibleReplySent).toBe(true);
  expect(error.deliveryResult.messageIds).toEqual(["m-recovered-rich"]);
  const calls = mocks.pushMessagesLine.mock.calls;
  expect(calls).toHaveLength(4);
  expect(calls[0]?.[1]).toHaveLength(5);
  expect(calls[1]?.[1]).toHaveLength(2);
  expect(calls[2]?.[1]).toEqual([calls[1]![1][0]]);
  expect(calls[3]?.[1]).toEqual([calls[1]![1][1]]);
  expect(calls[0]?.[1]).not.toContainEqual(calls[2]?.[1][0]);
  expect(onDeliveryResult).toHaveBeenCalledTimes(2);
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

it("batches media and quick replies into one provider delivery", async () => {
  const onDeliveryResult = vi.fn();
  mocks.pushMessagesLine.mockResolvedValueOnce(lineResult("m-batch"));
  const fetchMock = stubLineApiFetch(
    Response.json({ type: "limited", value: 200 }),
    Response.json({ totalUsage: 200 }),
  );
  const result = await send(
    {
      text: "Caption",
      mediaUrl: imageUrl,
      line: { quickReplies: ["Continue"] },
    },
    { ...LINE_QUOTA_ACCOUNT, onDeliveryResult },
  );
  expect(mocks.pushMessagesLine).toHaveBeenCalledExactlyOnceWith(
    to,
    [
      { type: "image", originalContentUrl: imageUrl, previewImageUrl: imageUrl },
      { type: "text", text: "Caption", quickReply: createQuickReply("Continue") },
    ],
    expect.objectContaining(LINE_QUOTA_ACCOUNT),
  );
  expect(result.receipt?.platformMessageIds).toEqual(["m-batch"]);
  expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(delivery(["m-batch"]));
  expect(fetchMock).not.toHaveBeenCalled();
});

it("preserves a failed media batch without publishing a receipt", async () => {
  const rejection = new Error("LINE batch transport failed");
  const onDeliveryResult = vi.fn();
  mocks.pushMessagesLine.mockRejectedValueOnce(rejection);
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
  ).rejects.toBe(rejection);
  expect(mocks.pushMessagesLine).toHaveBeenCalledOnce();
  expect(mocks.pushMessagesLine.mock.calls[0]?.[1]).toEqual([
    { type: "image", originalContentUrl: imageUrl, previewImageUrl: imageUrl },
    { type: "text", text: "Caption", quickReply: createQuickReply("Continue") },
  ]);
  expect(onDeliveryResult).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("preserves partial delivery evidence with a nested LINE rejection", async () => {
  const partial = createChannelPartialDeliveryError(refusal(400), {
    messageIds: ["accepted-first"],
    visibleReplySent: true,
  });
  mocks.pushMessageLine.mockRejectedValueOnce(partial);
  await expect(send({ text: "hello" })).rejects.toBe(partial);
});

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
