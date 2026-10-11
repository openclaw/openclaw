import { expectDefined } from "@openclaw/normalization-core";
import { chunkMarkdownText } from "openclaw/plugin-sdk/reply-runtime";
// Line tests cover auto reply delivery plugin behavior.
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

describe("deliverLineAutoReply", () => {
  // A carousel with no column and no alt text carries nothing LINE can render.
  // The converter runs before the send block, so answering it with a throw took
  // the reply's own text down with it and the sender saw nothing at all.
  it("still sends the reply text when a carousel carries nothing to render", async () => {
    const { replyMessageLine } = createDeps({ buildTemplateMessageFromPayload });

    await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "After" },
      lineData: { templateMessage: { type: "carousel", columns: [] } },
    });

    const messages = expectDefined(replyMessageLine.mock.calls[0]?.[1], "LINE reply messages");
    expect(
      messages.map((message) => (message.type === "text" ? message.text : message.type)),
    ).toEqual(["After"]);
  });

  it("keeps quick replies on final media when ordered cards overflow the reply token", async () => {
    const lineData = { quickReplies: ["Continue"] };
    const { replyMessageLine, pushMessagesLine } = createDeps({
      processLineMessage: processOrderedLineMessage,
      chunkMarkdownText,
    });

    await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: {
        text: Array.from({ length: 6 }, (_, index) => `\`\`\`js\ncard${index}()\n\`\`\``).join(
          "\n\n",
        ),
        mediaUrls: ["https://example.com/image.jpg"],
      },
      lineData,
    });

    expect(replyMessageLine.mock.calls[0]?.[1].map((message) => message.type)).toEqual([
      "flex",
      "flex",
      "flex",
      "flex",
      "flex",
    ]);
    expect(pushMessagesLine.mock.calls[0]?.[1]).toMatchObject([
      { type: "flex", altText: "Code" },
      {
        type: "image",
        originalContentUrl: "https://example.com/image.jpg",
        quickReply: createQuickReply("Continue"),
      },
    ]);
  });

  it.each([{ name: "with final quick replies", quickReplies: ["Continue"] }])(
    "keeps oversized Markdown tables in source order $name",
    async ({ quickReplies }) => {
      const { replyMessageLine, pushMessagesLine } = createDeps({
        processLineMessage: processOrderedLineMessage,
        chunkMarkdownText,
      });
      const markdown = `First\n\n| Small | Value |\n|---|---|\n| Kept | card |\n\nBetween\n\n| Name | Value |\n|---|---|\n| Large | ${"x".repeat(30_000)} |\n\nAfter\n\n\`\`\`js\nconsole.log("still a card")\n\`\`\``;

      await deliverLineAutoReply({
        ...baseDeliveryParams,
        payload: { text: markdown },
        lineData: quickReplies.length > 0 ? { quickReplies } : {},
      });

      const calls = [
        ...replyMessageLine.mock.calls.map((args, index) => ({
          position: expectDefined(
            replyMessageLine.mock.invocationCallOrder[index],
            "LINE reply delivery call order",
          ),
          messages: args[1],
        })),
        ...pushMessagesLine.mock.calls.map((args, index) => ({
          position: expectDefined(
            pushMessagesLine.mock.invocationCallOrder[index],
            "LINE push delivery call order",
          ),
          messages: args[1],
        })),
      ].toSorted((left, right) => left.position - right.position);
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
      if (quickReplies.length > 0) {
        const messages = calls.flatMap((call) => call.messages);
        expect(messages.at(-1)).toMatchObject({
          type: "flex",
          altText: "Code",
          quickReply: createQuickReply(...quickReplies),
        });
        expect(messages.slice(0, -1).every((message) => !("quickReply" in message))).toBe(true);
      }
    },
  );

  // A select-only presentation renders quick replies but no Flex body, so the
  // fallback prose is the only thing carrying the question. Delivering bare
  // option labels would leave the user choosing between answers to nothing.
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

    await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: prepared,
      lineData,
    });

    expect(replyMessageLine.mock.calls[0]?.[1]).toMatchObject([
      { type: "text", text: "Agent needs input:\n1. Alpha" },
    ]);
  });

  it("delivers whatever the location builder returns, including its text degradation", async () => {
    // A blank required field makes LINE reject the pin, and the builder answers
    // with the sender's values as text. The reply must carry that, not drop it.
    const lineData = {
      location: { title: "Meet here", address: " ", latitude: 35.6895, longitude: 139.6917 },
    };
    const degraded = {
      type: "text" as const,
      text: "Meet here" + String.fromCharCode(10) + "35.6895, 139.6917",
    };
    // The real builder decides the degradation; injecting a stand-in here would
    // only prove the stand-in was pushed.
    const createLocationMessage = vi.fn(createRealLocationMessage);
    const { replyMessageLine } = createDeps({ createLocationMessage });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "Meet me there.", channelData: { line: lineData } },
      lineData,
    });

    expect(replyMessageLine).toHaveBeenCalledExactlyOnceWith(
      "token",
      // No quick replies here, so the text leads and rich parts follow it.
      [{ type: "text", text: "Meet me there." }, degraded],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(createLocationMessage).toHaveBeenCalledOnce();
    expect(result.visibleReplySent).toBe(true);
  });

  it("keeps media on the reply token alongside text", async () => {
    const { replyMessageLine, pushMessagesLine } = createDeps();

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "here you go", mediaUrls: ["https://example.com/chart.png"] },
      lineData: {},
    });

    expect(result.status).toBe("delivered");
    expect(replyMessageLine).toHaveBeenCalledExactlyOnceWith(
      "token",
      [{ type: "text", text: "here you go" }, createImageMessage("https://example.com/chart.png")],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
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

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text },
      lineData: {},
    });

    expect(processLineMessage).toHaveBeenCalledWith("Done.");
    expect(replyMessageLine).toHaveBeenCalledWith("token", [{ type: "text", text: "Done." }], {
      cfg: LINE_TEST_CFG,
      accountId: "acc",
    });
    expect(result).toEqual({
      status: "delivered",
      replyTokenUsed: true,
      visibleReplySent: true,
    });
  });

  it("uses fallback text for quick-reply-only payloads", async () => {
    const lineData = {
      quickReplies: ["A", "B"],
    };
    const { replyMessageLine, pushMessagesLine } = createDeps();

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "", channelData: { line: lineData } },
      lineData,
    });

    expect(result.replyTokenUsed).toBe(true);
    expect(replyMessageLine).toHaveBeenCalledWith(
      "token",
      [
        {
          type: "text",
          text: "Options:\n- A\n- B",
          quickReply: createQuickReply("A", "B"),
        },
      ],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).not.toHaveBeenCalled();
    expect(result.visibleReplySent).toBe(true);
  });

  it("wraps a non-extensible rich failure without losing visible-send evidence", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
    };
    const frozenError = new Error("push failed");
    Object.freeze(frozenError);
    createDeps({
      chunkMarkdownText: () => ["c1", "c2", "c3", "c4", "c5"],
      pushMessagesLine: vi.fn(async () => {
        throw frozenError;
      }) as LineAutoReplyDeps["pushMessagesLine"],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "hello", channelData: { line: lineData } },
      lineData,
    });

    expect(result).toMatchObject({
      status: "partial",
      error: { sentBeforeError: true, visibleReplySent: true, cause: frozenError },
    });
  });

  it("honors channelData.line.mediaKind on the reply-token path instead of forcing image", async () => {
    // The push path resolves mediaKind into a video/audio message; the reply path
    // used to hardcode createImageMessage, silently downgrading video to a broken
    // image. LINE-specific media must now resolve to the matching kind.
    const lineData = {
      mediaKind: "video" as const,
      previewImageUrl: "https://example.com/preview.jpg",
    };
    const { replyMessageLine, buildMediaMessage } = createDeps({
      processLineMessage: () => [],
      chunkMarkdownText: () => [],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: {
        mediaUrls: ["https://example.com/clip.mp4"],
        channelData: { line: lineData },
      },
      lineData,
    });

    expect(result.status).toBe("delivered");
    expect(buildMediaMessage).toHaveBeenCalledWith(
      "https://example.com/clip.mp4",
      expect.objectContaining(lineData),
      "line:user:1",
    );
    expect(replyMessageLine).toHaveBeenCalledWith(
      "token",
      [
        {
          type: "video",
          originalContentUrl: "https://example.com/clip.mp4",
          previewImageUrl: "https://example.com/preview.jpg",
        },
      ],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });

  it("delivers a bare audio URL through the shared media builder", async () => {
    // This path used to pin mediaKind to "image" for a bare media URL, so an
    // audio or video URL reached LINE as an empty image bubble. The leaf reads
    // the URL itself, so overriding the kind here is what hid the real one.
    const { buildMediaMessage, replyMessageLine, pushMessagesLine } = createDeps({
      processLineMessage: () => [],
      chunkMarkdownText: () => [],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: {
        mediaUrls: ["https://example.com/voice.m4a"],
        channelData: { line: {} },
      },
      lineData: {},
    });

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
      "token",
      [{ type: "audio", originalContentUrl: "https://example.com/voice.m4a", duration: 60_000 }],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).not.toHaveBeenCalled();
  });

  it("surfaces a visible partial delivery when a media message cannot be built", async () => {
    // A video missing its preview image cannot be built. The text still reaches the
    // user, but the lost media bubble must surface as a partial delivery.
    const lineData = { mediaKind: "video" as const };
    const { replyMessageLine } = createDeps();

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: {
        text: "here is your clip",
        mediaUrls: ["https://example.com/clip.mp4"],
        channelData: { line: lineData },
      },
      lineData,
    });

    expect(result).toMatchObject({
      status: "partial",
      error: { sentBeforeError: true, visibleReplySent: true },
    });
    // Text still reached the user over the reply token despite the media failure.
    expect(replyMessageLine).toHaveBeenCalledWith(
      "token",
      [{ type: "text", text: "here is your clip" }],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });

  it("does not expose credentials from media-only validation failures", async () => {
    const lineData = {};
    const mediaUrl = new URL("http://example.com/image.jpg");
    mediaUrl.username = ["line", "user"].join("-");
    mediaUrl.password = ["line", "fixture"].join("-");
    mediaUrl.searchParams.set("auth", ["line", "query"].join("-"));
    const { replyMessageLine, pushMessagesLine } = createDeps({
      processLineMessage: () => [],
      chunkMarkdownText: () => [],
    });

    await expect(
      deliverLineAutoReply({
        ...baseDeliveryParams,
        payload: {
          mediaUrls: [mediaUrl.href],
          channelData: { line: lineData },
        },
        lineData,
      }),
    ).rejects.toThrow(new Error("LINE outbound media URL must use HTTPS"));

    expect(replyMessageLine).not.toHaveBeenCalled();
    expect(pushMessagesLine).not.toHaveBeenCalled();
  });

  it("wraps a non-Error media-only build failure", async () => {
    const lineData = { mediaKind: "video" as const };
    const failure = { code: "invalid_media" };
    createDeps({
      processLineMessage: () => [],
      chunkMarkdownText: () => [],
      buildMediaMessage: vi.fn(async () => {
        // oxlint-disable-next-line typescript/only-throw-error -- dependency callbacks may reject unknown values; this proves the delivery boundary normalizes them.
        throw failure;
      }) as LineAutoReplyDeps["buildMediaMessage"],
    });

    await expect(
      deliverLineAutoReply({
        ...baseDeliveryParams,
        payload: {
          mediaUrls: ["https://example.com/clip.mp4"],
          channelData: { line: lineData },
        },
        lineData,
      }),
    ).rejects.toMatchObject({
      message: "LINE message send failed",
      cause: failure,
    });
  });
});
