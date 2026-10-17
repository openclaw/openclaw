import { expectDefined } from "@openclaw/normalization-core";
import { chunkMarkdownText } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import { deliverLineAutoReply } from "./auto-reply-delivery.js";
import {
  baseDeliveryParams,
  createDeps,
  createQuickReply,
  createImageMessage,
  LINE_TEST_CFG,
  type LineAutoReplyDeps,
} from "./auto-reply-delivery.test-helpers.js";
import { processLineMessage as processOrderedLineMessage } from "./markdown-to-line.js";
import { prepareLineReplyPayload } from "./rich-messages.js";
import { createLocationMessage as createRealLocationMessage } from "./send.js";
import { buildTemplateMessageFromPayload } from "./template-messages.js";

const replyOptions = { cfg: LINE_TEST_CFG, accountId: "acc" };
const replyArgs = (messages: unknown[]) => ["token", messages, replyOptions] as const;

type DeliveryParams = Parameters<typeof deliverLineAutoReply>[0];
function deliver(
  payload: DeliveryParams["payload"],
  lineData: DeliveryParams["lineData"] = {},
  overrides: Partial<DeliveryParams> = {},
) {
  return deliverLineAutoReply({ ...baseDeliveryParams, payload, lineData, ...overrides });
}
function deliverMedia(url: string, lineData: DeliveryParams["lineData"] = {}, text?: string) {
  return deliver(
    { mediaUrls: [url], channelData: { line: lineData }, ...(text ? { text } : {}) },
    lineData,
  );
}
const createMediaDeps = (overrides: Partial<LineAutoReplyDeps> = {}) =>
  createDeps({ processLineMessage: () => [], chunkMarkdownText: () => [], ...overrides });
const createOrderedDeps = () =>
  createDeps({ processLineMessage: processOrderedLineMessage, chunkMarkdownText });

describe("deliverLineAutoReply", () => {
  // Empty carousels must not take down the accompanying text.
  it("still sends the reply text when a carousel carries nothing to render", async () => {
    const { replyMessageLine } = createDeps({ buildTemplateMessageFromPayload });

    await deliver({ text: "After" }, { templateMessage: { type: "carousel", columns: [] } });

    const messages = expectDefined(replyMessageLine.mock.calls[0]?.[1], "LINE reply messages");
    expect(
      messages.map((message) => (message.type === "text" ? message.text : message.type)),
    ).toEqual(["After"]);
  });

  it("keeps quick replies on final media when ordered cards overflow the reply token", async () => {
    const lineData = { quickReplies: ["Continue"] };
    const { replyMessageLine, pushMessagesLine } = createOrderedDeps();

    await deliver(
      {
        text: Array.from({ length: 6 }, (_, index) => `\`\`\`js\ncard${index}()\n\`\`\``).join(
          "\n\n",
        ),
        mediaUrls: ["https://example.com/image.jpg"],
      },
      lineData,
    );

    expect(replyMessageLine.mock.calls[0]?.[1].map((message) => message.type)).toEqual(
      Array(5).fill("flex"),
    );
    expect(pushMessagesLine.mock.calls[0]?.[1]).toMatchObject([
      { type: "flex", altText: "Code" },
      {
        type: "image",
        originalContentUrl: "https://example.com/image.jpg",
        quickReply: createQuickReply("Continue"),
      },
    ]);
  });

  it("keeps oversized Markdown tables in source order with final quick replies", async () => {
    const quickReplies = ["Continue"];
    const { replyMessageLine, pushMessagesLine } = createOrderedDeps();
    const markdown = `First\n\n| Small | Value |\n|---|---|\n| Kept | card |\n\nBetween\n\n| Name | Value |\n|---|---|\n| Large | ${"x".repeat(30_000)} |\n\nAfter\n\n\`\`\`js\nconsole.log("still a card")\n\`\`\``;

    await deliver({ text: markdown }, { quickReplies });

    const calls = [replyMessageLine, pushMessagesLine]
      .flatMap((mock) =>
        mock.mock.calls.map((args, index) => ({
          position: expectDefined(mock.mock.invocationCallOrder[index], "LINE delivery call order"),
          messages: args[1],
        })),
      )
      .toSorted((left, right) => left.position - right.position);
    const sequence = calls
      .flatMap((call) => call.messages)
      .map((message) =>
        message.type === "flex"
          ? message.altText === "Code"
            ? "code-card"
            : "valid-table-card"
          : message.type === "text" && message.text.includes("Large")
            ? "oversized-table-text"
            : undefined,
      )
      .filter(Boolean);

    expect(sequence).toEqual(["valid-table-card", "oversized-table-text", "code-card"]);
    expect(calls.every((call) => call.messages.length <= 5)).toBe(true);
    expect(replyMessageLine).toHaveBeenCalledOnce();
    expect(pushMessagesLine.mock.calls.length).toBeGreaterThan(0);
    const messages = calls.flatMap((call) => call.messages);
    expect(messages.at(-1)).toMatchObject({
      type: "flex",
      altText: "Code",
      quickReply: createQuickReply(...quickReplies),
    });
    expect(messages.slice(0, -1).every((message) => !("quickReply" in message))).toBe(true);
  });

  it("delivers the question with the options when only quick replies render", async () => {
    const prepared = await prepareLineReplyPayload({
      text: "Agent needs input:\n1. Alpha",
      presentationTextMode: "fallback",
      presentation: {
        blocks: [
          {
            type: "select",
            options: [{ label: "Alpha", action: { type: "callback", value: "alpha" } }],
          },
        ],
      },
    });
    const lineData = expectDefined(
      prepared.channelData?.line as Record<string, unknown> | undefined,
      "prepared LINE channel data",
    );
    const { replyMessageLine } = createDeps();

    await deliver(prepared, lineData);

    expect(replyMessageLine.mock.calls[0]?.[1]).toMatchObject([
      { type: "text", text: "Agent needs input:\n1. Alpha" },
    ]);
  });

  it("delivers whatever the location builder returns, including its text degradation", async () => {
    const lineData = {
      location: { title: "Meet here", address: " ", latitude: 35.6895, longitude: 139.6917 },
    };
    const degraded = { type: "text" as const, text: "Meet here\n35.6895, 139.6917" };
    const createLocationMessage = vi.fn(createRealLocationMessage);
    const { replyMessageLine } = createDeps({ createLocationMessage });

    const result = await deliver(
      { text: "Meet me there.", channelData: { line: lineData } },
      lineData,
    );

    expect(replyMessageLine).toHaveBeenCalledExactlyOnceWith(
      ...replyArgs([{ type: "text", text: "Meet me there." }, degraded]),
    );
    expect(createLocationMessage).toHaveBeenCalledOnce();
    expect(result.visibleReplySent).toBe(true);
  });

  it("keeps media on the reply token alongside text", async () => {
    const { replyMessageLine, pushMessagesLine } = createDeps();

    const result = await deliver({
      text: "here you go",
      mediaUrls: ["https://example.com/chart.png"],
    });

    expect(result.status).toBe("delivered");
    expect(replyMessageLine).toHaveBeenCalledExactlyOnceWith(
      ...replyArgs([
        { type: "text", text: "here you go" },
        createImageMessage("https://example.com/chart.png"),
      ]),
    );
    expect(pushMessagesLine).not.toHaveBeenCalled();
  });

  it("sanitizes internal traces on the inbound auto-reply path", async () => {
    const processLineMessage = vi.fn((text: string) => [{ type: "text" as const, text }]);
    const { replyMessageLine } = createDeps({ processLineMessage });
    const text = [
      "Done.",
      '<tool_call>{"name":"read","arguments":{"path":"secret"}}</tool_call>',
      "⚠️ 🛠️ `search repos (agent)` failed",
    ].join("\n");

    const result = await deliver({ text });

    expect(processLineMessage).toHaveBeenCalledWith("Done.");
    expect(replyMessageLine).toHaveBeenCalledWith("token", [{ type: "text", text: "Done." }], {
      cfg: LINE_TEST_CFG,
      accountId: "acc",
    });
    expect(result).toEqual({ status: "delivered", replyTokenUsed: true, visibleReplySent: true });
  });

  it("uses fallback text for quick-reply-only payloads", async () => {
    const lineData = { quickReplies: ["A", "B"] };
    const { replyMessageLine, pushMessagesLine } = createDeps();

    const result = await deliver({ text: "", channelData: { line: lineData } }, lineData);

    expect(result.replyTokenUsed).toBe(true);
    expect(replyMessageLine).toHaveBeenCalledWith(
      ...replyArgs([
        {
          type: "text",
          text: "Options:\n- A\n- B",
          quickReply: createQuickReply("A", "B"),
        },
      ]),
    );
    expect(pushMessagesLine).not.toHaveBeenCalled();
    expect(result.visibleReplySent).toBe(true);
  });

  it("honors channelData.line.mediaKind on the reply-token path instead of forcing image", async () => {
    const lineData = {
      mediaKind: "video" as const,
      previewImageUrl: "https://example.com/preview.jpg",
    };
    const { replyMessageLine, buildMediaMessage } = createMediaDeps();

    const result = await deliverMedia("https://example.com/clip.mp4", lineData);

    expect(result.status).toBe("delivered");
    expect(buildMediaMessage).toHaveBeenCalledWith(
      "https://example.com/clip.mp4",
      expect.objectContaining(lineData),
      "line:user:1",
    );
    expect(replyMessageLine).toHaveBeenCalledWith(
      ...replyArgs([
        {
          type: "video",
          originalContentUrl: "https://example.com/clip.mp4",
          previewImageUrl: "https://example.com/preview.jpg",
        },
      ]),
    );
  });

  it("delivers a bare audio URL through the shared media builder", async () => {
    const { buildMediaMessage, replyMessageLine, pushMessagesLine } = createMediaDeps();

    const result = await deliverMedia("https://example.com/voice.m4a");

    expect(result.status).toBe("delivered");
    expect(buildMediaMessage).toHaveBeenCalledWith(
      "https://example.com/voice.m4a",
      {
        mediaKind: undefined,
        previewImageUrl: undefined,
        durationMs: undefined,
        trackingId: undefined,
      },
      "line:user:1",
    );
    expect(replyMessageLine).toHaveBeenCalledExactlyOnceWith(
      ...replyArgs([
        { type: "audio", originalContentUrl: "https://example.com/voice.m4a", duration: 60_000 },
      ]),
    );
    expect(pushMessagesLine).not.toHaveBeenCalled();
  });

  it("surfaces a visible partial delivery when a media message cannot be built", async () => {
    const lineData = { mediaKind: "video" as const };
    const { replyMessageLine } = createDeps();

    const result = await deliverMedia(
      "https://example.com/clip.mp4",
      lineData,
      "here is your clip",
    );

    expect(result).toMatchObject({
      status: "partial",
      error: { sentBeforeError: true, visibleReplySent: true },
    });
    expect(replyMessageLine).toHaveBeenCalledWith(
      ...replyArgs([{ type: "text", text: "here is your clip" }]),
    );
  });

  it("does not expose credentials from media-only validation failures", async () => {
    const mediaUrl = new URL("http://example.com/image.jpg");
    mediaUrl.username = ["line", "user"].join("-");
    mediaUrl.password = ["line", "fixture"].join("-");
    mediaUrl.searchParams.set("auth", ["line", "query"].join("-"));
    const { replyMessageLine, pushMessagesLine } = createMediaDeps();

    await expect(deliverMedia(mediaUrl.href)).rejects.toThrow(
      new Error("LINE outbound media URL must use HTTPS"),
    );

    expect(replyMessageLine).not.toHaveBeenCalled();
    expect(pushMessagesLine).not.toHaveBeenCalled();
  });

  it("wraps a non-Error media-only build failure", async () => {
    const lineData = { mediaKind: "video" as const };
    const failure = { code: "invalid_media" };
    createMediaDeps({
      buildMediaMessage: vi.fn<LineAutoReplyDeps["buildMediaMessage"]>().mockRejectedValue(failure),
    });

    await expect(deliverMedia("https://example.com/clip.mp4", lineData)).rejects.toMatchObject({
      message: "LINE message send failed",
      cause: failure,
    });
  });
});
