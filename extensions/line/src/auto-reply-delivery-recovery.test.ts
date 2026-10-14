// LINE auto-reply tests cover HTTP rejection recovery and replay safety.
import { HTTPFetchError, type messagingApi } from "@line/bot-sdk";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverLineAutoReply } from "./auto-reply-delivery.js";
import {
  baseDeliveryParams,
  createDeps,
  createFlexMessage,
  createQuickReply,
  LINE_TEST_CFG,
  type LineAutoReplyDeps,
} from "./auto-reply-delivery.test-helpers.js";
import { lineResult } from "./channel.sendPayload.test-support.js";
import {
  createPendingLineResponse,
  LINE_QUOTA_ACCOUNT,
  stubLineApiFetch,
} from "./probe.test-support.js";
import { runLinePushWithRetries } from "./send-retry.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("deliverLineAutoReply HTTP recovery", () => {
  const createHttpError = (status: number) =>
    new HTTPFetchError(`${status} - provider rejected the request`, {
      status,
      statusText: "provider rejected the request",
      headers: new Headers(),
      body: "provider error",
    });

  const createRichRejection = () =>
    new HTTPFetchError("400 - Bad Request", {
      status: 400,
      statusText: "Bad Request",
      headers: new Headers(),
      body: "invalid rich message",
    });

  const createRejectRichBatch = () =>
    vi.fn(async (_to: string, messages: messagingApi.Message[]) => {
      if (messages.some((message) => message.type === "flex")) {
        throw createRichRejection();
      }
      return lineResult("push", "u1");
    });

  it("keeps a stalled allowance from holding back the webhook reply failure", async () => {
    vi.useFakeTimers();
    const pending = createPendingLineResponse({ type: "none" });
    const fetchMock = stubLineApiFetch(pending.response);
    let delivered: Promise<unknown> | undefined;
    try {
      const rejection = createHttpError(429);
      createDeps({
        pushMessagesLine: (async () => {
          throw rejection;
        }) as LineAutoReplyDeps["pushMessagesLine"],
      });

      delivered = deliverLineAutoReply({
        ...baseDeliveryParams,
        ...LINE_QUOTA_ACCOUNT,
        replyTokenUsed: true,
        payload: { text: "an answer nobody will see" },
        lineData: {},
      });
      const settled = expect(delivered).rejects.toThrow("429 - provider rejected the request");
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

  it.each([
    {
      label: "names the spent allowance once the reply token is gone",
      used: 200,
      expected: "LINE refused the push: 200/200 monthly messages used.",
    },
  ])("$label", async ({ used, expected }) => {
    const rejection = createHttpError(429);
    const pushMessagesLine = vi.fn(async () => {
      throw rejection;
    });
    createDeps({
      pushMessagesLine: pushMessagesLine as LineAutoReplyDeps["pushMessagesLine"],
    });
    const fetchMock = stubLineApiFetch(
      Response.json({ type: "limited", value: 200 }),
      Response.json({ totalUsage: used }),
    );

    await expect(
      deliverLineAutoReply({
        ...baseDeliveryParams,
        ...LINE_QUOTA_ACCOUNT,
        replyTokenUsed: true,
        payload: { text: "an answer nobody will see" },
        lineData: {},
      }),
    ).rejects.toThrow(expected);
    expect(pushMessagesLine).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: "an undici response-body timeout",
      error: Object.assign(new Error("response body timed out"), {
        code: "UND_ERR_BODY_TIMEOUT",
      }),
    },
    {
      label: "a wrapped undici fetch error",
      error: new Error("reply failed", { cause: new TypeError("fetch failed") }),
    },
  ])("does not replay a possibly accepted reply after $label", async ({ error }) => {
    const onReplyError = vi.fn();
    const replyMessageLine = vi.fn(async () => {
      throw error;
    });
    const { pushMessagesLine } = createDeps({
      replyMessageLine: replyMessageLine as LineAutoReplyDeps["replyMessageLine"],
    });

    await expect(
      deliverLineAutoReply({
        ...baseDeliveryParams,
        payload: { text: "do not duplicate this reply" },
        lineData: {},
        onReplyError,
      }),
    ).rejects.toBe(error);
    expect(replyMessageLine).toHaveBeenCalledOnce();
    expect(onReplyError).not.toHaveBeenCalled();
    expect(pushMessagesLine).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "a wrapped DNS failure before request dispatch",
      error: new TypeError("fetch failed", {
        cause: Object.assign(new Error("getaddrinfo failed"), { code: "ENOTFOUND" }),
      }),
    },
  ])("keeps the push fallback after $label", async ({ error }) => {
    const onReplyError = vi.fn();
    const replyMessageLine = vi.fn(async () => {
      throw error;
    });
    const { pushMessagesLine } = createDeps({
      replyMessageLine: replyMessageLine as LineAutoReplyDeps["replyMessageLine"],
    });

    await expect(
      deliverLineAutoReply({
        ...baseDeliveryParams,
        payload: { text: "preserve the reply" },
        lineData: {},
        onReplyError,
      }),
    ).resolves.toMatchObject({
      status: "delivered",
      replyTokenUsed: true,
      visibleReplySent: true,
    });
    expect(replyMessageLine).toHaveBeenCalledOnce();
    expect(onReplyError).toHaveBeenCalledExactlyOnceWith(error);
    expect(pushMessagesLine).toHaveBeenCalledExactlyOnceWith(
      "line:user:1",
      [{ type: "text", text: "preserve the reply" }],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });

  it("does not replay an accepted reply after local bookkeeping fails", async () => {
    const acceptedError = createChannelPartialDeliveryError(
      new Error("activity store unavailable"),
      { messageIds: ["line-reply-final"], visibleReplySent: true },
    );
    const replyMessageLine = vi.fn(async () => {
      throw acceptedError;
    });
    const onReplyError = vi.fn();
    const { pushMessagesLine } = createDeps({
      replyMessageLine: replyMessageLine as LineAutoReplyDeps["replyMessageLine"],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "already delivered" },
      lineData: {},
      onReplyError,
    });

    expect(result).toMatchObject({
      status: "partial",
      replyTokenUsed: true,
      visibleReplySent: true,
      error: acceptedError,
    });
    expect(replyMessageLine).toHaveBeenCalledOnce();
    expect(onReplyError).not.toHaveBeenCalled();
    expect(pushMessagesLine).not.toHaveBeenCalled();
  });

  it("does not replay a successful reply when its provider response cannot be parsed", async () => {
    const acceptedError = createChannelPartialDeliveryError(
      new SyntaxError("Unexpected end of JSON input"),
      { messageIds: [], visibleReplySent: true },
    );
    const onReplyError = vi.fn();
    const replyMessageLine = vi.fn(async () => {
      throw acceptedError;
    });
    const { pushMessagesLine } = createDeps({
      replyMessageLine: replyMessageLine as LineAutoReplyDeps["replyMessageLine"],
    });

    await expect(
      deliverLineAutoReply({
        ...baseDeliveryParams,
        payload: { text: "accepted despite its malformed receipt" },
        lineData: {},
        onReplyError,
      }),
    ).resolves.toMatchObject({
      status: "partial",
      replyTokenUsed: true,
      visibleReplySent: true,
      error: acceptedError,
    });
    expect(replyMessageLine).toHaveBeenCalledOnce();
    expect(onReplyError).not.toHaveBeenCalled();
    expect(pushMessagesLine).not.toHaveBeenCalled();
  });

  it("preserves a provider-accepted push when local bookkeeping fails", async () => {
    const acceptedError = createChannelPartialDeliveryError(
      new Error("activity store unavailable"),
      { messageIds: ["line-push-final"], visibleReplySent: true },
    );
    const pushMessagesLine = vi.fn(async () => {
      throw acceptedError;
    });
    const { replyMessageLine } = createDeps({
      pushMessagesLine: pushMessagesLine as LineAutoReplyDeps["pushMessagesLine"],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      replyToken: undefined,
      payload: { text: "already delivered" },
      lineData: {},
    });

    expect(result).toMatchObject({
      status: "partial",
      replyTokenUsed: false,
      visibleReplySent: true,
      error: acceptedError,
    });
    expect(pushMessagesLine).toHaveBeenCalledOnce();
    expect(replyMessageLine).not.toHaveBeenCalled();
  });

  it("does not retry a mixed push after a quota failure", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
      quickReplies: ["A"],
    };
    const quotaError = new HTTPFetchError("429 - Too Many Requests", {
      status: 429,
      statusText: "Too Many Requests",
      headers: new Headers(),
      body: "quota exceeded",
    });
    const pushMessagesLine = vi.fn(async () => {
      throw quotaError;
    });
    createDeps({
      pushMessagesLine: pushMessagesLine as LineAutoReplyDeps["pushMessagesLine"],
    });

    await expect(
      deliverLineAutoReply({
        ...baseDeliveryParams,
        replyToken: undefined,
        payload: { text: "Choose one", channelData: { line: lineData } },
        lineData,
      }),
    ).rejects.toBe(quotaError);
    expect(pushMessagesLine).toHaveBeenCalledTimes(1);
  });

  it("does not recover text after an ambiguous push ends in a rejection", async () => {
    vi.useFakeTimers();
    let ambiguousFailure: unknown;
    try {
      let attempt = 0;
      const failurePromise = runLinePushWithRetries(async () => {
        attempt += 1;
        throw attempt === 1
          ? Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })
          : createHttpError(400);
      }, "line:push").catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      ambiguousFailure = await failurePromise;
    } finally {
      vi.useRealTimers();
    }

    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
    };
    const pushMessagesLine = vi.fn(async () => {
      throw ambiguousFailure;
    });
    createDeps({
      pushMessagesLine: pushMessagesLine as LineAutoReplyDeps["pushMessagesLine"],
    });

    await expect(
      deliverLineAutoReply({
        ...baseDeliveryParams,
        replyToken: undefined,
        payload: { text: "do not duplicate", channelData: { line: lineData } },
        lineData,
      }),
    ).rejects.toBe(ambiguousFailure);
    expect(pushMessagesLine).toHaveBeenCalledOnce();
  });

  it("recovers quick replies from a rejected rich-only push", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
      quickReplies: ["A"],
    };
    const pushMessagesLine = vi.fn(async (_to: string, messages: messagingApi.Message[]) => {
      if (messages[0]?.type === "flex") {
        throw createRichRejection();
      }
      return lineResult("push", "u1");
    });
    createDeps({
      pushMessagesLine: pushMessagesLine as LineAutoReplyDeps["pushMessagesLine"],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      replyToken: undefined,
      payload: { channelData: { line: lineData } },
      lineData,
    });

    expect(result).toMatchObject({ status: "partial", visibleReplySent: true });
    expect(pushMessagesLine).toHaveBeenNthCalledWith(
      2,
      "line:user:1",
      [{ type: "text", text: "Options:\n- A", quickReply: createQuickReply("A") }],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });

  it("retries only text from the failed mixed overflow batch", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
    };
    const chunks = ["c1", "c2", "c3", "c4", "c5", "c6"];
    const pushMessagesLine = createRejectRichBatch();
    createDeps({
      chunkMarkdownText: () => chunks,
      pushMessagesLine: pushMessagesLine as LineAutoReplyDeps["pushMessagesLine"],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      replyToken: undefined,
      payload: { text: "six chunks", channelData: { line: lineData } },
      lineData,
    });

    expect(result).toMatchObject({ status: "partial", visibleReplySent: true });
    expect(pushMessagesLine).toHaveBeenNthCalledWith(
      1,
      "line:user:1",
      chunks.slice(0, 5).map((text) => ({ type: "text", text })),
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).toHaveBeenNthCalledWith(
      2,
      "line:user:1",
      [{ type: "text", text: "c6" }, createFlexMessage("Card", { type: "bubble" })],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).toHaveBeenNthCalledWith(
      3,
      "line:user:1",
      [{ type: "text", text: "c6" }],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });

  it("recovers text after definitive reply and push rejections", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
    };
    const replyMessageLine = vi.fn(async () => {
      throw createRichRejection();
    });
    const pushMessagesLine = createRejectRichBatch();
    createDeps({
      replyMessageLine: replyMessageLine as LineAutoReplyDeps["replyMessageLine"],
      pushMessagesLine: pushMessagesLine as LineAutoReplyDeps["pushMessagesLine"],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "hello", channelData: { line: lineData } },
      lineData,
    });

    expect(result).toMatchObject({
      status: "partial",
      replyTokenUsed: true,
      visibleReplySent: true,
    });
    expect(pushMessagesLine).toHaveBeenNthCalledWith(
      2,
      "line:user:1",
      [{ type: "text", text: "hello" }],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });

  it("recovers only unattempted overflow after an ambiguous reply failure", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
      quickReplies: ["A"],
    };
    const chunks = ["c1", "c2", "c3", "c4", "c5", "c6"];
    const replyMessageLine = vi.fn(async () => {
      throw new Error("reply transport failed");
    });
    const pushMessagesLine = createRejectRichBatch();
    createDeps({
      chunkMarkdownText: () => chunks,
      replyMessageLine: replyMessageLine as LineAutoReplyDeps["replyMessageLine"],
      pushMessagesLine: pushMessagesLine as LineAutoReplyDeps["pushMessagesLine"],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "six chunks", channelData: { line: lineData } },
      lineData,
    });

    expect(result).toMatchObject({
      status: "partial",
      replyTokenUsed: true,
      visibleReplySent: true,
    });
    expect(pushMessagesLine).toHaveBeenNthCalledWith(
      1,
      "line:user:1",
      [
        createFlexMessage("Card", { type: "bubble" }),
        ...chunks.slice(0, 4).map((text) => ({ type: "text", text })),
      ],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).toHaveBeenNthCalledWith(
      2,
      "line:user:1",
      [
        { type: "text", text: "c5" },
        { type: "text", text: "c6", quickReply: createQuickReply("A") },
      ],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });

  it("retries text and quick replies from the unattempted push tail", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
      quickReplies: ["A"],
    };
    const chunks = ["c1", "c2", "c3", "c4", "c5", "c6"];
    const pushMessagesLine = createRejectRichBatch();
    createDeps({
      chunkMarkdownText: () => chunks,
      pushMessagesLine: pushMessagesLine as LineAutoReplyDeps["pushMessagesLine"],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      replyToken: undefined,
      payload: { text: "six chunks", channelData: { line: lineData } },
      lineData,
    });

    expect(result).toMatchObject({ status: "partial", visibleReplySent: true });
    expect(pushMessagesLine).toHaveBeenNthCalledWith(
      1,
      "line:user:1",
      [
        createFlexMessage("Card", { type: "bubble" }),
        ...chunks.slice(0, 4).map((text) => ({ type: "text", text })),
      ],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).toHaveBeenNthCalledWith(
      2,
      "line:user:1",
      chunks.slice(0, 5).map((text) => ({ type: "text", text })),
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).toHaveBeenNthCalledWith(
      3,
      "line:user:1",
      [{ type: "text", text: "c6", quickReply: createQuickReply("A") }],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });
});
