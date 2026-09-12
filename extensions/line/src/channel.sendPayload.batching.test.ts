// Line tests cover outbound request batching plugin behavior.
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { chunkMarkdownText as chunkMarkdownTextForLine } from "openclaw/plugin-sdk/reply-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import {
  createCredentialBearingHttpUrl,
  createRuntime,
  sentMessages,
} from "./channel.sendPayload.test-support.js";
import { lineOutboundAdapter } from "./outbound.js";
import { setLineRuntime } from "./runtime.js";
import { createLineSendReceipt } from "./send-receipt.js";

const ssrfMocks = vi.hoisted(() => ({
  resolvePinnedHostnameWithPolicy: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  resolvePinnedHostnameWithPolicy: ssrfMocks.resolvePinnedHostnameWithPolicy,
}));

beforeEach(() => {
  vi.setSystemTime(1_800_000_000_000);
  ssrfMocks.resolvePinnedHostnameWithPolicy.mockReset();
  ssrfMocks.resolvePinnedHostnameWithPolicy.mockResolvedValue({
    hostname: "example.com",
    addresses: ["93.184.216.34"],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// LINE counts one message per request per recipient whatever the request
// carries, so what a reply costs is the number of requests it takes.
describe("line outbound request batching", () => {
  it("spends one monthly message on a card, its text, and its media", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    mocks.resolveTextChunkLimit.mockReturnValue(5000);
    mocks.chunkMarkdownText.mockImplementation((text: string) =>
      chunkMarkdownTextForLine(text, 5000),
    );
    const cfg = { channels: { line: {} } } as OpenClawConfig;
    const text = "Before\n\n| Name | Value |\n|---|---|\n| Item | one |\n\nAfter";

    await lineOutboundAdapter.sendPayload!({
      to: "line:user:U123",
      text,
      payload: { text, mediaUrl: "https://example.com/photo.png" },
      accountId: "default",
      cfg,
    });

    // LINE bills the request, not the message objects it carries, so a reply
    // made of four parts must not spend four of the account's monthly messages.
    expect(mocks.pushMessagesLine).toHaveBeenCalledOnce();
    expect(sentMessages(mocks).map((message) => message.type)).toEqual([
      "text",
      "flex",
      "text",
      "image",
    ]);
  });

  it("delivers the text a rejected media URL came with, and still surfaces the rejection", async () => {
    // Media is built before the first request now, so a URL LINE will not carry
    // must not take the words and buttons that travelled with it.
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    const failure = await lineOutboundAdapter.sendPayload!({
      to: "line:user:U123",
      text: "Here is the chart.",
      payload: {
        text: "Here is the chart.",
        mediaUrl: createCredentialBearingHttpUrl(),
        channelData: { line: { quickReplies: ["Continue"] } },
      },
      accountId: "default",
      cfg,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    const cause = failure instanceof Error ? failure.cause : undefined;

    expect(isChannelPartialDeliveryError(failure)).toBe(true);
    expect(String(cause)).toContain("must use HTTPS");
    expect(mocks.pushMessagesLine).toHaveBeenCalledExactlyOnceWith(
      "line:user:U123",
      [
        {
          type: "text",
          text: "Here is the chart.",
          quickReply: { items: ["Continue"] },
        },
      ],
      { verbose: false, accountId: "default", cfg },
    );
  });

  it("keeps the media LINE will carry when a sibling URL is refused", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    const failure = await lineOutboundAdapter.sendPayload!({
      to: "line:user:U123",
      text: "Two charts.",
      payload: {
        text: "Two charts.",
        mediaUrls: [createCredentialBearingHttpUrl(), "https://example.com/second.png"],
      },
      accountId: "default",
      cfg,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    const cause = failure instanceof Error ? failure.cause : undefined;

    // One refused URL must not take the other media or the text with it, and the
    // failure has to carry the evidence that part of the reply is already visible.
    expect(sentMessages(mocks)).toEqual([
      { type: "text", text: "Two charts." },
      {
        type: "image",
        originalContentUrl: "https://example.com/second.png",
        previewImageUrl: "https://example.com/second.png",
      },
    ]);
    expect(isChannelPartialDeliveryError(failure)).toBe(true);
    if (!isChannelPartialDeliveryError(failure)) {
      throw new Error("expected a partial LINE delivery error");
    }
    expect(failure.deliveryResult).toMatchObject({
      messageIds: ["m-batch", "m-batch-2"],
      visibleReplySent: true,
    });
    expect(String(cause)).toContain("must use HTTPS");
  });

  it("reports the media URL that failed first when a later one fails too", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;
    const overlongUrl = `https://example.com/${"a".repeat(2100)}.png`;

    const failure = await lineOutboundAdapter.sendPayload!({
      to: "line:user:U123",
      text: "Two broken charts.",
      payload: {
        text: "Two broken charts.",
        mediaUrls: [createCredentialBearingHttpUrl(), overlongUrl],
      },
      accountId: "default",
      cfg,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    const cause = failure instanceof Error ? failure.cause : undefined;

    // Two unusable URLs must not race for the receipt: the reply reports the one
    // that failed first, and the second neither replaces it nor ends the send.
    expect(sentMessages(mocks)).toEqual([{ type: "text", text: "Two broken charts." }]);
    expect(isChannelPartialDeliveryError(failure)).toBe(true);
    expect(String(cause)).toContain("must use HTTPS");
    expect(String(cause)).not.toContain("2000 chars");
  });

  it("names every request's messages when a later media build fails", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    mocks.resolveTextChunkLimit.mockReturnValue(5000);
    mocks.chunkMarkdownText.mockImplementation((text: string) =>
      chunkMarkdownTextForLine(text, 5000),
    );
    const cfg = { channels: { line: {} } } as OpenClawConfig;
    const card = ["```js", "card()", "```"].join("\n");
    const text = Array.from({ length: 6 }, () => card).join("\n\n");

    const failure = await lineOutboundAdapter.sendPayload!({
      to: "line:user:U123",
      text,
      payload: { text, mediaUrl: createCredentialBearingHttpUrl() },
      accountId: "default",
      cfg,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Six cards take two requests before the media failure surfaces, so the
    // evidence has to name what both of them delivered, not just the last one.
    expect(mocks.pushMessagesLine.mock.calls.map((call) => call[1].length)).toEqual([5, 1]);
    expect(isChannelPartialDeliveryError(failure)).toBe(true);
    if (!isChannelPartialDeliveryError(failure)) {
      throw new Error("expected a partial LINE delivery error");
    }
    expect(failure.deliveryResult.messageIds).toEqual([
      "m-batch",
      "m-batch-2",
      "m-batch-3",
      "m-batch-4",
      "m-batch-5",
      "m-batch-r2",
    ]);
    // Each request numbers its own parts from zero; merged evidence has to name
    // a position in the payload, not repeat 0 once per request.
    expect(failure.deliveryResult.receipt?.parts.map((part) => part.index)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
  });

  it("sends nothing more once the first request is refused", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    mocks.resolveTextChunkLimit.mockReturnValue(5000);
    mocks.chunkMarkdownText.mockImplementation((text: string) =>
      chunkMarkdownTextForLine(text, 5000),
    );
    const cfg = { channels: { line: {} } } as OpenClawConfig;
    const card = ["```js", "card()", "```"].join("\n");
    const text = Array.from({ length: 6 }, () => card).join("\n\n");
    mocks.pushMessagesLine.mockRejectedValueOnce(new Error("LINE refused the first batch"));

    await expect(
      lineOutboundAdapter.sendPayload!({
        to: "line:user:U123",
        text,
        payload: { text },
        accountId: "default",
        cfg,
      }),
    ).rejects.toThrow("LINE refused the first batch");

    // A refusal ends the payload: the parts queued behind it never reach LINE,
    // which is what the reply costs when its first request is the one refused.
    expect(mocks.pushMessagesLine).toHaveBeenCalledOnce();
  });

  it("keeps the earlier requests when the failure carries delivery evidence of its own", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    mocks.resolveTextChunkLimit.mockReturnValue(5000);
    mocks.chunkMarkdownText.mockImplementation((text: string) =>
      chunkMarkdownTextForLine(text, 5000),
    );
    const cfg = { channels: { line: {} } } as OpenClawConfig;
    const card = ["```js", "card()", "```"].join("\n");
    const text = Array.from({ length: 6 }, () => card).join("\n\n");
    // LINE accepted the second request and its receipt then became unreadable,
    // which the send path reports as a partial delivery of its own.
    mocks.pushMessagesLine.mockImplementationOnce(async (_to, messages) => ({
      messageId: "m-first",
      chatId: "c1",
      receipt: createLineSendReceipt({
        messageId: "m-first",
        messageIds: messages.map((_message, index) => `m-first-${index}`),
        chatId: "c1",
        kind: "text",
      }),
    }));
    mocks.pushMessagesLine.mockRejectedValueOnce(
      createChannelPartialDeliveryError(new Error("receipt unreadable"), {
        messageIds: ["m-second"],
        visibleReplySent: true,
      }),
    );

    const failure = await lineOutboundAdapter.sendPayload!({
      to: "line:user:U123",
      text,
      payload: { text },
      accountId: "default",
      cfg,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(isChannelPartialDeliveryError(failure)).toBe(true);
    if (!isChannelPartialDeliveryError(failure)) {
      throw new Error("expected a partial LINE delivery error");
    }
    expect(failure.deliveryResult.messageIds).toEqual([
      "m-first-0",
      "m-first-1",
      "m-first-2",
      "m-first-3",
      "m-first-4",
      "m-second",
    ]);
  });
});
