import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chunkTextForOutbound, type OpenClawConfig } from "../runtime-api.js";

const mocks = vi.hoisted(() => ({
  sendMessageMatrix: vi.fn(),
  sendPollMatrix: vi.fn(),
}));

// mock-isolation: Verify outbound translation without opening a Matrix SDK client or network connection.
vi.mock("./matrix/send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./matrix/send.js")>()),
  ...mocks,
  editMessageMatrix: vi.fn(),
  reactMatrixMessage: vi.fn(),
  resolveMatrixRoomId: vi.fn(),
  sendTypingMatrix: vi.fn(),
}));
// Registered adapter proofs must not read the process runtime singleton.
vi.mock("./runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.js")>()),
  getOptionalMatrixRuntime: () => undefined,
  getMatrixRuntime: () => ({ channel: { text: { chunkMarkdownText: (text: string) => [text] } } }),
}));

import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { matrixPlugin } from "./channel.js";
const matrixOutbound = matrixPlugin.outbound!;

const to = "room:!room:example";
const cfg: OpenClawConfig = {
  channels: {
    matrix: {
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "resolved-token",
    },
  },
};
const context = { cfg, to, accountId: "default" };
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

beforeEach(() => {
  mocks.sendMessageMatrix
    .mockReset()
    .mockResolvedValue({ messageId: "$event-1", roomId: "!room:example" });
  mocks.sendPollMatrix.mockReset().mockResolvedValue({ eventId: "$poll", roomId: "!room:example" });
});

describe("matrixOutbound cfg threading", () => {
  const presentationContent = {
    version: 1,
    type: "message.presentation",
    blocks: [{ type: "divider" }],
  };
  const channelData = (extraContent: Record<string, unknown>) => ({ matrix: { extraContent } });

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

  it.each(["outbound", "message"] as const)(
    "preserves the owner receipt through %s media",
    async (surface) => {
      const sent = senderResult("first\nlast", ["$first", "media", "$reply"], ["$last", "text"]);
      mocks.sendMessageMatrix.mockResolvedValueOnce(sent);
      const send =
        surface === "outbound" ? matrixOutbound.sendMedia! : matrixPlugin.message!.send!.media!;
      const result = await send({
        ...context,
        text: "first\nlast",
        mediaUrl: "file:///tmp/photo.png",
      });

      expect(result.messageId).toBe("$last");
      if (surface === "outbound") {
        expect(result).toMatchObject({
          channel: "matrix",
          messageId: "$last",
          target: { kind: "room", id: "!room:example" },
          primaryMessageId: "$first",
          content: "first\nlast",
        });
      }
      expect(result.receipt).toBe(sent.receipt);
    },
  );

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
    expect(matrixOutbound.presentationCapabilities).toMatchObject({
      supported: true,
      buttons: true,
      selects: true,
      context: true,
      divider: true,
    });
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

  it("forwards rendered buttons through the registered payload sender", async () => {
    const presentation = {
      title: "Select thinking level",
      tone: "info" as const,
      blocks: [{ type: "buttons" as const, buttons: [{ label: "Low", value: "/think low" }] }],
    };
    const extraContent = {
      "com.openclaw.presentation": { ...presentation, version: 1, type: "message.presentation" },
    };
    const rendered = await renderPresentation(presentation, "fallback");
    for (const fragment of ["fallback", "Select thinking level"]) {
      expect(rendered?.text).toContain(fragment);
    }
    expect(rendered?.channelData?.matrix).toEqual(expect.objectContaining({ extraContent }));
    await sendPayload(rendered!, { ...context, threadId: "$thread", replyToId: "$reply" });
    expect(mocks.sendMessageMatrix).toHaveBeenCalledOnce();
    expectSend(mocks.sendMessageMatrix, rendered!.text!, {
      accountId: "default",
      threadId: "$thread",
      replyToId: "$reply",
      extraContent,
    });
    expect(mockOptions(mocks.sendMessageMatrix).cfg).toBe(cfg);
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

describe("matrix channel message adapter", () => {
  const adapter = matrixPlugin.message!;
  const { text: sendText, media: sendMedia } = adapter.send!;
  if (!sendText || !sendMedia) {
    throw new Error("Expected Matrix text and media senders");
  }
  beforeAll(async () => {
    mocks.sendMessageMatrix.mockResolvedValue({ messageId: "$warmup", roomId: "!room:example" });
    await sendText({ ...context, text: "warmup" });
  });

  it("routes the standard Matrix send action through canonical durable delivery", async () => {
    const prepareSendPayload = matrixPlugin.actions!.prepareSendPayload!;
    const payload = { text: "durable tool send" };
    expect(
      await prepareSendPayload({ ctx: { action: "send", cfg } as never, payload } as never),
    ).toBe(payload);
    expect(
      await prepareSendPayload({ ctx: { action: "edit", cfg } as never, payload } as never),
    ).toBeNull();
  });

  it.each([
    ["room:!room:example", "off", "$thread"],
    ["matrix:channel:!room:example", "all", "$thread"],
    ["room:!another:example", "all", undefined],
    ["user:@alice:example", "all", undefined],
  ] as const)(
    "routes a native Matrix message action to %s (%s)",
    async (target, replyToMode, threadId) => {
      const toolContext = {
        currentChannelProvider: "matrix" as const,
        currentChannelId: "room:!room:example",
        currentThreadTs: "$thread",
        currentMessageId: "$reply",
        replyToMode,
        hasRepliedRef: { value: true },
      };
      const resolved = matrixPlugin.threading!.resolveAutoThreadId!({
        cfg,
        accountId: "default",
        to: target,
        toolContext,
        replyToId: "$explicit-reply",
      });
      await matrixPlugin.actions!.handleAction!({
        cfg,
        channel: "matrix",
        action: "send",
        accountId: "default",
        toolContext,
        params: {
          to: target,
          message: "threaded native action",
          replyTo: "$explicit-reply",
          ...(resolved ? { threadId: resolved } : {}),
        },
      });
      expect(mocks.sendMessageMatrix).toHaveBeenCalledOnce();
      expect(mocks.sendMessageMatrix.mock.lastCall?.[0]).toBe(target);
      expect(mockOptions(mocks.sendMessageMatrix)).toMatchObject({
        cfg,
        accountId: "default",
        replyToId: "$explicit-reply",
        threadId,
      });
    },
  );

  it("registers durable-final capabilities and their lifecycle hooks", () => {
    expect(adapter).toMatchObject({
      durableFinal: {
        capabilities: {
          text: true,
          media: true,
          replyTo: true,
          thread: true,
          messageSendingHooks: true,
          afterCommit: true,
          reconcileUnknownSend: true,
        },
        reconcileUnknownSend: expect.any(Function),
        afterUnknownSendTerminal: expect.any(Function),
      },
      send: { text: expect.any(Function), lifecycle: { afterCommit: expect.any(Function) } },
    });
  });

  it.each(["text", "voice"] as const)(
    "forwards durable %s options and projects its receipt",
    async (kind) => {
      const options = {
        accountId: "default",
        deliveryQueueId: "queue-1",
        deliveryPartIndex: 2,
        deliveryPartCount: 3,
        replyToId: "$reply",
        threadId: "$thread",
        ...(kind === "voice"
          ? {
              mediaUrl: "file:///tmp/cat.png",
              mediaLocalRoots: ["/tmp/openclaw"],
              audioAsVoice: true,
            }
          : {}),
      };
      const result = await (kind === "voice" ? sendMedia : sendText)({
        ...context,
        text: "hello",
        ...options,
      });
      expect(mocks.sendMessageMatrix).toHaveBeenCalledOnce();
      expectSend(mocks.sendMessageMatrix, "hello", options);
      expect(mockOptions(mocks.sendMessageMatrix).cfg).toBe(cfg);
      expect(result.receipt).toMatchObject({
        platformMessageIds: ["$event-1"],
        parts: [{ kind }],
        replyToId: "$reply",
        threadId: "$thread",
      });
    },
  );
});
