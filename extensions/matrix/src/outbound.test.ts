import { beforeEach, describe, expect, it, vi } from "vitest";
import { chunkTextForOutbound, type OpenClawConfig } from "../runtime-api.js";

const mocks = vi.hoisted(() => ({
  sendMessageMatrix: vi.fn(),
  sendPollMatrix: vi.fn(),
}));

vi.mock("./matrix/send.js", () => ({
  sendMessageMatrix: mocks.sendMessageMatrix,
  sendPollMatrix: mocks.sendPollMatrix,
}));

vi.mock("./runtime.js", () => ({
  getMatrixRuntime: () => ({
    channel: {
      text: {
        chunkMarkdownText: (text: string) => [text],
      },
    },
  }),
}));

import { matrixOutbound } from "./outbound.js";

const to = "room:!room:example";
function expectSend(source: unknown, text: string, options: Record<string, unknown>, index = 1) {
  expect(source).toHaveBeenNthCalledWith(index, to, text, expect.objectContaining(options));
}

function mockOptions(source: { mock: { calls: unknown[][] } }, callIndex = 0) {
  const options = source.mock.calls[callIndex]?.[2];
  if (!options || typeof options !== "object") {
    throw new Error(`expected send options at call ${callIndex}`);
  }
  return options as Record<string, unknown>;
}

function createMatrixReceipt(
  parts: Array<{ messageId: string; kind: "text" | "media" | "voice"; replyToId?: string }>,
) {
  const firstPart = parts[0];
  return {
    primaryPlatformMessageId: firstPart?.messageId,
    platformMessageIds: parts.map(({ messageId }) => messageId),
    parts: parts.map(({ messageId, kind, replyToId }, index) => ({
      platformMessageId: messageId,
      kind,
      index,
      ...(replyToId ? { replyToId } : {}),
    })),
    ...(firstPart?.replyToId ? { replyToId: firstPart.replyToId } : {}),
    sentAt: 1,
  };
}

describe("matrixOutbound cfg threading", () => {
  const cfg: OpenClawConfig = {
    channels: { matrix: { accessToken: "resolved-token" } },
  };
  const context = { cfg, to, accountId: "default" };
  const presentationContent = {
    version: 1,
    type: "message.presentation",
    blocks: [{ type: "divider" }],
  };
  const channelData = (extraContent: Record<string, unknown>) => ({ matrix: { extraContent } });
  beforeEach(() => {
    mocks.sendMessageMatrix.mockReset();
    mocks.sendPollMatrix.mockReset();
    mocks.sendMessageMatrix.mockResolvedValue({ messageId: "evt-1", roomId: "!room:example" });
    mocks.sendPollMatrix.mockResolvedValue({ eventId: "$poll", roomId: "!room:example" });
  });

  it("makes progress for fractional BMP and astral limits", () => {
    const chunker = matrixOutbound.chunker;
    if (!chunker) {
      throw new Error("matrixOutbound.chunker missing");
    }

    expect(chunker("ABCD", 0.5)).toEqual(["A", "B", "C", "D"]);
    expect(chunker("😀😀", 1.5)).toEqual(["😀", "😀"]);
    expect(chunkTextForOutbound("ABCD", 0.5)).toEqual(["A", "B", "C", "D"]);
    expect(chunkTextForOutbound("😀😀", 1.5)).toEqual(["😀", "😀"]);
  });

  it("preserves Matrix compatibility behavior", () => {
    expect(chunkTextForOutbound("", 5)).toEqual([""]);
    expect(chunkTextForOutbound("", 0.5)).toEqual([""]);
    expect(chunkTextForOutbound("abcdef   ", 5)).toEqual(["abcde", "f   "]);
  });

  it.each(["sendMedia"] as const)(
    "preserves the complete Matrix sender result through %s",
    async (method) => {
      const receipt = createMatrixReceipt([
        { messageId: "$first", kind: "media", replyToId: "$reply" },
        { messageId: "$last", kind: "text" },
      ]);
      mocks.sendMessageMatrix.mockResolvedValueOnce({
        messageId: "$last",
        roomId: "!room:example",
        primaryMessageId: "$first",
        receipt,
        content: "first\nlast",
      });
      const send = matrixOutbound[method];
      if (!send) {
        throw new Error(`matrixOutbound.${method} missing`);
      }

      const result = await send({
        cfg: {} as OpenClawConfig,
        to: "room:!room:example",
        text: "first\nlast",
        mediaUrl: "file:///tmp/photo.png",
        accountId: "default",
      });

      expect(result).toMatchObject({
        channel: "matrix",
        messageId: "$last",
        target: { kind: "room", id: "!room:example" },
        primaryMessageId: "$first",
        content: "first\nlast",
      });
      expect(result.receipt).toBe(receipt);
    },
  );

  it("passes resolved cfg through injected deps.matrix", async () => {
    const matrix = vi.fn(async () => ({
      messageId: "evt-injected",
      roomId: "!room:example",
    }));

    await matrixOutbound.sendText!({
      cfg,
      to: "room:!room:example",
      text: "hello via deps",
      deps: { matrix },
      accountId: "default",
      threadId: "$thread",
      replyToId: "$reply",
    });

    expectSend(matrix, "hello via deps", {
      cfg,
      accountId: "default",
      threadId: "$thread",
      replyToId: "$reply",
    });
    expect(mockOptions(matrix).cfg).toBe(cfg);
  });

  it("passes resolved cfg to sendPollMatrix", async () => {
    await matrixOutbound.sendPoll!({
      cfg,
      to: "room:!room:example",
      poll: {
        question: "Snack?",
        options: ["Pizza", "Sushi"],
      },
      accountId: "default",
      threadId: "$thread",
    });

    expect(mocks.sendPollMatrix).toHaveBeenNthCalledWith(
      1,
      context.to,
      { question: "Snack?", options: ["Pizza", "Sushi"] },
      expect.objectContaining({ cfg, accountId: "default", threadId: "$thread" }),
    );
    expect(mockOptions(mocks.sendPollMatrix).cfg).toBe(cfg);
  });

  it("renders divider-only MessagePresentation with a non-empty Matrix fallback body", async () => {
    const presentation = {
      blocks: [{ type: "divider" as const }],
    };

    const rendered = await matrixOutbound.renderPresentation!({
      payload: { text: "", presentation },
      presentation,
      ctx: {} as never,
    });

    expect(rendered?.text).toBe("---");
    expect(
      (rendered!.channelData!.matrix as { extraContent?: Record<string, unknown> }).extraContent?.[
        "com.openclaw.presentation"
      ],
    ).toEqual({
      ...presentation,
      version: 1,
      type: "message.presentation",
    });
  });

  it("keeps typed select commands actionable in Matrix fallback content", async () => {
    const presentation = {
      blocks: [
        {
          type: "select" as const,
          placeholder: "Environment",
          options: [
            {
              label: "Production",
              action: { type: "command" as const, command: "/deploy production" },
            },
            {
              label: "Opaque",
              action: { type: "callback" as const, value: "private-callback-token" },
            },
          ],
        },
      ],
    };

    const rendered = await matrixOutbound.renderPresentation!({
      payload: { text: "Choose", presentation },
      presentation,
      ctx: {} as never,
    });

    expect(rendered?.text).toBe(
      "Choose\n\nEnvironment:\n- Production: `/deploy production`\n- Opaque",
    );
    expect(rendered?.text).not.toContain("private-callback-token");
  });

  it("sends empty Matrix presentation payloads with a minimal fallback body", async () => {
    await matrixOutbound.sendPayload!({
      ...context,
      text: "",
      payload: {
        text: "",
        channelData: channelData({ "com.openclaw.presentation": presentationContent }),
      },
      accountId: "default",
    });

    expectSend(mocks.sendMessageMatrix, "---", {
      extraContent: { "com.openclaw.presentation": presentationContent },
    });
  });

  it("only forwards presentation metadata from Matrix extraContent", async () => {
    const titledPresentation = { ...presentationContent, title: "Select model" };

    await matrixOutbound.sendPayload!({
      ...context,
      text: "Select model",
      payload: {
        text: "Select model",
        channelData: channelData({
          body: "spoofed",
          msgtype: "m.notice",
          "m.relates_to": { "m.in_reply_to": { event_id: "$spoof" } },
          "com.openclaw.presentation": titledPresentation,
        }),
      },
      accountId: "default",
    });

    expectSend(mocks.sendMessageMatrix, "Select model", {
      extraContent: { "com.openclaw.presentation": titledPresentation },
    });
  });

  it("preserves durable dispatch ownership across sendPayload media fanout", async () => {
    const onPlatformSendDispatch = vi.fn();

    await matrixOutbound.sendPayload!({
      cfg: {} as OpenClawConfig,
      to: "room:!room:example",
      text: "caption",
      payload: {
        text: "caption",
        mediaUrls: ["", "file:///tmp/a.png", "   ", "file:///tmp/b.png"],
      },
      deliveryQueueId: "queue-1",
      onPlatformSendDispatch,
    });

    expect(mocks.sendMessageMatrix).toHaveBeenCalledTimes(2);
    expect(mockOptions(mocks.sendMessageMatrix, 0)).toMatchObject({
      mediaUrl: "file:///tmp/a.png",
      deliveryQueueId: "queue-1",
      deliveryPartIndex: 0,
      deliveryPartCount: 2,
      onPlatformSendDispatch,
    });
    expect(mockOptions(mocks.sendMessageMatrix, 1)).toMatchObject({
      mediaUrl: "file:///tmp/b.png",
      deliveryQueueId: "queue-1",
      deliveryPartIndex: 1,
      deliveryPartCount: 2,
      onPlatformSendDispatch,
    });
  });

  it("combines media payload receipts without inventing replies on later events", async () => {
    const firstReceipt = createMatrixReceipt([
      { messageId: "$image", kind: "media", replyToId: "$reply" },
      { messageId: "$caption-overflow", kind: "text" },
    ]);
    const secondReceipt = createMatrixReceipt([{ messageId: "$second-image", kind: "media" }]);
    mocks.sendMessageMatrix
      .mockResolvedValueOnce({
        messageId: "$caption-overflow",
        roomId: "!room:example",
        primaryMessageId: "$image",
        receipt: firstReceipt,
        content: "caption\noverflow",
      })
      .mockResolvedValueOnce({
        messageId: "$second-image",
        roomId: "!room:example",
        primaryMessageId: "$second-image",
        receipt: secondReceipt,
        content: "second image",
      });

    const result = await matrixOutbound.sendPayload!({
      cfg: {} as OpenClawConfig,
      to: "room:!room:example",
      text: "caption",
      payload: {
        text: "caption",
        mediaUrls: ["file:///tmp/a.png", "file:///tmp/b.png"],
      },
      accountId: "default",
      replyToId: "$reply",
      replyToIdSource: "implicit",
      replyToMode: "first",
    });

    expect(mockOptions(mocks.sendMessageMatrix, 0)).toHaveProperty("replyToId", "$reply");
    expect(mockOptions(mocks.sendMessageMatrix, 1)).toHaveProperty("replyToId", undefined);
    expect(result).toMatchObject({
      channel: "matrix",
      messageId: "$second-image",
      primaryMessageId: "$image",
      content: "caption\noverflow\nsecond image",
    });
    expect(result.receipt?.primaryPlatformMessageId).toBe("$image");
    expect(result.receipt?.platformMessageIds).toEqual([
      "$image",
      "$caption-overflow",
      "$second-image",
    ]);
    expect(result.receipt?.parts).toMatchObject([
      { platformMessageId: "$image", kind: "media", index: 0, replyToId: "$reply" },
      { platformMessageId: "$caption-overflow", kind: "text", index: 1 },
      { platformMessageId: "$second-image", kind: "media", index: 2 },
    ]);
    expect(result.receipt?.parts[1]).not.toHaveProperty("replyToId");
    expect(result.receipt?.parts[2]).not.toHaveProperty("replyToId");
  });

  it("applies caption and presentation metadata to the first non-empty media URL", async () => {
    await matrixOutbound.sendPayload!({
      cfg,
      to: "room:!room:example",
      text: "caption",
      payload: {
        text: "caption",
        mediaUrls: ["", "file:///tmp/a.png", "file:///tmp/b.png"],
        channelData: channelData({
          "com.openclaw.presentation": { version: 1, type: "message.presentation" },
        }),
      },
      accountId: "default",
      threadId: "$thread",
    });

    expect(mocks.sendMessageMatrix).toHaveBeenCalledTimes(2);
    expectSend(mocks.sendMessageMatrix, "caption", {
      mediaUrl: "file:///tmp/a.png",
      threadId: "$thread",
      extraContent: { "com.openclaw.presentation": { version: 1, type: "message.presentation" } },
    });
    expectSend(
      mocks.sendMessageMatrix,
      "",
      {
        mediaUrl: "file:///tmp/b.png",
        threadId: "$thread",
        extraContent: undefined,
      },
      2,
    );
  });
});
