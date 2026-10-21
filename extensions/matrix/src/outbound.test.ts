import { beforeEach, describe, expect, it, vi } from "vitest";
import { chunkTextForOutbound, type OpenClawConfig } from "../runtime-api.js";

const mocks = vi.hoisted(() => ({
  sendMessageMatrix: vi.fn(),
  sendPollMatrix: vi.fn(),
}));

// mock-isolation: Verify outbound translation without opening a Matrix SDK client or network connection.
vi.mock("./matrix/send.js", () => mocks);

import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { matrixOutbound } from "./outbound.js";

const to = "room:!room:example";
type PayloadContext = Parameters<NonNullable<typeof matrixOutbound.sendPayload>>[0];
function sendPayload(
  payload: PayloadContext["payload"],
  options: Partial<Omit<PayloadContext, "payload">> = {},
) {
  return matrixOutbound.sendPayload!({
    cfg: {},
    to,
    text: payload.text ?? "",
    payload,
    ...options,
  });
}
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
function renderPresentation(presentation: MessagePresentation, text = "") {
  return matrixOutbound.renderPresentation!({
    payload: { text, presentation },
    presentation,
    ctx: {} as never,
  });
}

function senderResult(
  content: string,
  ...parts: Array<[id: string, kind: "text" | "media" | "voice", replyToId?: string]>
) {
  const firstPart = parts[0];
  const receipt = {
    primaryPlatformMessageId: firstPart?.[0],
    platformMessageIds: parts.map(([id]) => id),
    parts: parts.map(([platformMessageId, kind, replyToId], index) => ({
      platformMessageId,
      kind,
      index,
      ...(replyToId ? { replyToId } : {}),
    })),
    ...(firstPart?.[2] ? { replyToId: firstPart[2] } : {}),
    sentAt: 1,
  };
  return {
    messageId: parts.at(-1)?.[0],
    roomId: "!room:example",
    primaryMessageId: firstPart?.[0],
    receipt,
    content,
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

  it("preserves the complete Matrix sender result through sendMedia", async () => {
    const sent = senderResult("first\nlast", ["$first", "media", "$reply"], ["$last", "text"]);
    mocks.sendMessageMatrix.mockResolvedValueOnce(sent);
    const result = await matrixOutbound.sendMedia!({
      ...context,
      text: "first\nlast",
      mediaUrl: "file:///tmp/photo.png",
    });

    expect(result).toMatchObject({
      channel: "matrix",
      messageId: "$last",
      target: { kind: "room", id: "!room:example" },
      primaryMessageId: "$first",
      content: "first\nlast",
    });
    expect(result.receipt).toBe(sent.receipt);
  });

  it("passes resolved cfg through injected deps.matrix", async () => {
    const matrix = vi.fn(async () => ({ messageId: "evt-injected", roomId: "!room:example" }));

    await matrixOutbound.sendText!({
      ...context,
      text: "hello via deps",
      deps: { matrix },
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
      ...context,
      poll: {
        question: "Snack?",
        options: ["Pizza", "Sushi"],
      },
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
    const presentation = { blocks: [{ type: "divider" as const }] };
    const rendered = await renderPresentation(presentation);

    expect(rendered?.text).toBe("---");
    expect(rendered?.channelData?.matrix).toEqual({
      extraContent: {
        "com.openclaw.presentation": {
          ...presentation,
          version: 1,
          type: "message.presentation",
        },
      },
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

    const rendered = await renderPresentation(presentation, "Choose");

    expect(rendered?.text).toBe(
      "Choose\n\nEnvironment:\n- Production: `/deploy production`\n- Opaque",
    );
    expect(rendered?.text).not.toContain("private-callback-token");
  });

  it.each([false, true])(
    "forwards only presentation metadata with empty body=%s",
    async (empty) => {
      const text = empty ? "" : "Select model";
      const presentation = empty ? presentationContent : { ...presentationContent, title: text };
      const extraContent = { "com.openclaw.presentation": presentation };
      const spoofed = empty
        ? {}
        : {
            body: "spoofed",
            msgtype: "m.notice",
            "m.relates_to": { "m.in_reply_to": { event_id: "$spoof" } },
          };
      await sendPayload(
        { text, channelData: channelData({ ...spoofed, ...extraContent }) },
        context,
      );
      expectSend(mocks.sendMessageMatrix, empty ? "---" : "Select model", { extraContent });
    },
  );

  it("keeps dispatch ownership and first-part caption/presentation across media fanout", async () => {
    const onPlatformSendDispatch = vi.fn();
    const extraContent = {
      "com.openclaw.presentation": { version: 1, type: "message.presentation" },
    };
    await sendPayload(
      {
        text: "caption",
        mediaUrls: ["", "file:///tmp/a.png", "   ", "file:///tmp/b.png"],
        channelData: channelData(extraContent),
      },
      {
        ...context,
        deliveryQueueId: "queue-1",
        onPlatformSendDispatch,
        threadId: "$thread",
      },
    );

    expect(mocks.sendMessageMatrix).toHaveBeenCalledTimes(2);
    for (const [index, mediaUrl, text] of [
      [0, "file:///tmp/a.png", "caption"],
      [1, "file:///tmp/b.png", ""],
    ] as const) {
      expectSend(
        mocks.sendMessageMatrix,
        text,
        {
          mediaUrl,
          deliveryQueueId: "queue-1",
          deliveryPartIndex: index,
          deliveryPartCount: 2,
          onPlatformSendDispatch,
          threadId: "$thread",
          extraContent: index === 0 ? extraContent : undefined,
        },
        index + 1,
      );
    }
  });

  it("combines media payload receipts without inventing replies on later events", async () => {
    mocks.sendMessageMatrix
      .mockResolvedValueOnce(
        senderResult(
          "caption\noverflow",
          ["$image", "media", "$reply"],
          ["$caption-overflow", "text"],
        ),
      )
      .mockResolvedValueOnce(senderResult("second image", ["$second-image", "media"]));

    const result = await sendPayload(
      {
        text: "caption",
        mediaUrls: ["file:///tmp/a.png", "file:///tmp/b.png"],
      },
      {
        accountId: "default",
        replyToId: "$reply",
        replyToIdSource: "implicit",
        replyToMode: "first",
      },
    );

    expect(mockOptions(mocks.sendMessageMatrix, 0)).toHaveProperty("replyToId", "$reply");
    expect(mockOptions(mocks.sendMessageMatrix, 1)).toHaveProperty("replyToId", undefined);
    expect(result).toMatchObject({
      channel: "matrix",
      messageId: "$second-image",
      primaryMessageId: "$image",
      content: "caption\noverflow\nsecond image",
      receipt: {
        primaryPlatformMessageId: "$image",
        platformMessageIds: ["$image", "$caption-overflow", "$second-image"],
        parts: [
          { platformMessageId: "$image", kind: "media", index: 0, replyToId: "$reply" },
          { platformMessageId: "$caption-overflow", kind: "text", index: 1 },
          { platformMessageId: "$second-image", kind: "media", index: 2 },
        ],
      },
    });
    expect(result.receipt?.parts[1]).not.toHaveProperty("replyToId");
    expect(result.receipt?.parts[2]).not.toHaveProperty("replyToId");
  });
});
