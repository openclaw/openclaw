// Line batch tests cover mixed provider payload behavior.
import { HTTPFetchError } from "@line/bot-sdk";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { createRuntime, lineResult } from "./channel.sendPayload.test-support.js";
import { lineOutboundAdapter } from "./outbound.js";
import { setLineRuntime } from "./runtime.js";

function refusal400() {
  return new HTTPFetchError("400 - provider rejection", {
    status: 400,
    statusText: "provider rejection",
    headers: new Headers(),
    body: "provider rejection",
  });
}

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

describe("line outbound sendPayload batches", () => {
  it("publishes a single receipt for a mixed Flex and text payload", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const result = await lineOutboundAdapter.sendText!({
      to: "line:user:U123",
      text: "```js\nfirst()\n```\n\nCaption",
      accountId: "default",
      cfg: { channels: { line: {} } } as OpenClawConfig,
    });

    expect(mocks.pushMessagesLine).toHaveBeenCalledOnce();
    expect(mocks.pushMessagesLine.mock.calls[0]?.[1]).toHaveLength(2);
    expect(result.messageId).toBe("m-batch");
  });

  it("batches a card, caption, and media into one provider request", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    await lineOutboundAdapter.sendPayload!({
      to: "line:user:batch",
      text: "Caption",
      payload: {
        text: "Caption",
        mediaUrl: "https://example.com/image.jpg",
        channelData: {
          line: {
            flexMessage: { altText: "Card", contents: { type: "bubble" } },
          },
        },
      },
      accountId: "default",
      cfg,
    });

    expect(mocks.pushMessagesLine).toHaveBeenCalledExactlyOnceWith(
      "line:user:batch",
      [
        { type: "flex", altText: "Card", contents: { type: "bubble" } },
        { type: "text", text: "Caption" },
        {
          type: "image",
          originalContentUrl: "https://example.com/image.jpg",
          previewImageUrl: "https://example.com/image.jpg",
        },
      ],
      { verbose: false, accountId: "default", cfg },
    );
  });

  it("delivers valid mixed reply parts when media preparation fails", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    const caught = await lineOutboundAdapter.sendPayload!({
      to: "line:user:media-preparation-failure",
      text: "Caption",
      payload: {
        text: "Caption",
        mediaUrl: "https://example.com/clip.mp4",
        channelData: {
          line: {
            mediaKind: "video",
            flexMessage: { altText: "Card", contents: { type: "bubble" } },
          },
        },
      },
      accountId: "default",
      cfg,
    }).catch((error: unknown) => error);

    expect(caught).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      cause: new Error("LINE video messages require previewImageUrl to reference an image URL"),
      deliveryResult: {
        messageIds: ["m-batch"],
        receipt: { platformMessageIds: ["m-batch"] },
        visibleReplySent: true,
      },
    });
    expect(mocks.pushMessagesLine).toHaveBeenCalledExactlyOnceWith(
      "line:user:media-preparation-failure",
      [
        { type: "flex", altText: "Card", contents: { type: "bubble" } },
        { type: "text", text: "Caption" },
      ],
      { verbose: false, accountId: "default", cfg },
    );
  });

  it("does not replay an accepted batch when the delivery observer throws HTTP 400", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;
    const observerFailure = refusal400();
    const onDeliveryResult = vi.fn().mockRejectedValueOnce(observerFailure);

    await expect(
      lineOutboundAdapter.sendPayload!({
        to: "line:user:observer-rejects",
        text: "```js\nfirst()\n```\n\nCaption",
        payload: { text: "```js\nfirst()\n```\n\nCaption" },
        accountId: "default",
        cfg,
        onDeliveryResult,
      }),
    ).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      cause: observerFailure,
      deliveryResult: { messageIds: ["m-batch"], visibleReplySent: true },
    });

    expect(mocks.pushMessagesLine).toHaveBeenCalledOnce();
    expect(onDeliveryResult).toHaveBeenCalledOnce();
  });

  it("keeps a later accepted partial outcome when an earlier recovery part is rejected", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;
    const acceptedWithoutReceipt = createChannelPartialDeliveryError(
      new Error("LINE accepted the message but returned unreadable receipt JSON"),
      { messageIds: [], visibleReplySent: true },
    );
    mocks.pushMessagesLine
      .mockRejectedValueOnce(refusal400())
      .mockRejectedValueOnce(refusal400())
      .mockRejectedValueOnce(acceptedWithoutReceipt);

    await expect(
      lineOutboundAdapter.sendPayload!({
        to: "line:user:partial-recovery",
        text: "```js\nfirst()\n```\n\nCaption",
        payload: { text: "```js\nfirst()\n```\n\nCaption" },
        accountId: "default",
        cfg,
      }),
    ).rejects.toBe(acceptedWithoutReceipt);

    expect(mocks.pushMessagesLine).toHaveBeenCalledTimes(3);
  });

  it("aggregates accepted receipts across success, rejection, and later recovery success", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;
    mocks.pushMessagesLine
      .mockRejectedValueOnce(refusal400())
      .mockResolvedValueOnce(lineResult("accepted-A"))
      .mockRejectedValueOnce(refusal400())
      .mockResolvedValueOnce(lineResult("accepted-C"));

    const caught = await lineOutboundAdapter.sendPayload!({
      to: "line:user:recovery-receipts",
      text: "Caption",
      payload: {
        text: "Caption",
        mediaUrl: "https://example.com/image.jpg",
        channelData: {
          line: { flexMessage: { altText: "Card", contents: { type: "bubble" } } },
        },
      },
      accountId: "default",
      cfg,
    }).catch((error: unknown) => error);

    expect(caught).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        messageIds: ["accepted-A", "accepted-C"],
        receipt: { platformMessageIds: ["accepted-A", "accepted-C"] },
        visibleReplySent: true,
      },
    });
    expect(mocks.pushMessagesLine).toHaveBeenCalledTimes(4);
    expect(mocks.pushMessagesLine.mock.calls.map(([, messages]) => messages)).toEqual([
      expect.arrayContaining([
        expect.objectContaining({ type: "flex" }),
        expect.objectContaining({ type: "text", text: "Caption" }),
        expect.objectContaining({ type: "image" }),
      ]),
      [{ type: "flex", altText: "Card", contents: { type: "bubble" } }],
      [{ type: "text", text: "Caption" }],
      [
        {
          type: "image",
          originalContentUrl: "https://example.com/image.jpg",
          previewImageUrl: "https://example.com/image.jpg",
        },
      ],
    ]);
  });

  it("recovers valid messages from a rejected later batch after prior acceptance", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;
    const rejectedBatch = refusal400();
    const rejectedImage = refusal400();
    mocks.chunkMarkdownText.mockReturnValueOnce(["First", "Second", "Third", "Fourth", "Fifth"]);
    mocks.pushMessagesLine
      .mockResolvedValueOnce(lineResult("accepted-first-batch"))
      .mockRejectedValueOnce(rejectedBatch)
      .mockResolvedValueOnce(lineResult("accepted-later-text"))
      .mockRejectedValueOnce(rejectedImage);

    const caught = await lineOutboundAdapter.sendPayload!({
      to: "line:user:later-batch-recovery",
      text: "Caption",
      payload: {
        text: "Caption",
        mediaUrl: "https://example.com/image.jpg",
        channelData: {
          line: {
            flexMessage: { altText: "Card", contents: { type: "bubble" } },
          },
        },
      },
      accountId: "default",
      cfg,
    }).catch((error: unknown) => error);

    expect(caught).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      cause: rejectedImage,
      deliveryResult: {
        messageIds: ["accepted-first-batch", "accepted-later-text"],
        receipt: { platformMessageIds: ["accepted-first-batch", "accepted-later-text"] },
        visibleReplySent: true,
      },
    });
    const batches = mocks.pushMessagesLine.mock.calls.map(([, messages]) => messages);
    expect(batches).toHaveLength(4);
    expect(batches[0]).toHaveLength(5);
    expect(batches[1]).toHaveLength(2);
    expect(batches[2]).toEqual([{ type: "text", text: "Fifth" }]);
    expect(batches[3]).toEqual([
      {
        type: "image",
        originalContentUrl: "https://example.com/image.jpg",
        previewImageUrl: "https://example.com/image.jpg",
      },
    ]);
  });

  it("merges receipt IDs from multiple partial recovery outcomes", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;
    const partialB = createChannelPartialDeliveryError(new Error("receipt B unavailable"), {
      messageIds: ["accepted-B"],
      visibleReplySent: true,
    });
    const partialC = createChannelPartialDeliveryError(new Error("receipt C unavailable"), {
      messageIds: ["accepted-C"],
      visibleReplySent: true,
    });
    mocks.pushMessagesLine
      .mockRejectedValueOnce(refusal400())
      .mockResolvedValueOnce(lineResult("accepted-A"))
      .mockRejectedValueOnce(partialB)
      .mockRejectedValueOnce(partialC);

    const caught = await lineOutboundAdapter.sendPayload!({
      to: "line:user:partial-recovery-receipts",
      text: "Caption",
      payload: {
        text: "Caption",
        mediaUrl: "https://example.com/image.jpg",
        channelData: {
          line: { flexMessage: { altText: "Card", contents: { type: "bubble" } } },
        },
      },
      accountId: "default",
      cfg,
    }).catch((error: unknown) => error);

    expect(caught).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        messageIds: ["accepted-A", "accepted-B", "accepted-C"],
        receipt: { platformMessageIds: ["accepted-A", "accepted-B", "accepted-C"] },
        visibleReplySent: true,
      },
    });
    expect(
      (
        caught as {
          deliveryResult: { receipt: { parts: Array<{ platformMessageId: string }> } };
        }
      ).deliveryResult.receipt.parts.map((part) => part.platformMessageId),
    ).toEqual(["accepted-A", "accepted-B", "accepted-C"]);
    expect(mocks.pushMessagesLine).toHaveBeenCalledTimes(4);
  });
});
