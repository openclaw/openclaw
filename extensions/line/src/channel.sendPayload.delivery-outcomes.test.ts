import { HTTPFetchError } from "@line/bot-sdk";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { createRuntime, lineResult } from "./channel.sendPayload.test-support.js";
import { lineOutboundAdapter } from "./outbound.js";
import {
  createPendingLineResponse,
  LINE_QUOTA_ACCOUNT,
  stubLineApiFetch,
} from "./probe.test-support.js";
import { setLineRuntime } from "./runtime.js";

const ssrfMocks = vi.hoisted(() => ({
  resolvePinnedHostnameWithPolicy: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  resolvePinnedHostnameWithPolicy: ssrfMocks.resolvePinnedHostnameWithPolicy,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  ssrfMocks.resolvePinnedHostnameWithPolicy.mockReset();
});

describe("line outbound delivery outcomes", () => {
  it.each([
    { status: 400, retryable: false },
    { status: 429, retryable: true },
  ])("reports an initial LINE $status as a non-dispatch", async ({ status, retryable }) => {
    const { runtime, mocks } = createRuntime();
    const rejection = new HTTPFetchError(`${status} - provider rejection`, {
      status,
      statusText: "provider rejection",
      headers: new Headers(),
      body: "provider rejection",
    });
    mocks.pushMessageLine.mockRejectedValueOnce(rejection);
    setLineRuntime(runtime);

    await expect(
      lineOutboundAdapter.sendPayload!({
        to: "line:user:U123",
        text: "hello",
        payload: { text: "hello" },
        accountId: "default",
        cfg: { channels: { line: {} } } as OpenClawConfig,
      }),
    ).rejects.toMatchObject({
      name: "PlatformMessageNotDispatchedError",
      retryable,
      cause: rejection,
    });
  });

  it.each([
    {
      label: "settles and names the allowance when it is used up",
      quota: { type: "limited", value: 200 },
      used: 200,
      retryable: false,
      reason: "200/200 monthly messages used",
    },
    {
      label: "settles when reported usage has passed the allowance",
      quota: { type: "limited", value: 200 },
      used: 201,
      retryable: false,
      reason: "201/200 monthly messages used",
    },
    {
      label: "stays retryable when the reported allowance is fractional",
      quota: { type: "limited", value: 200.5 },
      used: 201,
      retryable: true,
      reason: "429 - Too Many Requests",
      expectedQuotaRequests: 1,
    },
    {
      label: "stays retryable when the reported usage is fractional",
      quota: { type: "limited", value: 200 },
      used: 200.5,
      retryable: true,
      reason: "429 - Too Many Requests",
      expectedQuotaRequests: 2,
    },
    {
      label: "stays retryable while the allowance still has room",
      quota: { type: "limited", value: 200 },
      used: 12,
      retryable: true,
      reason: "429 - Too Many Requests",
    },
    {
      label: "stays retryable for an unlimited plan",
      quota: { type: "none" },
      used: undefined,
      retryable: true,
      reason: "429 - Too Many Requests",
    },
    {
      label: "stays retryable when the allowance cannot be read",
      quota: undefined,
      used: undefined,
      retryable: true,
      reason: "429 - Too Many Requests",
    },
  ])("$label", async ({ quota, used, retryable, reason, expectedQuotaRequests }) => {
    const { runtime, mocks } = createRuntime();
    const rejection = new HTTPFetchError("429 - Too Many Requests", {
      status: 429,
      statusText: "Too Many Requests",
      headers: new Headers(),
      body: JSON.stringify({ message: "You have reached your monthly limit." }),
    });
    mocks.pushMessageLine.mockRejectedValueOnce(rejection);
    const fetchMock = stubLineApiFetch(
      quota ? Response.json(quota) : Response.json({ message: "unavailable" }, { status: 503 }),
      ...(used === undefined ? [] : [Response.json({ totalUsage: used })]),
    );
    setLineRuntime(runtime);

    const delivered = lineOutboundAdapter.sendPayload!({
      to: "line:user:U123",
      text: "hello",
      payload: { text: "hello" },
      ...LINE_QUOTA_ACCOUNT,
    });
    await expect(delivered).rejects.toMatchObject({
      name: "PlatformMessageNotDispatchedError",
      cause: rejection,
    });
    expect(mocks.pushMessageLine).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.map(([input]) => resolveRequestUrl(input))[0]).toBe(
      "https://api.line.me/v2/bot/message/quota",
    );
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer quota-test-token",
    );
    await expect(delivered).rejects.toMatchObject({
      retryable,
      message: expect.stringContaining(reason),
    });
    expect(fetchMock).toHaveBeenCalledTimes(expectedQuotaRequests ?? (used === undefined ? 1 : 2));
  });

  it("keeps a stalled allowance from holding back a retryable refusal", async () => {
    vi.useFakeTimers();
    const pending = createPendingLineResponse({ type: "none" });
    const fetchMock = stubLineApiFetch(pending.response);
    let delivered: Promise<unknown> | undefined;
    try {
      const { runtime, mocks } = createRuntime();
      const rejection = new HTTPFetchError("429 - Too Many Requests", {
        status: 429,
        statusText: "Too Many Requests",
        headers: new Headers(),
        body: JSON.stringify({ message: "You have reached your monthly limit." }),
      });
      mocks.pushMessageLine.mockRejectedValueOnce(rejection);
      setLineRuntime(runtime);

      delivered = lineOutboundAdapter.sendPayload!({
        to: "line:user:U123",
        text: "hello",
        payload: { text: "hello" },
        ...LINE_QUOTA_ACCOUNT,
      });
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

  it("keeps accepted media receipts without reading quota for a later batch refusal", async () => {
    const { runtime, mocks } = createRuntime();
    const rejection = new HTTPFetchError("429 - provider rejection", {
      status: 429,
      statusText: "provider rejection",
      headers: new Headers(),
      body: "provider rejection",
    });
    const onDeliveryResult = vi.fn();
    mocks.pushMessagesLine
      .mockResolvedValueOnce(lineResult("m-media"))
      .mockRejectedValueOnce(rejection);
    const fetchMock = stubLineApiFetch(
      Response.json({ type: "limited", value: 200 }),
      Response.json({ totalUsage: 200 }),
    );
    setLineRuntime(runtime);

    await expect(
      lineOutboundAdapter.sendPayload!({
        to: "line:user:U123",
        text: "Caption",
        payload: {
          text: "Caption",
          mediaUrls: Array.from(
            { length: 5 },
            (_, index) => `https://example.com/image-${index}.jpg`,
          ),
          channelData: { line: { quickReplies: ["Continue"] } },
        },
        ...LINE_QUOTA_ACCOUNT,
        onDeliveryResult,
      }),
    ).rejects.toBe(rejection);

    expect(mocks.pushMessagesLine).toHaveBeenCalledTimes(2);
    expect(mocks.sendMessageLine).not.toHaveBeenCalled();
    expect(mocks.pushTextMessageWithQuickReplies).not.toHaveBeenCalled();
    expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channel: "line",
        messageId: "m-media",
        receipt: expect.objectContaining({ platformMessageIds: ["m-media"] }),
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves partial delivery evidence with a nested LINE rejection", async () => {
    const { runtime, mocks } = createRuntime();
    const rejection = new HTTPFetchError("400 - provider rejection", {
      status: 400,
      statusText: "provider rejection",
      headers: new Headers(),
      body: "provider rejection",
    });
    const partial = createChannelPartialDeliveryError(rejection, {
      messageIds: ["accepted-first"],
      visibleReplySent: true,
    });
    mocks.pushMessageLine.mockRejectedValueOnce(partial);
    setLineRuntime(runtime);

    await expect(
      lineOutboundAdapter.sendPayload!({
        to: "line:user:U123",
        text: "hello",
        payload: { text: "hello" },
        accountId: "default",
        cfg: { channels: { line: {} } } as OpenClawConfig,
      }),
    ).rejects.toBe(partial);
  });

  it("preserves valid mixed parts when media preparation fails", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    let caught: unknown;
    try {
      await lineOutboundAdapter.sendPayload!({
        to: "line:user:media-failure",
        text: "Caption",
        payload: {
          text: "Caption",
          mediaUrl: "http://example.com/image.jpg",
          channelData: {
            line: {
              flexMessage: { altText: "Card", contents: { type: "bubble" } },
            },
          },
        },
        accountId: "default",
        cfg,
      });
    } catch (error) {
      caught = error;
    }

    expect(isChannelPartialDeliveryError(caught)).toBe(true);
    expect(mocks.pushMessagesLine).toHaveBeenCalledOnce();
    expect(mocks.pushMessagesLine).toHaveBeenCalledWith(
      "line:user:media-failure",
      [
        { type: "flex", altText: "Card", contents: { type: "bubble" } },
        { type: "text", text: "Caption" },
      ],
      expect.any(Object),
    );
    if (!isChannelPartialDeliveryError(caught)) {
      throw new Error("expected a partial LINE delivery error");
    }
    expect(caught.deliveryResult).toMatchObject({
      messageIds: ["m-batch"],
      visibleReplySent: true,
    });
  });

  it("recovers text after a definitive mixed-batch rejection", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;
    const rejection = new HTTPFetchError("400 - invalid rich message", {
      status: 400,
      statusText: "Bad Request",
      headers: new Headers(),
      body: "invalid rich message",
    });
    mocks.pushMessagesLine
      .mockRejectedValueOnce(rejection)
      .mockResolvedValueOnce(lineResult("m-text-recovered"));

    let caught: unknown;
    try {
      await lineOutboundAdapter.sendPayload!({
        to: "line:user:rejected-batch",
        text: "Caption",
        payload: {
          text: "Caption",
          channelData: {
            line: {
              flexMessage: { altText: "Invalid card", contents: { type: "bubble" } },
            },
          },
        },
        accountId: "default",
        cfg,
      });
    } catch (error) {
      caught = error;
    }

    expect(isChannelPartialDeliveryError(caught)).toBe(true);
    expect(mocks.pushMessagesLine).toHaveBeenNthCalledWith(
      1,
      "line:user:rejected-batch",
      [
        { type: "flex", altText: "Invalid card", contents: { type: "bubble" } },
        { type: "text", text: "Caption" },
      ],
      expect.any(Object),
    );
    expect(mocks.pushMessagesLine).toHaveBeenNthCalledWith(
      2,
      "line:user:rejected-batch",
      [{ type: "text", text: "Caption" }],
      expect.any(Object),
    );
    if (!isChannelPartialDeliveryError(caught)) {
      throw new Error("expected a partial LINE delivery error");
    }
    expect(caught.deliveryResult).toMatchObject({
      messageIds: ["m-text-recovered"],
      visibleReplySent: true,
    });
  });

  it("preserves accepted fallback evidence when its receipt is unreadable", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;
    const rejection = new HTTPFetchError("400 - invalid rich message", {
      status: 400,
      statusText: "Bad Request",
      headers: new Headers(),
      body: "invalid rich message",
    });
    const fallbackAccepted = createChannelPartialDeliveryError(
      new Error("accepted response body could not be parsed"),
      { messageIds: ["m-text-accepted"], visibleReplySent: true },
    );
    mocks.pushMessagesLine.mockRejectedValueOnce(rejection).mockRejectedValueOnce(fallbackAccepted);

    await expect(
      lineOutboundAdapter.sendPayload!({
        to: "line:user:accepted-fallback",
        text: "Caption",
        payload: {
          text: "Caption",
          channelData: {
            line: {
              flexMessage: { altText: "Invalid card", contents: { type: "bubble" } },
            },
          },
        },
        accountId: "default",
        cfg,
      }),
    ).rejects.toBe(fallbackAccepted);
  });

  it("preserves an ambiguous fallback transport failure", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;
    const rejection = new HTTPFetchError("400 - invalid rich message", {
      status: 400,
      statusText: "Bad Request",
      headers: new Headers(),
      body: "invalid rich message",
    });
    const fallbackAmbiguous = new Error("connection closed after fallback request");
    mocks.pushMessagesLine
      .mockRejectedValueOnce(rejection)
      .mockRejectedValueOnce(fallbackAmbiguous);

    await expect(
      lineOutboundAdapter.sendPayload!({
        to: "line:user:ambiguous-fallback",
        text: "Caption",
        payload: {
          text: "Caption",
          channelData: {
            line: {
              flexMessage: { altText: "Invalid card", contents: { type: "bubble" } },
            },
          },
        },
        accountId: "default",
        cfg,
      }),
    ).rejects.toBe(fallbackAmbiguous);
  });
});
