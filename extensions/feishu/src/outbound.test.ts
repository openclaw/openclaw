// Feishu tests cover outbound plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  verifyChannelMessageAdapterCapabilityProofs,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  adaptMessagePresentationForChannel,
  renderMessagePresentationFallbackText,
  renderPresentationForDelivery,
  type MessagePresentation,
  type MessagePresentationAction,
} from "openclaw/plugin-sdk/interactive-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/markdown-table-runtime";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, ReplyPayload } from "../runtime-api.js";
import {
  FEISHU_SELECTED_SECRET_ENV,
  FEISHU_SIBLING_SECRET_ENV,
  createFeishuSecretRefPolicyConfig,
  feishuSecretRefPolicyCases,
} from "./bot.test-support.js";
import type { FeishuClientCredentials } from "./client.js";

const sendMediaFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendCardFeishuMock = vi.hoisted(() => vi.fn());
const sendStructuredCardFeishuMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() =>
  vi.fn((_account: FeishuClientCredentials) => ({ request: vi.fn() })),
);
const deliverCommentThreadTextMock = vi.hoisted(() => vi.fn());
const cleanupAmbientCommentTypingReactionMock = vi.hoisted(() => vi.fn(async () => false));
const shouldSuppressFeishuTextForVoiceMediaMock = vi.hoisted(
  () =>
    (params: {
      mediaUrl?: string;
      audioAsVoice?: boolean;
      ttsSupplement?: { visibleTextAlreadyDelivered?: boolean };
    }) =>
      params.ttsSupplement
        ? params.ttsSupplement.visibleTextAlreadyDelivered === true
        : params.audioAsVoice === true || /\.(?:ogg|opus)(?:[?#]|$)/i.test(params.mediaUrl ?? ""),
);
const resolvePinnedHostnameWithPolicyMock = vi.hoisted(() =>
  vi.fn(async (hostname: string) => {
    if (hostname === "files.example.test") {
      throw new Error("Blocked: resolves to private/internal/special-use IP address");
    }
    return {
      hostname,
      addresses: ["93.184.216.34"],
      lookup: vi.fn(),
    };
  }),
);

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolvePinnedHostnameWithPolicy: resolvePinnedHostnameWithPolicyMock,
  };
});

vi.mock("./media.js", () => ({
  sendMediaFeishu: sendMediaFeishuMock,
  sendStickerFeishu: vi.fn(),
  shouldSuppressFeishuTextForVoiceMedia: shouldSuppressFeishuTextForVoiceMediaMock,
}));

vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  editMessageFeishu: vi.fn(),
  getMessageFeishu: vi.fn(),
  sendCardFeishu: sendCardFeishuMock,
  sendMessageFeishu: sendMessageFeishuMock,
  sendStructuredCardFeishu: sendStructuredCardFeishuMock,
  resolveFeishuCardTemplate: (template?: string) =>
    new Set([
      "blue",
      "green",
      "red",
      "orange",
      "purple",
      "indigo",
      "wathet",
      "turquoise",
      "yellow",
      "grey",
      "carmine",
      "violet",
      "lime",
    ]).has(template ?? "")
      ? template
      : undefined,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    channel: {
      text: {
        chunkMarkdownText: (text: string) => [text],
      },
    },
  }),
}));

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./drive.js", () => ({
  deliverCommentThreadText: deliverCommentThreadTextMock,
}));

vi.mock("./comment-reaction.js", () => ({
  cleanupAmbientCommentTypingReaction: cleanupAmbientCommentTypingReactionMock,
}));

import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import { feishuPlugin } from "./channel.js";
import { FEISHU_PROPAGATE_MEDIA_UPLOAD_FAILURE_MARKER, feishuOutbound } from "./outbound.js";

async function raceWithNextMacrotask<T>(promise: Promise<T>): Promise<T | "pending"> {
  return await Promise.race([
    promise,
    new Promise<"pending">((resolve) => {
      setImmediate(() => resolve("pending"));
    }),
  ]);
}

type FeishuSendText = NonNullable<typeof feishuOutbound.sendText>;
type FeishuMessageAdapter = NonNullable<typeof feishuPlugin.message>;
type FeishuMessageSender = NonNullable<FeishuMessageAdapter["send"]>;

function requireFeishuSendText(): FeishuSendText {
  const sendText = feishuOutbound.sendText;
  if (!sendText) {
    throw new Error("Expected Feishu outbound sendText");
  }
  return sendText;
}

function requireFeishuMessageAdapter(): FeishuMessageAdapter {
  const adapter = feishuPlugin.message;
  if (!adapter) {
    throw new Error("Expected Feishu message adapter");
  }
  return adapter;
}

function requireFeishuTextSender(
  adapter: FeishuMessageAdapter,
): NonNullable<FeishuMessageSender["text"]> {
  const text = adapter.send?.text;
  if (!text) {
    throw new Error("Expected Feishu message adapter text sender");
  }
  return text;
}

function requireFeishuMediaSender(
  adapter: FeishuMessageAdapter,
): NonNullable<FeishuMessageSender["media"]> {
  const media = adapter.send?.media;
  if (!media) {
    throw new Error("Expected Feishu message adapter media sender");
  }
  return media;
}

const sendText = requireFeishuSendText();
const emptyConfig: ClawdbotConfig = {};
const outboundContext = { cfg: emptyConfig, to: "chat_1", accountId: "main" };
const cardRenderConfig: ClawdbotConfig = {
  channels: {
    feishu: {
      renderMode: "card",
    },
  },
};

const tableMarkdown = "| Name | Role |\n| --- | --- |\n| Ada | Lead |";
// GFM makes the outer pipes optional, and a fence hides rows that only look like a table.
// Our parser finds a table in these two, but the card renderer does not draw one.
// It does not descend into a blockquote, and it claims the leading list marker
// for a list. Either way the rows would leave the message, so they take the post
// path and arrive as a fenced block instead.
// Root credentials make the implicit default account configured, so a send
// without an account id resolves to it and reads the channel value.
const tableModeConfig: ClawdbotConfig = {
  channels: {
    feishu: {
      appId: "cli_a1",
      appSecret: "local-test-placeholder", // pragma: allowlist secret
      renderMode: "raw",
      markdown: { tables: "bullets" },
      accounts: { work: { markdown: { tables: "off" } } },
    },
  },
};

function createOversizedTablePresentation() {
  return adaptMessagePresentationForChannel({
    presentation: {
      blocks: [
        {
          type: "table",
          caption: "Large pipeline",
          headers: ["Account", "Stage"],
          rows: Array.from({ length: 400 }, (_entry, index) => [
            `account-${String(index)}-${"x".repeat(80)}`,
            "Review",
          ]),
        },
      ],
    },
    capabilities: feishuOutbound.presentationCapabilities,
  });
}

function createElementLimitedCommandPresentation(): MessagePresentation {
  return {
    blocks: [
      ...Array.from({ length: 200 }, () => ({ type: "divider" as const })),
      {
        type: "buttons",
        buttons: [
          {
            label: "Approve",
            action: { type: "command", command: "/approve req_1" },
          },
        ],
      },
    ],
  };
}

afterAll(() => {
  vi.doUnmock("./media.js");
  vi.doUnmock("./send.js");
  vi.doUnmock("./runtime.js");
  vi.doUnmock("./client.js");
  vi.doUnmock("./drive.js");
  vi.doUnmock("./comment-reaction.js");
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

// The shared table-mode resolver reads config only for a registered channel id
// and takes the plugin default from its meta. The harness does not load the
// runtime setup, so register the real plugin for every test.
beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "feishu", source: "test", plugin: feishuPlugin }]),
  );
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

function resetOutboundMocks() {
  vi.clearAllMocks();
  sendMessageFeishuMock.mockResolvedValue({ messageId: "text_msg" });
  sendCardFeishuMock.mockResolvedValue({ messageId: "native_card_msg" });
  sendStructuredCardFeishuMock.mockResolvedValue({ messageId: "card_msg" });
  sendMediaFeishuMock.mockResolvedValue({ messageId: "media_msg" });
  deliverCommentThreadTextMock.mockResolvedValue({
    delivery_mode: "reply_comment",
    reply_id: "reply_msg",
  });
  cleanupAmbientCommentTypingReactionMock.mockResolvedValue(false);
}

function sendMessageCall(index = 0): Record<string, any> | undefined {
  const calls = sendMessageFeishuMock.mock.calls as unknown as Array<[Record<string, any>]>;
  return calls[index]?.[0];
}

function sendMediaCall(index = 0): Record<string, any> | undefined {
  const calls = sendMediaFeishuMock.mock.calls as unknown as Array<[Record<string, any>]>;
  return calls[index]?.[0];
}

function sendCardCall(index = 0): Record<string, any> | undefined {
  const calls = sendCardFeishuMock.mock.calls as unknown as Array<[Record<string, any>]>;
  return calls[index]?.[0];
}

function sendStructuredCardCall(index = 0): Record<string, any> | undefined {
  const calls = sendStructuredCardFeishuMock.mock.calls as unknown as Array<[Record<string, any>]>;
  return calls[index]?.[0];
}

function commentThreadParams(index = 0): Record<string, any> | undefined {
  const calls = deliverCommentThreadTextMock.mock.calls as unknown as Array<
    [unknown, Record<string, any>]
  >;
  return calls[index]?.[1];
}

function cleanupReactionCall(index = 0): Record<string, any> | undefined {
  const calls = cleanupAmbientCommentTypingReactionMock.mock.calls as unknown as Array<
    [Record<string, any>]
  >;
  return calls[index]?.[0];
}

function expectFeishuResult(result: unknown, messageId: string) {
  const typedResult = result as { channel?: string; messageId?: string } | undefined;
  expect(typedResult?.channel).toBe("feishu");
  expect(typedResult?.messageId).toBe(messageId);
}

describe("feishuOutbound.sendText local-image auto-convert", () => {
  beforeEach(() => {
    resetOutboundMocks();
  });

  it("declares message adapter durable text and media with receipt proofs", async () => {
    sendMessageFeishuMock.mockResolvedValue({
      messageId: "feishu-text-1",
      chatId: "chat-1",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ messageId: "feishu-text-1", chatId: "chat-1" }],
        kind: "text",
      }),
    });
    sendMediaFeishuMock.mockResolvedValue({
      messageId: "feishu-media-1",
      chatId: "chat-1",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ messageId: "feishu-media-1", chatId: "chat-1" }],
        kind: "media",
      }),
    });
    const adapter = requireFeishuMessageAdapter();
    const adapterSendText = requireFeishuTextSender(adapter);
    const adapterSendMedia = requireFeishuMediaSender(adapter);

    const proofs = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "feishu",
      adapter,
      proofs: {
        text: async () => {
          const onDeliveryResult = vi.fn();
          const result = await adapterSendText({
            cfg: emptyConfig,
            to: "chat:chat-1",
            text: "hello",
            accountId: "default",
            onDeliveryResult,
          });
          expect(sendMessageCall()?.to).toBe("chat:chat-1");
          expect(sendMessageCall()?.text).toBe("hello");
          expect(sendMessageCall()?.accountId).toBe("default");
          expect(result.receipt.platformMessageIds).toEqual(["feishu-text-1"]);
          expect(onDeliveryResult.mock.calls[0]?.[0]?.receipt.platformMessageIds).toEqual([
            "feishu-text-1",
          ]);
        },
        media: async () => {
          const onDeliveryResult = vi.fn();
          const mediaReadFile = vi.fn(async () => Buffer.from("approved image"));
          const mediaAccess = {
            localRoots: ["/approved/workspace"],
            workspaceDir: "/approved/workspace",
            readFile: mediaReadFile,
          };
          const result = await adapterSendMedia({
            cfg: emptyConfig,
            to: "chat:chat-1",
            text: "",
            mediaUrl: "image.png",
            mediaAccess,
            mediaLocalRoots: mediaAccess.localRoots,
            mediaReadFile,
            accountId: "default",
            onDeliveryResult,
          });
          expect(sendMediaCall()?.to).toBe("chat:chat-1");
          expect(sendMediaCall()?.mediaUrl).toBe("image.png");
          expect(sendMediaCall()?.mediaAccess).toBe(mediaAccess);
          expect(sendMediaCall()?.mediaLocalRoots).toBe(mediaAccess.localRoots);
          expect(sendMediaCall()?.mediaReadFile).toBe(mediaReadFile);
          expect(sendMediaCall()?.accountId).toBe("default");
          expect(result.receipt.platformMessageIds).toEqual(["feishu-media-1"]);
          expect(onDeliveryResult.mock.calls[0]?.[0]?.receipt.platformMessageIds).toEqual([
            "feishu-media-1",
          ]);
        },
      },
    });
    expect(proofs.some((proof) => proof.capability === "text" && proof.status === "verified")).toBe(
      true,
    );
    expect(
      proofs.some((proof) => proof.capability === "media" && proof.status === "verified"),
    ).toBe(true);
  });

  it("chunks outbound text without requiring Feishu runtime initialization", () => {
    const chunker = feishuOutbound.chunker;
    if (!chunker) {
      throw new Error("feishuOutbound.chunker missing");
    }

    expect(chunker("hello world", 5)).toEqual(["hello", "world"]);
  });

  it("preserves single newlines in chunker text (card and comment text must not be modified)", () => {
    const chunker = feishuOutbound.chunker;
    if (!chunker) {
      throw new Error("feishuOutbound.chunker missing");
    }

    const text = "line one\nline two\nline three";
    const chunks = chunker(text, 100);
    // All chunks joined should equal the original text with single newlines intact
    expect(chunks.join("")).toBe(text);
    expect(chunks.join("")).not.toContain("\n\n");
  });

  async function createTmpImage(ext = ".png"): Promise<{ dir: string; file: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-outbound-"));
    const file = path.join(dir, `sample${ext}`);
    await fs.writeFile(file, "image-data");
    return { dir, file };
  }

  it("sends missing TTS text before its voice supplement", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("approved audio"));
    const mediaAccess = {
      localRoots: ["/approved/workspace"],
      workspaceDir: "/approved/workspace",
      readFile: mediaReadFile,
    };
    const payload = {
      text: "Readable answer",
      mediaUrl: "reply.ogg",
      audioAsVoice: true,
      ttsSupplement: { spokenText: "Readable answer" },
    };

    await feishuOutbound.sendPayload?.({
      ...outboundContext,
      text: payload.text,
      mediaAccess,
      mediaLocalRoots: mediaAccess.localRoots,
      mediaReadFile,
      payload,
    });

    expect(sendMessageCall()?.text).toBe("Readable answer");
    expect(sendMediaCall()?.mediaUrl).toBe("reply.ogg");
    expect(sendMediaCall()?.mediaAccess).toBe(mediaAccess);
    expect(sendMediaCall()?.mediaReadFile).toBe(mediaReadFile);
    expect(sendMediaCall()?.audioAsVoice).toBe(true);
    expect(sendMessageFeishuMock.mock.invocationCallOrder[0]).toBeLessThan(
      sendMediaFeishuMock.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("sends only TTS media when its text is already visible", async () => {
    const payload = {
      text: "Readable answer",
      mediaUrl: "https://example.com/reply.ogg",
      audioAsVoice: true,
      ttsSupplement: {
        spokenText: "Readable answer",
        visibleTextAlreadyDelivered: true,
      },
    };

    await feishuOutbound.sendPayload?.({
      ...outboundContext,
      text: payload.text,
      payload,
    });

    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaCall()?.mediaUrl).toBe("https://example.com/reply.ogg");
  });

  it("preserves a structured card before its TTS supplement", async () => {
    const card = {
      schema: "2.0",
      body: { elements: [{ tag: "markdown", content: "Readable answer" }] },
    };
    const payload = {
      text: "Readable answer",
      mediaUrl: "https://example.com/reply.ogg",
      audioAsVoice: true,
      ttsSupplement: { spokenText: "Readable answer" },
      channelData: { feishu: { card } },
    };

    await feishuOutbound.sendPayload?.({
      ...outboundContext,
      text: payload.text,
      payload,
    });

    expect(sendCardCall()?.card).toMatchObject(card);
    expect(sendMediaCall()?.mediaUrl).toBe("https://example.com/reply.ogg");
    expect(sendCardFeishuMock.mock.invocationCallOrder[0]).toBeLessThan(
      sendMediaFeishuMock.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each([
    { deliveryPath: "direct", presentationKind: "controls", visibleTextAlreadyDelivered: true },
    {
      deliveryPath: "core-rendered",
      presentationKind: "controls",
      visibleTextAlreadyDelivered: true,
    },
    { deliveryPath: "direct", presentationKind: "empty", visibleTextAlreadyDelivered: false },
    { deliveryPath: "direct", presentationKind: "empty", visibleTextAlreadyDelivered: true },
    {
      deliveryPath: "core-rendered",
      presentationKind: "empty-with-prose",
      visibleTextAlreadyDelivered: false,
    },
    {
      deliveryPath: "core-rendered",
      presentationKind: "empty-with-prose",
      visibleTextAlreadyDelivered: true,
    },
  ])(
    "preserves oversized presentation before TTS ($deliveryPath, prose visible: $visibleTextAlreadyDelivered, content: $presentationKind)",
    async ({ visibleTextAlreadyDelivered, deliveryPath, presentationKind }) => {
      const hasPresentationContent = presentationKind === "controls";
      const payload = {
        text: presentationKind === "empty" ? undefined : "Spoken summary",
        mediaUrl: "https://example.com/reply.ogg",
        audioAsVoice: true,
        ttsSupplement: { spokenText: "Spoken summary", visibleTextAlreadyDelivered },
        presentation: {
          blocks: hasPresentationContent
            ? [
                ...Array.from({ length: 196 }, () => ({ type: "divider" as const })),
                { type: "text" as const, text: "Presentation detail" },
                {
                  type: "buttons" as const,
                  buttons: [
                    { label: "Help", action: { type: "command" as const, command: "/help" } },
                    {
                      label: "Inspect",
                      action: { type: "callback" as const, value: "opaque-tts" },
                    },
                  ],
                },
              ]
            : Array.from({ length: 201 }, () => ({ type: "divider" as const })),
        },
      };
      const context = {
        ...outboundContext,
        text: payload.text ?? "",
        replyToId: "om_root",
        replyToIdSource: "implicit" as const,
        replyToMode: "first" as const,
      };
      let outboundPayload: ReplyPayload = payload;
      if (deliveryPath === "core-rendered") {
        const rendered = await feishuOutbound.renderPresentation?.({
          payload,
          presentation: payload.presentation,
          ctx: { ...context, payload },
        });
        if (!rendered) {
          throw new Error("expected Feishu-rendered presentation");
        }
        const { presentation: _presentation, ...coreRenderedPayload } = rendered;
        outboundPayload = coreRenderedPayload;
      }
      const onDeliveryResult = vi.fn();
      await feishuOutbound.sendPayload?.({
        ...context,
        text: outboundPayload.text ?? "",
        payload: outboundPayload,
        onDeliveryResult,
      });

      const text = sendMessageFeishuMock.mock.calls
        .map((call) => String(call[0]?.text ?? ""))
        .join("\n");
      if (hasPresentationContent) {
        expect(text).toContain("Presentation detail");
        expect(text).toContain("- Help: `/help`");
        expect(text).toContain("- Inspect");
        expect(text).not.toContain("opaque-tts");
      } else {
        expect(text).toBe(visibleTextAlreadyDelivered ? "" : "Spoken summary");
      }
      const sendsText = hasPresentationContent || !visibleTextAlreadyDelivered;
      expect(sendCardFeishuMock).not.toHaveBeenCalled();
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(sendsText ? 1 : 0);
      expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
      expect(onDeliveryResult).toHaveBeenCalledTimes(sendsText ? 2 : 1);
      expect(sendMediaCall()?.mediaUrl).toBe(payload.mediaUrl);
      expect(sendMessageCall()?.replyToMessageId).toBe(sendsText ? "om_root" : undefined);
      expect(sendMediaCall()?.replyToMessageId).toBe(sendsText ? undefined : "om_root");
      if (sendsText) {
        expect(sendMessageFeishuMock.mock.invocationCallOrder[0]).toBeLessThan(
          sendMediaFeishuMock.mock.invocationCallOrder[0] ?? 0,
        );
      }
    },
  );

  it.each([".png", ".heic"])(
    "sends an existing absolute %s image path as media instead of leaking it",
    async (extension) => {
      const { dir, file } = await createTmpImage(extension);
      const mediaReadFile = vi.fn(async () => Buffer.from("approved image"));
      const mediaAccess = { localRoots: [dir], workspaceDir: dir, readFile: mediaReadFile };
      try {
        const result = await sendText({
          ...outboundContext,
          text: file,
          mediaAccess,
          mediaLocalRoots: [dir],
          mediaReadFile,
        });

        expect(sendMediaCall()?.to).toBe("chat_1");
        expect(sendMediaCall()?.mediaUrl).toBe(file);
        expect(sendMediaCall()?.accountId).toBe("main");
        expect(sendMediaCall()?.mediaAccess).toBe(mediaAccess);
        expect(sendMediaCall()?.mediaLocalRoots).toEqual([dir]);
        expect(sendMediaCall()?.mediaReadFile).toBe(mediaReadFile);
        expect(sendMessageFeishuMock).not.toHaveBeenCalled();
        expectFeishuResult(result, "media_msg");
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );

  it("keeps non-path text on the text-send path", async () => {
    await sendText({
      ...outboundContext,
      text: "please upload /tmp/example.png",
    });

    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expect(sendMessageCall()?.to).toBe("chat_1");
    expect(sendMessageCall()?.text).toBe("please upload /tmp/example.png");
    expect(sendMessageCall()?.accountId).toBe("main");
  });

  it("resolves the markdown table mode for the named account on the post path", async () => {
    await sendText({
      cfg: tableModeConfig,
      to: "chat_1",
      text: tableMarkdown,
      accountId: "work",
    });
    await sendText({ cfg: tableModeConfig, to: "chat_1", text: tableMarkdown });

    expect(sendMessageCall(0)?.text).toBe(tableMarkdown);
    expect(sendMessageCall(1)?.text).toBe("**Ada**  \n• Role: Lead");
  });

  it("sends wrapped interactive card text as a native Feishu card", async () => {
    const text = JSON.stringify({
      type: "interactive",
      card: {
        body: {
          elements: [{ tag: "markdown", content: "Wrapped body" }],
        },
      },
    });

    const result = await sendText({
      ...outboundContext,
      text,
      replyToId: "om_reply_1",
    });

    expect(sendCardCall()?.to).toBe("chat_1");
    expect(sendCardCall()?.accountId).toBe("main");
    expect(sendCardCall()?.replyToMessageId).toBe("om_reply_1");
    expect(sendCardCall()?.card?.body?.elements).toEqual([
      { tag: "markdown", content: "Wrapped body" },
    ]);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expectFeishuResult(result, "native_card_msg");
  });

  it("does not leak local-image paths if auto-send fails", async () => {
    const { dir, file } = await createTmpImage();
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("upload failed"));
    try {
      await sendText({
        ...outboundContext,
        text: file,
      });

      expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
      expect(sendMessageCall()?.to).toBe("chat_1");
      expect(sendMessageCall()?.text).toBe("Media upload failed. Please try again.");
      expect(sendMessageCall()?.text).not.toContain(file);
      expect(sendMessageCall()?.accountId).toBe("main");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("does not send fallback text after an accepted local-image send loses its receipt", async () => {
    const { dir, file } = await createTmpImage();
    const acceptedError = createChannelPartialDeliveryError(
      new Error("Feishu image reply failed: no message_id returned"),
      { messageIds: [], visibleReplySent: true },
    );
    sendMediaFeishuMock.mockRejectedValueOnce(acceptedError);

    try {
      await expect(
        sendText({
          ...outboundContext,
          text: file,
          mediaLocalRoots: [dir],
        }),
      ).rejects.toBe(acceptedError);
      expect(sendMediaFeishuMock).toHaveBeenCalledOnce();
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("does not send fallback text when accepted local-image progress cannot be persisted", async () => {
    const { dir, file } = await createTmpImage();
    const onDeliveryResult = vi.fn().mockRejectedValueOnce(new Error("progress write failed"));

    try {
      await expect(
        sendText({
          ...outboundContext,
          text: file,
          mediaLocalRoots: [dir],
          onDeliveryResult,
        }),
      ).rejects.toThrow("progress write failed");
      expect(sendMediaFeishuMock).toHaveBeenCalledOnce();
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      expect(onDeliveryResult).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // A comment carries no card, and the comment sender converts for its own chunker and
  // keeps the authored form when the markers would not survive the cut. Converting the
  // fallback before it gets there handed it a conversion it could not undo.
  it("keeps a presentation comment readable when its fences cannot survive the cut", async () => {
    const rows = Array.from({ length: 40 }, (_entry, index) => `> | row${index} | d |`);
    const table = [
      "> | name | detail |",
      "> | --- | --- |",
      ...rows,
      `> | wide | ${"w".repeat(220)} |`,
    ].join("\n");
    const cfg = {
      channels: { feishu: { accounts: { main: { markdown: { tables: "code" } } } } },
    } as ClawdbotConfig;
    const to = "comment:docx:doxcn123:7623358762119646411";
    // The case only means anything while the conversion carries quoted markers and needs
    // more than one comment to arrive.
    expect(convertMarkdownTables(table, "code")).toContain("> ```");
    expect(convertMarkdownTables(table, "code").length).toBeGreaterThan(4000);

    const payload = { presentation: { blocks: [{ type: "text", text: table }] } };
    const rendered = await renderPresentationForDelivery(
      {
        presentationCapabilities: feishuOutbound.presentationCapabilities,
        renderPresentation: async (adapted, sourcePresentation) =>
          await feishuOutbound.renderPresentation!({
            payload: adapted,
            presentation: adapted.presentation,
            sourcePresentation,
            ctx: { cfg, to, text: "", accountId: "main", payload: adapted } as never,
          }),
      },
      payload as never,
    );
    await sendText({ cfg, to, text: rendered.text ?? "", accountId: "main" });

    const contents = deliverCommentThreadTextMock.mock.calls.map((_call, index) =>
      String(commentThreadParams(index)?.content ?? ""),
    );
    expect(contents.length).toBeGreaterThan(0);
    for (const content of contents) {
      // A comment opens and closes its own fences or carries none at all.
      expect((content.match(/^> ```/gmu) ?? []).length % 2).toBe(0);
    }
    expect(contents.join("")).toContain("row39");
  });

  // A conversion hides its table inside a fence before the card question is asked, so
  // asking only whether a table fits one card answered nothing for a quoted one, and the
  // card chunker cannot close and reopen a quoted marker.
  it("keeps a quoted table off the card path when its fences cannot survive the cut", async () => {
    const rows = Array.from({ length: 40 }, (_entry, index) => `> | row${index} | d |`);
    const table = [
      "> | name | detail |",
      "> | --- | --- |",
      ...rows,
      `> | wide | ${"w".repeat(220)} |`,
    ].join("\n");
    // The case only means anything while the conversion carries quoted markers and needs
    // more room than one card has.
    expect(convertMarkdownTables(table, "code")).toContain("> ```");
    expect(convertMarkdownTables(table, "code").length).toBeGreaterThan(4000);

    await sendText({
      cfg: {
        channels: {
          feishu: {
            renderMode: "card",
            accounts: { main: { markdown: { tables: "code" } } },
          },
        },
      } as ClawdbotConfig,
      to: "chat_1",
      text: table,
      accountId: "main",
    });

    const delivered = [
      ...sendStructuredCardFeishuMock.mock.calls,
      ...sendMessageFeishuMock.mock.calls,
    ].map((call) => String(call[0]?.text ?? ""));
    expect(delivered.length).toBeGreaterThan(0);
    for (const message of delivered) {
      // A message opens and closes its own fences or carries none at all.
      expect((message.match(/^> ```/gmu) ?? []).length % 2).toBe(0);
    }
    expect(delivered.join("")).toContain("row39");
  });

  it("strips prose from identity emoji in renderMode card headers", async () => {
    const result = await sendText({
      cfg: cardRenderConfig,
      to: "chat_1",
      text: "| a | b |\n| - | - |",
      accountId: "main",
      identity: {
        name: "Agent",
        emoji: "根据心情/语气自由切换 😊🇺🇸👍🏽👨‍👩‍👧‍👦",
      },
    });

    expect(sendStructuredCardCall()?.header).toEqual({
      title: "😊🇺🇸👍🏽👨‍👩‍👧‍👦 Agent",
      template: "blue",
    });
    expectFeishuResult(result, "card_msg");
  });

  it("falls back to threadId when replyToId is empty on sendText", async () => {
    await sendText({
      ...outboundContext,
      text: "hello",
      replyToId: " ",
      threadId: "om_thread_2",
    });

    expect(sendMessageCall()?.to).toBe("chat_1");
    expect(sendMessageCall()?.text).toBe("hello");
    expect(sendMessageCall()?.replyToMessageId).toBe("om_thread_2");
    expect(sendMessageCall()?.replyInThread).toBe(true);
    expect(sendMessageCall()?.accountId).toBe("main");
  });
});

describe("feishuOutbound.sendText receipt-less acceptance", () => {
  // Feishu accepting a send without returning a message id raises a partial-delivery error
  // by design, because an ordinary error would invite a duplicate retry. That text still
  // reached the reader, so the content this reports has to carry it. Reporting only the
  // chunks whose sender returned tells the turn a message it delivered was never sent.
  it("reports a chunk Feishu accepted without a receipt as delivered content", async () => {
    const sent: string[] = [];
    sendMessageFeishuMock.mockImplementation(async ({ text }: { text: string }) => {
      sent.push(text);
      if (sent.length === 1) {
        return { messageId: "chunk_1", chatId: "chat_1" };
      }
      throw createChannelPartialDeliveryError(
        new Error("Feishu send failed: no message_id returned"),
        { messageIds: [], visibleReplySent: true },
      );
    });

    let caught: unknown;
    try {
      await feishuOutbound.sendText?.({
        ...outboundContext,
        text: "x".repeat(5_000),
      } as never);
    } catch (err) {
      caught = err;
    }

    expect(isChannelPartialDeliveryError(caught)).toBe(true);
    const partial = caught as ReturnType<typeof createChannelPartialDeliveryError>;
    // Guard the fixture: one chunk would not exercise the accounting at all.
    expect(sent.length).toBe(2);
    // Length first, so a regression reads as two numbers rather than two walls of x.
    expect(partial.deliveryResult.content?.length).toBe(sent.join("").length);
    expect(partial.deliveryResult.content).toBe(sent.join(""));
  });

  // The other direction is worse: a send that genuinely failed must not be reported as
  // delivered text, which is what the catch was added for in the first place.
  it("leaves a chunk out of delivered content when its send genuinely failed", async () => {
    const sent: string[] = [];
    sendMessageFeishuMock.mockImplementation(async ({ text }: { text: string }) => {
      sent.push(text);
      if (sent.length === 1) {
        return { messageId: "chunk_1", chatId: "chat_1" };
      }
      throw new Error("second chunk failed");
    });

    let caught: unknown;
    try {
      await feishuOutbound.sendText?.({
        ...outboundContext,
        text: "x".repeat(5_000),
      } as never);
    } catch (err) {
      caught = err;
    }

    expect(isChannelPartialDeliveryError(caught)).toBe(true);
    const partial = caught as ReturnType<typeof createChannelPartialDeliveryError>;
    expect(sent.length).toBe(2);
    expect(partial.deliveryResult.content?.length).toBe(sent[0]?.length);
    expect(partial.deliveryResult.content).toBe(sent[0]);
  });
});

describe("feishuOutbound.sendPayload native cards", () => {
  const nativeCardText = JSON.stringify({
    schema: "2.0",
    body: { elements: [{ tag: "markdown", content: "hello" }] },
  });

  beforeEach(() => {
    resetOutboundMocks();
  });

  async function createTmpImage(ext = ".png"): Promise<{ dir: string; file: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-payload-"));
    const file = path.join(dir, `sample${ext}`);
    await fs.writeFile(file, "image-data");
    return { dir, file };
  }

  it("records delegated post subchunks once without duplicating parent receipts", async () => {
    sendMessageFeishuMock.mockImplementation(async () => ({
      messageId: `chunk_${sendMessageFeishuMock.mock.calls.length}`,
    }));
    const onDeliveryResult = vi.fn();
    const text = Array.from({ length: 2_200 }, () => "a").join("\n");

    await feishuOutbound.sendPayload?.({
      ...outboundContext,
      text,
      payload: { text },
      onDeliveryResult,
    });

    expect(sendMessageFeishuMock.mock.calls.length).toBeGreaterThan(1);
    expect(onDeliveryResult.mock.calls.map(([result]) => result.messageId)).toEqual(
      sendMessageFeishuMock.mock.calls.map((_call, index) => `chunk_${index + 1}`),
    );
  });

  it("records separate fallback media and each expanded text chunk once", async () => {
    sendMessageFeishuMock.mockImplementation(async () => ({
      messageId: `chunk_${sendMessageFeishuMock.mock.calls.length}`,
    }));
    const onDeliveryResult = vi.fn();
    const text = Array.from({ length: 2_200 }, () => "a").join("\n");

    await feishuOutbound.sendPayload?.({
      ...outboundContext,
      text,
      payload: { text, mediaUrl: "https://example.com/image.png" },
      onDeliveryResult,
    });

    expect(sendMediaFeishuMock).toHaveBeenCalledOnce();
    expect(sendMessageFeishuMock.mock.calls.length).toBeGreaterThan(1);
    expect(onDeliveryResult.mock.calls.map(([result]) => result.messageId)).toEqual([
      "media_msg",
      ...sendMessageFeishuMock.mock.calls.map((_call, index) => `chunk_${index + 1}`),
    ]);
  });

  it("renders presentation-only payloads into Feishu channelData cards for core delivery", async () => {
    const presentation: MessagePresentation = {
      title: "Approval",
      tone: "success",
      blocks: [
        { type: "text", text: "Approve the request?" },
        {
          type: "buttons",
          buttons: [
            { label: "Approve", value: "/approve req_1 allow-once", style: "success" as const },
          ],
        },
      ],
    };
    const payload = { presentation };
    const rendered = await feishuOutbound.renderPresentation?.({
      payload,
      presentation,
      ctx: {
        ...outboundContext,
        text: "",
        payload,
      },
    });

    if (!rendered) {
      throw new Error("expected Feishu presentation renderer to return a payload");
    }
    expect(rendered.text).toBe("Approval\n\nApprove the request?\n\n- Approve");
    const renderedChannelData = rendered.channelData as
      | { feishu?: { card?: Record<string, any> } }
      | undefined;
    const renderedCard = renderedChannelData?.feishu?.card;
    expect(renderedCard?.schema).toBe("2.0");
    expect(renderedCard?.header).toEqual({
      title: { tag: "plain_text", content: "Approval" },
      template: "green",
    });
    expect(renderedCard?.body?.elements?.[0]).toEqual({
      tag: "markdown",
      content: "Approve the request?",
    });
    expect(renderedCard?.body?.elements).toEqual([
      {
        tag: "markdown",
        content: "Approve the request?",
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "Approve" },
        type: "primary",
        behaviors: [
          {
            type: "callback",
            value: {
              oc: "ocf1",
              k: "quick",
              a: "feishu.payload.button",
              q: "/approve req_1 allow-once",
            },
          },
        ],
      },
    ]);
    expect(
      renderedCard?.body?.elements?.some((element: { tag?: string }) => element.tag === "action"),
    ).toBe(false);
    const { presentation: _presentation, ...coreRenderedPayload } = rendered;
    const result = await feishuOutbound.sendPayload?.({
      ...outboundContext,
      text: coreRenderedPayload.text ?? "",
      payload: coreRenderedPayload,
    });

    expect(sendCardCall()?.to).toBe("chat_1");
    expect(sendCardCall()?.card?.header).toEqual({
      title: { tag: "plain_text", content: "Approval" },
      template: "green",
    });
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expectFeishuResult(result, "native_card_msg");
  });

  it.each(["title", "text", "context"] as const)(
    "delivers complete authored %s through native presentation cards",
    async (kind) => {
      const text = `${"x".repeat(3999)} \n  TAIL_NOT_DELIVERED`;
      const original: MessagePresentation =
        kind === "title" ? { title: text, blocks: [] } : { blocks: [{ type: kind, text }] };
      const presentation = adaptMessagePresentationForChannel({
        presentation: original,
        capabilities: feishuOutbound.presentationCapabilities,
      });
      const payload = { presentation };
      const rendered = await feishuOutbound.renderPresentation?.({
        payload,
        presentation,
        ctx: { cfg: emptyConfig, to: "chat_1", text: "", accountId: "main", payload },
      });
      if (!rendered) {
        throw new Error("expected native Feishu presentation");
      }
      expect(rendered.text).toBe(text);
      const { presentation: _presentation, ...coreRenderedPayload } = rendered;
      await feishuOutbound.sendPayload?.({
        ...outboundContext,
        text: rendered.text ?? "",
        payload: coreRenderedPayload,
      });
      const card = sendCardCall()?.card;
      expect(JSON.stringify(card)).toContain("TAIL_NOT_DELIVERED");
      expect(
        [
          card?.header?.title?.content ?? "",
          ...(card?.body?.elements ?? []).map((element: { content?: string }) =>
            (element.content ?? "").replace(/<\/?font[^>]*>/gu, ""),
          ),
        ].join(""),
      ).toBe(text);
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    },
  );

  it("renders webApp presentation buttons into Feishu channelData link buttons", async () => {
    const presentation: MessagePresentation = {
      blocks: [
        {
          type: "buttons",
          buttons: [{ label: "Open app", webApp: { url: "https://example.com/app" } }],
        },
      ],
    };
    const payload = { presentation };
    const rendered = await feishuOutbound.renderPresentation?.({
      payload,
      presentation,
      ctx: {
        ...outboundContext,
        text: "",
        payload,
      },
    });

    if (!rendered) {
      throw new Error("expected Feishu presentation renderer to return a payload");
    }
    expect(rendered.text).toBe("- Open app: https://example.com/app");
    const renderedChannelData = rendered.channelData as
      | { feishu?: { card?: Record<string, any> } }
      | undefined;
    expect(renderedChannelData?.feishu?.card?.body?.elements).toEqual([
      {
        tag: "button",
        text: { tag: "plain_text", content: "Open app" },
        type: "default",
        behaviors: [{ type: "open_url", default_url: "https://example.com/app" }],
      },
    ]);
  });

  it("falls back to chunked text when a table exceeds the Feishu card envelope", async () => {
    const presentation = createOversizedTablePresentation();
    presentation.blocks.push({
      type: "buttons",
      buttons: [
        { label: "Unavailable link", url: "javascript:alert(1)" },
        { label: "Docs", action: { type: "url", url: "https://example.com/docs" } },
        { label: "Help", action: { type: "command", command: "/help" } },
        {
          label: "[Inspect](https://example.com/label)",
          action: { type: "callback", value: "opaque-inspect" },
        },
        { label: "Disabled", disabled: true, action: { type: "command", command: "/disabled" } },
      ],
    });
    const rawCardText = JSON.stringify({
      schema: "2.0",
      body: { elements: [{ tag: "markdown", content: "Raw card JSON must stay hidden" }] },
    });
    const payload = { text: rawCardText, presentation };
    const rendered = await feishuOutbound.renderPresentation?.({
      payload,
      presentation,
      ctx: {
        ...outboundContext,
        text: "",
        payload,
      },
    });
    if (!rendered) {
      throw new Error("expected explicit Feishu fallback payload");
    }
    const directResult = await feishuOutbound.sendPayload?.({
      ...outboundContext,
      text: rawCardText,
      payload,
    });
    const directDeliveredText = sendMessageFeishuMock.mock.calls
      .map((call) => String(call[0]?.text ?? ""))
      .join("\n");
    sendMessageFeishuMock.mockClear();
    const { presentation: _presentation, ...coreRenderedPayload } = rendered;
    const result = await feishuOutbound.sendPayload?.({
      ...outboundContext,
      text: coreRenderedPayload.text ?? "",
      payload: coreRenderedPayload,
    });
    const textChunks = sendMessageFeishuMock.mock.calls.map((call) => String(call[0]?.text ?? ""));
    const deliveredText = textChunks.join("\n");

    expect(presentation.blocks.length).toBeGreaterThan(1);
    expect(
      Buffer.byteLength(renderMessagePresentationFallbackText({ presentation }), "utf8"),
    ).toBeGreaterThan(30 * 1024);
    expect(rendered.text).not.toContain("Raw card JSON must stay hidden");
    expect(rendered.text).not.toContain(rawCardText);
    expect(directDeliveredText).toContain("account-0-");
    expect(directDeliveredText).toContain("account-399-");
    expect(directDeliveredText).not.toContain("Raw card JSON must stay hidden");
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(textChunks.length).toBeGreaterThan(1);
    expect(deliveredText).toContain("account-0-");
    expect(deliveredText).toContain("account-399-");
    expect(deliveredText).not.toContain("Raw card JSON must stay hidden");
    for (const text of [directDeliveredText, deliveredText]) {
      expect(text).toContain("- Unavailable link");
      expect(text).not.toContain("javascript:");
      expect(text).toContain("- Docs: https://example.com/docs");
      expect(text).toContain("- Help: `/help`");
      expect(text).toContain("- \\[Inspect\\]\\(https://example.com/label\\)");
      expect(text).not.toContain("opaque-inspect");
      expect(text).toContain("- Disabled");
      expect(text).not.toContain("/disabled");
    }
    expectFeishuResult(directResult, "text_msg");
    expectFeishuResult(result, "text_msg");
  });

  it("sends media once before chunking an oversized table fallback", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("approved image"));
    const mediaAccess = {
      localRoots: ["/approved/workspace"],
      workspaceDir: "/approved/workspace",
      readFile: mediaReadFile,
    };
    const presentation = createOversizedTablePresentation();
    const rendered = await feishuOutbound.renderPresentation?.({
      payload: { presentation, mediaUrl: "pipeline.png" },
      presentation,
      ctx: {
        ...outboundContext,
        text: "",
        payload: { presentation, mediaUrl: "pipeline.png" },
      },
    });
    if (!rendered) {
      throw new Error("expected explicit Feishu fallback payload");
    }
    const { presentation: _presentation, ...coreRenderedPayload } = rendered;

    const result = await feishuOutbound.sendPayload?.({
      ...outboundContext,
      text: coreRenderedPayload.text ?? "",
      mediaAccess,
      mediaLocalRoots: mediaAccess.localRoots,
      mediaReadFile,
      replyToId: "   ",
      threadId: "om_thread",
      payload: coreRenderedPayload,
    });
    const textSendParams = sendMessageFeishuMock.mock.calls.map((call) => call[0]);
    const textChunks = textSendParams.map((params) => String(params?.text ?? ""));
    const deliveredText = textChunks.join("\n");

    expect(rendered.text).toContain("account-399-");
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaCall()).toEqual(
      expect.objectContaining({
        to: "chat_1",
        mediaUrl: "pipeline.png",
        mediaAccess,
        mediaLocalRoots: mediaAccess.localRoots,
        mediaReadFile,
      }),
    );
    expect(sendMediaCall()?.mediaAccess).toBe(mediaAccess);
    expect(sendMediaCall()?.text).toBeUndefined();
    expect(sendMediaCall()?.replyToMessageId).toBe("om_thread");
    expect(sendMediaCall()?.replyInThread).toBe(true);
    expect(textChunks.length).toBeGreaterThan(1);
    expect(
      textSendParams.every(
        (params) => params?.replyToMessageId === "om_thread" && params.replyInThread === true,
      ),
    ).toBe(true);
    expect(deliveredText).toContain("account-0-");
    expect(deliveredText).toContain("account-399-");
    expectFeishuResult(result, "text_msg");
  });

  it("preserves command guidance in core-rendered element-limit fallbacks for comments", async () => {
    const presentation = createElementLimitedCommandPresentation();
    const payload = { presentation };
    const rendered = await feishuOutbound.renderPresentation?.({
      payload,
      presentation,
      ctx: {
        ...outboundContext,
        text: "",
        payload,
      },
    });
    if (!rendered) {
      throw new Error("expected explicit Feishu fallback payload");
    }
    const { presentation: _presentation, ...coreRenderedPayload } = rendered;

    const result = await feishuOutbound.sendPayload?.({
      cfg: emptyConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: coreRenderedPayload.text ?? "",
      accountId: "main",
      payload: coreRenderedPayload,
    });

    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(commentThreadParams()?.content).toBe(
      "- Approve: `/approve req_1`\n\n> Interactive buttons are unavailable in Feishu document comments. You can type the command shown above manually.",
    );
    expectFeishuResult(result, "reply_msg");
  });

  it("consumes a single-use reply once for short element-limit fallback media", async () => {
    const presentation = createElementLimitedCommandPresentation();
    const payload = { presentation, mediaUrl: "/tmp/pipeline.png" };
    const rendered = await feishuOutbound.renderPresentation?.({
      payload,
      presentation,
      ctx: {
        ...outboundContext,
        text: "",
        payload,
      },
    });
    if (!rendered) {
      throw new Error("expected explicit Feishu fallback payload");
    }
    const { presentation: _presentation, ...coreRenderedPayload } = rendered;

    const result = await feishuOutbound.sendPayload?.({
      ...outboundContext,
      text: coreRenderedPayload.text ?? "",
      replyToId: "om_reply",
      replyToIdSource: "implicit",
      replyToMode: "first",
      payload: coreRenderedPayload,
    });

    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaCall()).toMatchObject({
      mediaUrl: "/tmp/pipeline.png",
      replyToMessageId: "om_reply",
    });
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageCall()).toMatchObject({
      text: "- Approve: `/approve req_1`",
      replyToMessageId: undefined,
    });
    expectFeishuResult(result, "text_msg");
  });

  it("consumes a single-use reply target on media before fallback text chunks", async () => {
    const fallbackText = renderMessagePresentationFallbackText({
      presentation: createOversizedTablePresentation(),
    });

    await feishuOutbound.sendPayload?.({
      ...outboundContext,
      text: fallbackText,
      replyToId: "om_reply",
      replyToIdSource: "implicit",
      replyToMode: "first",
      payload: {
        text: fallbackText,
        mediaUrl: "/tmp/pipeline.png",
      },
    });

    expect(sendMediaCall()?.replyToMessageId).toBe("om_reply");
    expect(sendMessageFeishuMock).toHaveBeenCalled();
    expect(
      sendMessageFeishuMock.mock.calls.every((call) => call[0]?.replyToMessageId === undefined),
    ).toBe(true);
  });

  it("keeps oversized media fallbacks on Feishu document comment targets", async () => {
    const fallbackText = renderMessagePresentationFallbackText({
      presentation: createOversizedTablePresentation(),
    });

    const result = await feishuOutbound.sendPayload?.({
      cfg: emptyConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: fallbackText,
      accountId: "main",
      payload: {
        text: fallbackText,
        mediaUrl: "https://example.com/pipeline.png",
      },
    });
    const commentText = deliverCommentThreadTextMock.mock.calls
      .slice(1)
      .map((_call, index) => String(commentThreadParams(index + 1)?.content ?? ""))
      .join("\n");

    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expect(commentThreadParams()?.content).toBe("https://example.com/pipeline.png");
    expect(deliverCommentThreadTextMock.mock.calls.length).toBeGreaterThan(2);
    expect(commentText).toContain("account-0-");
    expect(commentText).toContain("account-399-");
    expectFeishuResult(result, "reply_msg");
  });

  it("separates comment media from a chunked in-envelope presentation fallback", async () => {
    const presentation: MessagePresentation = {
      blocks: [
        {
          type: "table",
          caption: "Pipeline",
          headers: ["Account", "Stage"],
          rows: Array.from({ length: 90 }, (_entry, index) => [
            `account-${String(index)}-${"x".repeat(48)}`,
            "Review",
          ]),
        },
      ],
    };
    const rendered = await feishuOutbound.renderPresentation?.({
      payload: { presentation },
      presentation,
      ctx: {
        ...outboundContext,
        text: "",
        payload: { presentation },
      },
    });
    const renderedCard = (
      rendered?.channelData as { feishu?: { card?: Record<string, unknown> } } | undefined
    )?.feishu?.card;

    const result = await feishuOutbound.sendPayload?.({
      cfg: emptyConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: "",
      accountId: "main",
      payload: {
        presentation,
        mediaUrl: "https://example.com/pipeline.png",
      },
    });
    const commentTexts = deliverCommentThreadTextMock.mock.calls.map((_call, index) =>
      String(commentThreadParams(index)?.content ?? ""),
    );
    const fallbackChunks = commentTexts.slice(1);

    expect(renderedCard).toBeDefined();
    expect(commentTexts[0]).toBe("https://example.com/pipeline.png");
    expect(fallbackChunks.length).toBeGreaterThan(1);
    expect(fallbackChunks.every((chunk) => Array.from(chunk).length <= 4000)).toBe(true);
    expect(fallbackChunks.join("\n")).toContain("account-89-");
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expectFeishuResult(result, "reply_msg");
  });

  it("ignores oversized native card data for document comment text delivery", async () => {
    const result = await feishuOutbound.sendPayload?.({
      cfg: emptyConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: "Safe comment fallback",
      accountId: "main",
      payload: {
        text: "Safe comment fallback",
        channelData: {
          feishu: {
            card: {
              schema: "2.0",
              body: {
                elements: [{ tag: "markdown", content: "x".repeat(31 * 1024) }],
              },
            },
          },
        },
      },
    });

    expect(commentThreadParams()?.content).toBe("Safe comment fallback");
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expectFeishuResult(result, "reply_msg");
  });

  it("rejects oversized caller-supplied native cards instead of leaking their JSON as text", async () => {
    await expect(
      feishuOutbound.sendPayload?.({
        ...outboundContext,
        text: "safe fallback",
        payload: {
          text: "safe fallback",
          channelData: {
            feishu: {
              card: {
                schema: "2.0",
                body: {
                  elements: [{ tag: "markdown", content: "x".repeat(31 * 1024) }],
                },
              },
            },
          },
        },
      }),
    ).rejects.toThrow("Feishu native card exceeds the 30 KB or 200-element API limit");

    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it.each(["url", "web-app"] as const)(
    "renders typed %s presentation actions as Feishu link buttons",
    async (type) => {
      const presentation: MessagePresentation = {
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Review",
                action: { type, url: "https://example.com/review" } as MessagePresentationAction,
              },
            ],
          },
        ],
      };
      const payload = { presentation };
      const rendered = await feishuOutbound.renderPresentation?.({
        payload,
        presentation,
        ctx: {
          ...outboundContext,
          text: "",
          payload,
        },
      });

      const renderedChannelData = rendered?.channelData as
        | { feishu?: { card?: Record<string, any> } }
        | undefined;
      expect(rendered?.text).toBe("- Review: https://example.com/review");
      expect(renderedChannelData?.feishu?.card?.body?.elements).toEqual([
        {
          tag: "button",
          text: { tag: "plain_text", content: "Review" },
          type: "default",
          behaviors: [{ type: "open_url", default_url: "https://example.com/review" }],
        },
      ]);
    },
  );

  it("keeps explicit command actions authoritative over deprecated link fields", async () => {
    const presentation: MessagePresentation = {
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Deny",
              action: { type: "command", command: "/approve req-1 deny" },
              url: "https://example.com/stale",
              webApp: { url: "https://example.com/stale-app" },
            },
          ],
        },
      ],
    };
    const payload = { presentation };
    const rendered = await feishuOutbound.renderPresentation?.({
      payload,
      presentation,
      ctx: {
        ...outboundContext,
        text: "",
        payload,
      },
    });

    const renderedChannelData = rendered?.channelData as
      | { feishu?: { card?: Record<string, any> } }
      | undefined;
    expect(renderedChannelData?.feishu?.card?.body?.elements).toEqual([
      {
        tag: "button",
        text: { tag: "plain_text", content: "Deny" },
        type: "default",
        behaviors: [
          {
            type: "callback",
            value: createFeishuCardInteractionEnvelope({
              k: "quick",
              a: "feishu.payload.button",
              q: "/approve req-1 deny",
            }),
          },
        ],
      },
    ]);
  });

  it("keeps typed approval actions out of Feishu callback envelopes", async () => {
    const presentation: MessagePresentation = {
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Allow",
              action: {
                type: "approval",
                approvalId: "approval-1",
                approvalKind: "plugin",
                decision: "allow-once",
              },
              value: "/approve approval-1 allow-once",
            },
          ],
        },
      ],
    };
    const payload = { presentation };
    const rendered = await feishuOutbound.renderPresentation?.({
      payload,
      presentation,
      ctx: {
        ...outboundContext,
        text: "",
        payload,
      },
    });

    const renderedChannelData = rendered?.channelData as
      | { feishu?: { card?: Record<string, any> } }
      | undefined;
    expect(rendered?.text).toBe("- Allow");
    expect(renderedChannelData?.feishu?.card?.body?.elements).toEqual([
      { tag: "markdown", content: "- Allow" },
    ]);
  });

  it("sends interactive button payloads as native Feishu cards", async () => {
    const result = await feishuOutbound.sendPayload?.({
      ...outboundContext,
      text: "Choose an action",
      identity: {
        name: "Agent",
        emoji: "根据心情/语气自由切换 😊🇺🇸👍🏽👨‍👩‍👧‍👦",
      },
      payload: {
        text: "Choose an action",
        interactive: {
          blocks: [
            { type: "text", text: "Approve the request?" },
            {
              type: "buttons",
              buttons: [
                { label: "Approve", value: "/approve req_1 allow-once", style: "success" },
                { label: "Deny", value: "/approve req_1 deny", style: "danger" },
              ],
            },
          ],
        },
      },
    });

    expect(sendCardCall()?.cfg).toBe(emptyConfig);
    expect(sendCardCall()?.to).toBe("chat_1");
    expect(sendCardCall()?.accountId).toBe("main");
    const card = sendCardCall()?.card;
    expect(card.schema).toBe("2.0");
    expect(card.header).toEqual({
      title: { tag: "plain_text", content: "😊🇺🇸👍🏽👨‍👩‍👧‍👦 Agent" },
      template: "blue",
    });
    expect(card.body.elements[0]).toEqual({ tag: "markdown", content: "Choose an action" });
    expect(card.body.elements[1]).toEqual({
      tag: "markdown",
      content: "Approve the request?",
    });
    expect(card.body.elements).toEqual([
      { tag: "markdown", content: "Choose an action" },
      {
        tag: "markdown",
        content: "Approve the request?",
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "Approve" },
        type: "primary",
        behaviors: [
          {
            type: "callback",
            value: {
              oc: "ocf1",
              k: "quick",
              a: "feishu.payload.button",
              q: "/approve req_1 allow-once",
            },
          },
        ],
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "Deny" },
        type: "danger",
        behaviors: [
          {
            type: "callback",
            value: {
              oc: "ocf1",
              k: "quick",
              a: "feishu.payload.button",
              q: "/approve req_1 deny",
            },
          },
        ],
      },
    ]);
    expect(card.body.elements.some((element: { tag?: string }) => element.tag === "action")).toBe(
      false,
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expectFeishuResult(result, "native_card_msg");
  });

  it("escapes generated markdown card text and drops unsafe button URLs", async () => {
    await feishuOutbound.sendPayload?.({
      ...outboundContext,
      text: 'Choose <at id="ou_1">',
      payload: {
        text: 'Choose <at id="ou_1">',
        presentation: {
          blocks: [
            { type: "context", text: '</font><at id="ou_2">Injected</at>' },
            {
              type: "buttons",
              buttons: [
                { label: "Open", url: "https://example.com/path" },
                { label: "Bad", url: "javascript:alert(1)" },
              ],
            },
          ],
        },
      },
    });

    const card = sendCardCall()?.card;
    expect(card.body.elements[0]).toEqual({
      tag: "markdown",
      content: 'Choose &lt;at id="ou_1"&gt;',
    });
    expect(card.body.elements[1]).toEqual({
      tag: "markdown",
      content: "<font color='grey'>&lt;/font&gt;&lt;at id=\"ou_2\"&gt;Injected&lt;/at&gt;</font>",
    });
    const buttonElement = card.body.elements.find(
      (element: { tag?: string }) => element.tag === "button",
    );
    expect(buttonElement?.text).toEqual({ tag: "plain_text", content: "Open" });
    expect(buttonElement?.behaviors).toEqual([
      { type: "open_url", default_url: "https://example.com/path" },
    ]);
    expect(JSON.stringify(card)).not.toContain("javascript:");
    expect(card.body.elements.at(-1)).toEqual({ tag: "markdown", content: "- Bad" });
  });

  it("normalizes caller-supplied native Feishu cards before sending", async () => {
    await feishuOutbound.sendPayload?.({
      ...outboundContext,
      text: "fallback",
      payload: {
        text: "fallback",
        channelData: {
          feishu: {
            card: {
              schema: "2.0",
              header: {
                title: { tag: "plain_text", content: "Unsafe card" },
                template: "not-a-template",
              },
              body: {
                elements: [
                  { tag: "img", img_key: "image-secret" },
                  { tag: "markdown", content: '<at id="ou_1">ping</at>' },
                  {
                    tag: "action",
                    actions: [
                      {
                        tag: "button",
                        text: { tag: "plain_text", content: "Promote" },
                        type: "success",
                        url: "https://example.com/promote",
                      },
                      {
                        tag: "button",
                        text: { tag: "plain_text", content: "Bad link" },
                        url: "file:///etc/passwd",
                      },
                      {
                        tag: "button",
                        text: { tag: "plain_text", content: "Good link" },
                        url: "https://example.com",
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    });

    const card = sendCardCall()?.card;
    expect(card.header.template).toBe("blue");
    expect(card.body.elements).toEqual([
      { tag: "markdown", content: '&lt;at id="ou_1"&gt;ping&lt;/at&gt;' },
      {
        tag: "button",
        text: { tag: "plain_text", content: "Promote" },
        type: "primary",
        behaviors: [{ type: "open_url", default_url: "https://example.com/promote" }],
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "Good link" },
        type: "default",
        behaviors: [{ type: "open_url", default_url: "https://example.com" }],
      },
    ]);
    expect(JSON.stringify(card)).not.toContain("file://");
    expect(JSON.stringify(card)).not.toContain("image-secret");
  });

  it.each(["lark_md", "plain_text"])(
    "keeps top-level legacy %s text items on the text fallback path",
    async (tag) => {
      const text = JSON.stringify({
        elements: [{ tag, content: "Not a valid root legacy card element" }],
      });

      const result = await feishuOutbound.sendPayload?.({
        ...outboundContext,
        text,
        payload: { text },
      });

      expect(sendCardFeishuMock).not.toHaveBeenCalled();
      expect(sendMessageCall()?.text).toBe(text);
      expectFeishuResult(result, "text_msg");
    },
  );

  it("keeps unsupported legacy element shapes on the text fallback path", async () => {
    const text = JSON.stringify({
      elements: [
        {
          tag: "div",
          text: { tag: "unsupported", content: "Not a supported legacy text element" },
        },
      ],
    });

    const result = await feishuOutbound.sendPayload?.({
      ...outboundContext,
      text,
      payload: { text },
    });

    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMessageCall()?.text).toBe(text);
    expectFeishuResult(result, "text_msg");
  });

  it("prefers structured presentation over raw card JSON payload text", async () => {
    const text = JSON.stringify({
      header: { title: { tag: "plain_text", content: "Raw card" } },
      elements: [{ tag: "markdown", content: "Raw body" }],
    });

    const result = await feishuOutbound.sendPayload?.({
      ...outboundContext,
      text,
      payload: {
        text,
        presentation: {
          title: "Structured card",
          blocks: [{ type: "text", text: "Structured body" }],
        },
      },
    });

    const card = sendCardCall()?.card;
    expect(card.header).toEqual({
      title: { tag: "plain_text", content: "Structured card" },
      template: "blue",
    });
    expect(card.body.elements).toEqual([{ tag: "markdown", content: "Structured body" }]);
    expectFeishuResult(result, "native_card_msg");
  });

  it("prefers structured interactive input over raw card JSON payload text", async () => {
    const text = JSON.stringify({
      header: { title: { tag: "plain_text", content: "Raw card" } },
      elements: [{ tag: "markdown", content: "Raw body" }],
    });

    const result = await feishuOutbound.sendPayload?.({
      ...outboundContext,
      text,
      payload: {
        text,
        interactive: {
          blocks: [{ type: "text", text: "Interactive body" }],
        },
      },
    });

    const card = sendCardCall()?.card;
    expect(card.header).toBeUndefined();
    expect(card.body.elements).toEqual([{ tag: "markdown", content: "Interactive body" }]);
    expectFeishuResult(result, "native_card_msg");
  });

  it("keeps invalid plain card JSON on the text fallback path", async () => {
    const text = JSON.stringify({
      schema: "2.0",
      body: {
        elements: [{ tag: "img", img_key: "image-secret" }],
      },
    });

    const result = await feishuOutbound.sendPayload?.({
      ...outboundContext,
      text,
      payload: { text },
    });

    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMessageCall()?.text).toBe(text);
    expectFeishuResult(result, "text_msg");
  });

  it("sends payload media before final native cards", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("approved image"));
    const mediaAccess = {
      localRoots: ["/approved/workspace"],
      workspaceDir: "/approved/workspace",
      readFile: mediaReadFile,
    };
    const mediaUrls = ["image.png", "summary.png"];
    const result = await feishuOutbound.sendPayload?.({
      ...outboundContext,
      text: "See attached",
      mediaAccess,
      mediaLocalRoots: ["/legacy/workspace"],
      mediaReadFile,
      payload: {
        text: "See attached",
        mediaUrls,
        interactive: {
          blocks: [{ type: "buttons", buttons: [{ label: "Open", url: "https://example.com" }] }],
        },
      },
    });

    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(mediaUrls.length);
    for (const [index, mediaUrl] of mediaUrls.entries()) {
      expect(sendMediaCall(index)?.to).toBe("chat_1");
      expect(sendMediaCall(index)?.mediaUrl).toBe(mediaUrl);
      expect(sendMediaCall(index)?.mediaAccess).toBe(mediaAccess);
      expect(sendMediaCall(index)?.mediaLocalRoots).toEqual(["/legacy/workspace"]);
      expect(sendMediaCall(index)?.mediaReadFile).toBe(mediaReadFile);
      expect(sendMediaCall(index)?.accountId).toBe("main");
    }
    expect(sendCardCall()?.to).toBe("chat_1");
    expect(sendCardCall()?.accountId).toBe("main");
    expectFeishuResult(result, "native_card_msg");
  });

  it("threads native-card media and cards when replyToId is whitespace-only", async () => {
    await feishuOutbound.sendPayload?.({
      ...outboundContext,
      text: nativeCardText,
      replyToId: "   ",
      threadId: "om_topic_root",
      payload: { text: nativeCardText, mediaUrl: "https://example.com/image.png" },
    });

    expect(sendMediaCall()?.replyToMessageId).toBe("om_topic_root");
    expect(sendMediaCall()?.replyInThread).toBe(true);
    expect(sendCardCall()?.replyToMessageId).toBe("om_topic_root");
    expect(sendCardCall()?.replyInThread).toBe(true);
  });

  it("prefers replyToId over threadId for native-card media and cards", async () => {
    await feishuOutbound.sendPayload?.({
      ...outboundContext,
      text: nativeCardText,
      replyToId: " om_inline ",
      threadId: "om_topic_root",
      payload: { text: nativeCardText, mediaUrl: "https://example.com/image.png" },
    });

    expect(sendMediaCall()?.replyToMessageId).toBe("om_inline");
    expect(sendMediaCall()?.replyInThread).toBe(false);
    expect(sendCardCall()?.replyToMessageId).toBe("om_inline");
    expect(sendCardCall()?.replyInThread).toBe(false);
  });

  it("treats whitespace-only threadId as no native-card reply target", async () => {
    await feishuOutbound.sendPayload?.({
      ...outboundContext,
      text: nativeCardText,
      replyToId: " ",
      threadId: "   ",
      payload: { text: nativeCardText },
    });

    expect(sendCardCall()?.replyToMessageId).toBeUndefined();
    expect(sendCardCall()?.replyInThread).toBe(false);
  });

  it("consumes an implicit first-reply target on valid-card media", async () => {
    await feishuOutbound.sendPayload?.({
      ...outboundContext,
      text: "",
      replyToId: "om_reply",
      replyToIdSource: "implicit",
      replyToMode: "first",
      payload: {
        mediaUrl: "/tmp/image.png",
        presentation: {
          blocks: [{ type: "table", caption: "Pipeline", headers: ["Account"], rows: [["Acme"]] }],
        },
      },
    });

    expect(sendMediaCall()?.replyToMessageId).toBe("om_reply");
    expect(sendCardCall()?.replyToMessageId).toBeUndefined();
  });

  it("keeps text/media fallback behavior for non-card payloads, including local image text", async () => {
    const { dir, file } = await createTmpImage();
    const mediaReadFile = vi.fn(async () => Buffer.from("approved image"));
    const mediaAccess = { localRoots: [dir], workspaceDir: dir, readFile: mediaReadFile };
    try {
      const result = await feishuOutbound.sendPayload?.({
        ...outboundContext,
        text: file,
        mediaAccess,
        mediaLocalRoots: [dir],
        mediaReadFile,
        payload: { text: file },
      });

      expect(sendCardFeishuMock).not.toHaveBeenCalled();
      expect(sendMediaCall()?.to).toBe("chat_1");
      expect(sendMediaCall()?.mediaUrl).toBe(file);
      expect(sendMediaCall()?.mediaAccess).toBe(mediaAccess);
      expect(sendMediaCall()?.mediaLocalRoots).toEqual([dir]);
      expect(sendMediaCall()?.mediaReadFile).toBe(mediaReadFile);
      expect(sendMediaCall()?.accountId).toBe("main");
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      expectFeishuResult(result, "media_msg");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it.each(["direct", "core-rendered"] as const)(
    "preserves select command guidance for %s document-comment delivery",
    async (deliveryPath) => {
      const presentation: MessagePresentation = {
        blocks: [
          {
            type: "select",
            placeholder: "Choose deployment",
            options: [
              {
                label: "Deploy",
                action: { type: "command", command: "/deploy staging" },
              },
            ],
          },
        ],
      };
      const originalPayload = { presentation };
      let payload: ReplyPayload = originalPayload;
      if (deliveryPath === "core-rendered") {
        const rendered = await feishuOutbound.renderPresentation?.({
          payload: originalPayload,
          presentation,
          ctx: {
            cfg: emptyConfig,
            to: "comment:docx:doxcn123:7623358762119646411",
            text: "",
            accountId: "main",
            payload: originalPayload,
          },
        });
        if (!rendered) {
          throw new Error("expected Feishu-rendered select presentation");
        }
        const { presentation: _presentation, ...coreRenderedPayload } = rendered;
        payload = coreRenderedPayload;
      }

      const result = await feishuOutbound.sendPayload?.({
        cfg: emptyConfig,
        to: "comment:docx:doxcn123:7623358762119646411",
        text: "",
        accountId: "main",
        payload,
      });

      expect(commentThreadParams()?.content).toBe(
        "Choose deployment:\n- Deploy: `/deploy staging`\n\n> Interactive buttons are unavailable in Feishu document comments. You can type the command shown above manually.",
      );
      expectFeishuResult(result, "reply_msg");
    },
  );

  it("keeps TTS supplements on the document-comment delivery path", async () => {
    await feishuOutbound.sendPayload?.({
      cfg: emptyConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: "Readable answer",
      accountId: "main",
      payload: {
        text: "Readable answer",
        mediaUrl: "https://example.com/reply.ogg",
        audioAsVoice: true,
        ttsSupplement: { spokenText: "Readable answer" },
      },
    });

    expect(deliverCommentThreadTextMock).toHaveBeenCalled();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
  });

  it("rejects card-only document comments instead of reporting an empty delivery", async () => {
    const text = JSON.stringify({
      header: { title: { tag: "plain_text", content: "Raw card" } },
      elements: [{ tag: "markdown", content: "Raw body" }],
    });

    await expect(
      feishuOutbound.sendPayload?.({
        cfg: emptyConfig,
        to: "comment:docx:doxcn123:7623358762119646411",
        text,
        accountId: "main",
        payload: { text },
      }),
    ).rejects.toThrow(
      "Feishu native cards cannot be sent to document comments without a text or media fallback.",
    );

    expect(deliverCommentThreadTextMock).not.toHaveBeenCalled();
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "presentation",
      {
        presentation: {
          title: "Structured card",
          blocks: [{ type: "text" as const, text: "Structured body" }],
        },
      },
      "Structured card\n\nStructured body",
    ],
    [
      "interactive",
      {
        interactive: {
          blocks: [{ type: "text" as const, text: "Interactive body" }],
        },
      },
      "Interactive body",
    ],
  ])(
    "prefers structured %s over raw card JSON for document comments",
    async (_kind, structuredPayload, expectedText) => {
      const text = JSON.stringify({
        header: { title: { tag: "plain_text", content: "Raw card" } },
        elements: [{ tag: "markdown", content: "Raw body" }],
      });

      const result = await feishuOutbound.sendPayload?.({
        cfg: emptyConfig,
        to: "comment:docx:doxcn123:7623358762119646411",
        text,
        accountId: "main",
        payload: {
          text,
          ...structuredPayload,
        },
      });

      expect(sendCardFeishuMock).not.toHaveBeenCalled();
      expect(commentThreadParams()?.content).toBe(expectedText);
      expectFeishuResult(result, "reply_msg");
    },
  );

  it("prefers explicit command guidance over deprecated button URLs", async () => {
    const result = await feishuOutbound.sendPayload?.({
      cfg: emptyConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: "Review this",
      accountId: "main",
      payload: {
        text: "Review this",
        interactive: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: "Open URL",
                  url: "https://example.com/action",
                  action: { type: "command", command: "/approve req_1" },
                },
              ],
            },
          ],
        },
      },
    });

    expect(commentThreadParams()?.content).toBe(
      "Review this\n\n- Open URL: `/approve req_1`\n\n> Interactive buttons are unavailable in Feishu document comments. You can type the command shown above manually.",
    );
    expectFeishuResult(result, "reply_msg");
  });

  it.each(["direct", "core-rendered"] as const)(
    "keeps disabled labels literal without command guidance in %s document comments",
    async (deliveryPath) => {
      const presentation = {
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Disabled [Approve](https://example.com) & <at>",
                disabled: true,
                action: { type: "command", command: "/approve req_1" },
              },
            ],
          },
        ],
      } satisfies MessagePresentation;
      const context = {
        cfg: emptyConfig,
        to: "comment:docx:doxcn123:7623358762119646411",
        text: "Review this",
        accountId: "main",
      };
      let payload: ReplyPayload = { text: context.text, interactive: presentation };
      if (deliveryPath === "core-rendered") {
        const originalPayload = { text: context.text, presentation };
        const rendered = await feishuOutbound.renderPresentation?.({
          payload: originalPayload,
          presentation,
          ctx: { ...context, payload: originalPayload },
        });
        if (!rendered) {
          throw new Error("expected Feishu-rendered presentation");
        }
        const { presentation: _presentation, ...coreRenderedPayload } = rendered;
        payload = coreRenderedPayload;
      }
      const result = await feishuOutbound.sendPayload?.({ ...context, payload });

      expect(commentThreadParams()?.content).toBe(
        "Review this\n\n- Disabled [Approve](https://example.com) & <at>",
      );
      expectFeishuResult(result, "reply_msg");
    },
  );

  it("ignores non-boolean fallback command markers", async () => {
    const result = await feishuOutbound.sendPayload?.({
      cfg: emptyConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: "Review this",
      accountId: "main",
      payload: {
        text: "Review this",
        channelData: {
          feishu: {
            card: { body: { elements: [{ tag: "hr" }] } },
            fallbackHasCommand: "true",
          },
        },
      },
    });

    expect(commentThreadParams()?.content).toBe("Review this");
    expectFeishuResult(result, "reply_msg");
  });
});

describe("feishuOutbound comment-thread routing", () => {
  beforeEach(() => {
    resetOutboundMocks();
  });

  it.each([
    ["bullets", convertMarkdownTables(tableMarkdown, "bullets")],
    ["code", convertMarkdownTables(tableMarkdown, "code")],
    [undefined, convertMarkdownTables(tableMarkdown, "code")],
    ["off", tableMarkdown],
  ] as const)(
    "converts a table for a document-comment target in %s mode",
    async (tables, expected) => {
      const cfg: ClawdbotConfig = tables ? { channels: { feishu: { markdown: { tables } } } } : {};

      await sendText({
        cfg,
        to: "comment:docx:doxcn123:7623358762119646411",
        text: tableMarkdown,
        accountId: "main",
      });

      expect(commentThreadParams()?.content).toBe(expected);
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    },
  );

  it.each(feishuSecretRefPolicyCases)(
    "permits document-comment delivery only under configured SecretRef policy: $name",
    async (testCase) => {
      vi.stubEnv(FEISHU_SELECTED_SECRET_ENV, "selected-secret");
      vi.stubEnv(FEISHU_SIBLING_SECRET_ENV, "sibling-secret");
      createFeishuClientMock.mockImplementationOnce((account) => {
        if (!account.appId || !account.appSecret) {
          throw new Error(`Feishu credentials not configured for account "${account.accountId}"`);
        }
        return { request: vi.fn() };
      });
      const cfg = createFeishuSecretRefPolicyConfig(testCase);

      try {
        const delivery = sendText({
          cfg,
          to: "comment:docx:doxcn123:7623358762119646411",
          text: "handled in thread",
          accountId: "selected",
        });

        if (!testCase.configured) {
          await expect(delivery).rejects.toThrow(
            'Feishu credentials not configured for account "selected"',
          );
          expect(deliverCommentThreadTextMock).not.toHaveBeenCalled();
          expect(sendMessageFeishuMock).not.toHaveBeenCalled();
          expect(sendMediaFeishuMock).not.toHaveBeenCalled();
          return;
        }

        expectFeishuResult(await delivery, "reply_msg");
        expect(createFeishuClientMock).toHaveBeenCalledWith(
          expect.objectContaining({
            accountId: "selected",
            appId: "selected-app",
            appSecret: "selected-secret", // pragma: allowlist secret
            configured: true,
          }),
        );
        expect(deliverCommentThreadTextMock).toHaveBeenCalledOnce();
        expect(commentThreadParams()?.content).toBe("handled in thread");
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("routes comment-thread code-block replies through deliverCommentThreadText instead of IM cards", async () => {
    const result = await sendText({
      cfg: emptyConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: "```ts\nconst x = 1\n```",
      accountId: "main",
    });

    expect(commentThreadParams()?.file_token).toBe("doxcn123");
    expect(commentThreadParams()?.file_type).toBe("docx");
    expect(commentThreadParams()?.comment_id).toBe("7623358762119646411");
    expect(commentThreadParams()?.content).toBe("```ts\nconst x = 1\n```");
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    expectFeishuResult(result, "reply_msg");
  });

  it("routes comment-thread replies through deliverCommentThreadText even when renderMode=card", async () => {
    const result = await sendText({
      cfg: cardRenderConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: "handled in thread",
      accountId: "main",
    });

    expect(commentThreadParams()?.file_token).toBe("doxcn123");
    expect(commentThreadParams()?.file_type).toBe("docx");
    expect(commentThreadParams()?.comment_id).toBe("7623358762119646411");
    expect(commentThreadParams()?.content).toBe("handled in thread");
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    expectFeishuResult(result, "reply_msg");
  });

  it("falls back to a text-only comment reply for media payloads", async () => {
    const result = await feishuOutbound.sendMedia?.({
      cfg: emptyConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: "see attachment",
      mediaUrl: "https://example.com/file.png",
      accountId: "main",
    });

    expect(commentThreadParams()?.content).toBe("see attachment\n\nhttps://example.com/file.png");
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expectFeishuResult(result, "reply_msg");
  });

  it.each([
    ["local path", path.join(os.tmpdir(), "openclaw-feishu-comment-local-voice.mp3")],
    ["loopback URL", "http://127.0.0.1:3000/tmp/openclaw-voice.mp3"],
  ])("does not leak a %s in comment-thread media fallbacks", async (_label, mediaUrl) => {
    const result = await feishuOutbound.sendMedia?.({
      cfg: emptyConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: "see attachment",
      mediaUrl,
      accountId: "main",
    });

    expect(commentThreadParams()?.content).toBe(
      "see attachment\n\nMedia upload failed. Please try again.",
    );
    expect(commentThreadParams()?.content).not.toContain(mediaUrl);
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expectFeishuResult(result, "reply_msg");
  });

  it("preserves comment-thread routing when deliverCommentThreadText falls back to add_comment", async () => {
    const onDeliveryResult = vi.fn();
    deliverCommentThreadTextMock.mockResolvedValueOnce({
      delivery_mode: "add_comment",
      comment_id: "comment_msg",
      reply_id: "reply_from_add_comment",
    });

    const result = await sendText({
      cfg: emptyConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: "whole-comment follow-up",
      accountId: "main",
      onDeliveryResult,
    });

    expect(commentThreadParams()?.file_token).toBe("doxcn123");
    expect(commentThreadParams()?.file_type).toBe("docx");
    expect(commentThreadParams()?.comment_id).toBe("7623358762119646411");
    expect(commentThreadParams()?.content).toBe("whole-comment follow-up");
    expectFeishuResult(result, "comment_msg");
    expect(onDeliveryResult.mock.calls[0]?.[0]?.messageId).toBe("comment_msg");
  });

  it("does not wait for ambient comment typing cleanup before sending comment-thread replies", async () => {
    let resolveCleanup: ((value: boolean) => void) | undefined;
    cleanupAmbientCommentTypingReactionMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCleanup = resolve;
        }),
    );

    const sendPromise = sendText({
      cfg: emptyConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: "handled in thread",
      replyToId: "reply_ambient_1",
      accountId: "main",
    });

    const status = await raceWithNextMacrotask(sendPromise.then(() => "done"));

    expect(status).toBe("done");
    expect(deliverCommentThreadTextMock).toHaveBeenCalled();
    const cleanupCall = cleanupReactionCall();
    if (!cleanupCall?.client) {
      throw new Error("Expected cleanup reaction client");
    }
    expect(cleanupCall.deliveryContext).toEqual({
      channel: "feishu",
      to: "comment:docx:doxcn123:7623358762119646411",
      threadId: "reply_ambient_1",
    });

    resolveCleanup?.(false);
    await sendPromise;
  });
});

describe("feishuOutbound.sendMedia replyToId forwarding", () => {
  beforeEach(() => {
    resetOutboundMocks();
  });

  it("sends and records text-only media requests exactly once", async () => {
    const onDeliveryResult = vi.fn();

    const result = await feishuOutbound.sendMedia?.({
      ...outboundContext,
      text: "text without an attachment",
      replyToId: "om_reply_target",
      onDeliveryResult,
    });

    expect(sendMessageFeishuMock).toHaveBeenCalledOnce();
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expect(onDeliveryResult.mock.calls.map(([delivery]) => delivery.messageId)).toEqual([
      "text_msg",
    ]);
    expectFeishuResult(result, "text_msg");
  });

  it("forwards replyToId to sendMediaFeishu", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("approved image"));
    const mediaAccess = {
      localRoots: ["/approved/workspace"],
      workspaceDir: "/approved/workspace",
      readFile: mediaReadFile,
    };
    await feishuOutbound.sendMedia?.({
      ...outboundContext,
      text: "",
      mediaUrl: "image.png",
      mediaAccess,
      mediaLocalRoots: mediaAccess.localRoots,
      mediaReadFile,
      replyToId: "om_reply_target",
    });

    expect(sendMediaCall()?.mediaUrl).toBe("image.png");
    expect(sendMediaCall()?.mediaAccess).toBe(mediaAccess);
    expect(sendMediaCall()?.mediaLocalRoots).toBe(mediaAccess.localRoots);
    expect(sendMediaCall()?.mediaReadFile).toBe(mediaReadFile);
    expect(sendMediaCall()?.replyToMessageId).toBe("om_reply_target");
    expect(sendMediaCall()?.replyInThread).toBe(false);
  });

  it("consumes an implicit first-reply target on the caption before sending its attachment", async () => {
    await feishuOutbound.sendMedia?.({
      ...outboundContext,
      text: "caption text",
      mediaUrl: "https://example.com/image.png",
      replyToId: "om_reply_target",
      replyToIdSource: "implicit",
      replyToMode: "first",
    });

    expect(sendMessageCall()?.replyToMessageId).toBe("om_reply_target");
    expect(sendMediaCall()?.replyToMessageId).toBeUndefined();
  });

  it("does not reuse an implicit first-reply target for the upload-failure fallback", async () => {
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("upload failed"));

    await feishuOutbound.sendMedia?.({
      ...outboundContext,
      text: "caption text",
      mediaUrl: "https://example.com/image.png",
      replyToId: "om_reply_target",
      replyToIdSource: "implicit",
      replyToMode: "first",
    });

    expect(sendMessageFeishuMock.mock.calls[0]?.[0]?.replyToMessageId).toBe("om_reply_target");
    expect(sendMessageFeishuMock.mock.calls[1]?.[0]?.replyToMessageId).toBeUndefined();
  });

  it("preserves an unconsumed implicit reply target when the first media upload fails", async () => {
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("upload failed"));

    await feishuOutbound.sendMedia?.({
      ...outboundContext,
      text: "spoken reply",
      mediaUrl: "https://example.com/reply.mp3",
      audioAsVoice: true,
      replyToId: "om_reply_target",
      replyToIdSource: "implicit",
      replyToMode: "first",
    });

    expect(sendMediaCall()?.replyToMessageId).toBe("om_reply_target");
    expect(sendMessageCall()?.replyToMessageId).toBe("om_reply_target");
  });

  it("consumes an implicit first-reply target on degraded voice media before its text", async () => {
    sendMediaFeishuMock.mockResolvedValueOnce({
      messageId: "file_msg",
      voiceIntentDegradedToFile: true,
    });

    await feishuOutbound.sendMedia?.({
      ...outboundContext,
      text: "spoken reply",
      mediaUrl: "https://example.com/reply.mp3",
      audioAsVoice: true,
      replyToId: "om_reply_target",
      replyToIdSource: "implicit",
      replyToMode: "first",
    });

    expect(sendMediaCall()?.replyToMessageId).toBe("om_reply_target");
    expect(sendMessageCall()?.replyToMessageId).toBeUndefined();
  });

  it("keeps explicit first-mode targets sticky across every caption chunk and attachment", async () => {
    await feishuOutbound.sendMedia?.({
      ...outboundContext,
      text: Array.from({ length: 2_200 }, () => "a").join("\n"),
      mediaUrl: "https://example.com/image.png",
      replyToId: "om_explicit_reply",
      replyToIdSource: "explicit",
      replyToMode: "first",
    });

    expect(sendMessageFeishuMock.mock.calls.length).toBeGreaterThan(1);
    for (const [params] of sendMessageFeishuMock.mock.calls) {
      expect(params.replyToMessageId).toBe("om_explicit_reply");
    }
    expect(sendMediaCall()?.replyToMessageId).toBe("om_explicit_reply");
  });

  it("keeps native topic roots sticky across captions, attachments, and fallback", async () => {
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("upload failed"));

    await feishuOutbound.sendMedia?.({
      ...outboundContext,
      text: "caption text",
      mediaUrl: "https://example.com/image.png",
      threadId: "om_topic_root",
      replyToMode: "first",
    });

    expect(sendMediaCall()?.replyToMessageId).toBe("om_topic_root");
    expect(sendMediaCall()?.replyInThread).toBe(true);
    for (const [params] of sendMessageFeishuMock.mock.calls) {
      expect(params.replyToMessageId).toBe("om_topic_root");
      expect(params.replyInThread).toBe(true);
    }
  });

  it("prefers replyToId over threadId (inline reply) when both are set", async () => {
    await feishuOutbound.sendMedia?.({
      ...outboundContext,
      text: "",
      mediaUrl: "https://example.com/image.png",
      replyToId: "om_inline",
      threadId: "om_topic_root",
    });

    expect(sendMediaCall()?.replyToMessageId).toBe("om_inline");
    expect(sendMediaCall()?.replyInThread).toBe(false);
  });

  it("treats whitespace-only replyToId as absent for replyInThread (falls back to threadId)", async () => {
    await feishuOutbound.sendMedia?.({
      ...outboundContext,
      text: "",
      mediaUrl: "https://example.com/image.png",
      replyToId: "   ",
      threadId: "om_topic_root",
    });

    expect(sendMediaCall()?.replyToMessageId).toBe("om_topic_root");
    expect(sendMediaCall()?.replyInThread).toBe(true);
  });

  it("suppresses duplicate text when sending voice media", async () => {
    await feishuOutbound.sendMedia?.({
      ...outboundContext,
      text: "spoken reply",
      mediaUrl: "https://example.com/reply.mp3",
      audioAsVoice: true,
    });

    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaCall()?.mediaUrl).toBe("https://example.com/reply.mp3");
    expect(sendMediaCall()?.audioAsVoice).toBe(true);
  });

  it("sends skipped voice text when voice media degrades to a file attachment", async () => {
    sendMediaFeishuMock.mockResolvedValueOnce({
      messageId: "file_msg",
      voiceIntentDegradedToFile: true,
    });

    await feishuOutbound.sendMedia?.({
      ...outboundContext,
      text: "spoken reply",
      mediaUrl: "https://example.com/reply.mp3",
      audioAsVoice: true,
    });

    expect(sendMediaCall()?.mediaUrl).toBe("https://example.com/reply.mp3");
    expect(sendMediaCall()?.audioAsVoice).toBe(true);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageCall()?.text).toBe("spoken reply");
  });

  it("suppresses duplicate text for native voice media without audioAsVoice", async () => {
    await feishuOutbound.sendMedia?.({
      ...outboundContext,
      text: "spoken reply",
      mediaUrl: "https://example.com/reply.ogg?download=1",
    });

    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaCall()?.mediaUrl).toBe("https://example.com/reply.ogg?download=1");
  });

  it("keeps captions for regular audio file attachments", async () => {
    await feishuOutbound.sendMedia?.({
      ...outboundContext,
      text: "caption text",
      mediaUrl: "https://example.com/song.mp3",
    });

    expect(sendMessageCall()?.text).toBe("caption text");
    expect(sendMediaCall()?.mediaUrl).toBe("https://example.com/song.mp3");
  });

  it("reports a sent caption before media failure and avoids repeating it in fallback", async () => {
    sendMessageFeishuMock
      .mockResolvedValueOnce({ messageId: "caption_msg" })
      .mockResolvedValueOnce({ messageId: "fallback_msg" });
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("upload failed"));
    const onDeliveryResult = vi.fn();

    const result = await feishuOutbound.sendMedia?.({
      ...outboundContext,
      text: "caption text",
      mediaUrl: "https://example.com/image.png",
      onDeliveryResult,
    });

    expect(sendMessageCall(0)?.text).toBe("caption text");
    expect(sendMessageCall(1)?.text).toBe("📎 https://example.com/image.png");
    expect(onDeliveryResult.mock.calls.map((call) => call[0]?.messageId)).toEqual([
      "caption_msg",
      "fallback_msg",
    ]);
    expectFeishuResult(result, "fallback_msg");
  });

  it("records every accepted caption chunk before recording its attachment", async () => {
    sendMessageFeishuMock.mockImplementation(async () => ({
      messageId: `caption_${sendMessageFeishuMock.mock.calls.length}`,
    }));
    const onDeliveryResult = vi.fn();

    const result = await feishuOutbound.sendMedia?.({
      ...outboundContext,
      text: Array.from({ length: 2_200 }, () => "a").join("\n"),
      mediaUrl: "https://example.com/image.png",
      onDeliveryResult,
    });

    expect(sendMessageFeishuMock.mock.calls.length).toBeGreaterThan(1);
    expect(onDeliveryResult.mock.calls.map(([delivery]) => delivery.messageId)).toEqual([
      ...sendMessageFeishuMock.mock.calls.map((_call, index) => `caption_${index + 1}`),
      "media_msg",
    ]);
    expect(result?.receipt?.parts.map((part) => part.platformMessageId)).toEqual(
      onDeliveryResult.mock.calls.map(([delivery]) => delivery.messageId),
    );
    expect(result?.messageId).toBe("media_msg");
    expect(result?.receipt?.primaryPlatformMessageId).toBe("media_msg");
  });

  it("preserves accepted caption chunks when a later chunk fails before media", async () => {
    sendMessageFeishuMock
      .mockResolvedValueOnce({ messageId: "accepted_caption" })
      .mockRejectedValueOnce(new Error("second caption failed"));
    const onDeliveryResult = vi.fn();

    await expect(
      feishuOutbound.sendMedia?.({
        ...outboundContext,
        text: Array.from({ length: 2_200 }, () => "a").join("\n"),
        mediaUrl: "https://example.com/image.png",
        onDeliveryResult,
      }),
    ).rejects.toThrow("second caption failed");

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expect(onDeliveryResult.mock.calls.map(([result]) => result.messageId)).toEqual([
      "accepted_caption",
    ]);
  });

  it("stops before later caption chunks and media when delivery persistence fails", async () => {
    const onDeliveryResult = vi.fn().mockRejectedValueOnce(new Error("progress write failed"));

    await expect(
      feishuOutbound.sendMedia?.({
        ...outboundContext,
        text: Array.from({ length: 2_200 }, () => "a").join("\n"),
        mediaUrl: "https://example.com/image.png",
        onDeliveryResult,
      }),
    ).rejects.toThrow("progress write failed");

    expect(sendMessageFeishuMock).toHaveBeenCalledOnce();
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expect(onDeliveryResult).toHaveBeenCalledOnce();
  });

  it("does not send fallback text after an accepted media send loses its receipt", async () => {
    const acceptedError = createChannelPartialDeliveryError(
      new Error("Feishu image send failed: no message_id returned"),
      { messageIds: [], visibleReplySent: true },
    );
    sendMediaFeishuMock.mockRejectedValueOnce(acceptedError);

    await expect(
      feishuOutbound.sendMedia?.({
        ...outboundContext,
        text: "",
        mediaUrl: "https://example.com/image.png",
      }),
    ).rejects.toBe(acceptedError);

    expect(sendMediaFeishuMock).toHaveBeenCalledOnce();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("does not resend successful media when delivery progress persistence fails", async () => {
    sendMessageFeishuMock.mockResolvedValueOnce({ messageId: "caption_msg" });
    sendMediaFeishuMock.mockResolvedValueOnce({ messageId: "media_msg" });
    const onDeliveryResult = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("progress write failed"));

    await expect(
      feishuOutbound.sendMedia?.({
        ...outboundContext,
        text: "caption text",
        mediaUrl: "https://example.com/image.png",
        onDeliveryResult,
      }),
    ).rejects.toThrow("progress write failed");

    expect(sendMediaFeishuMock).toHaveBeenCalledOnce();
    expect(sendMessageFeishuMock).toHaveBeenCalledOnce();
    expect(onDeliveryResult.mock.calls.map((call) => call[0]?.messageId)).toEqual([
      "caption_msg",
      "media_msg",
    ]);
  });

  it("keeps skipped voice text in the upload failure fallback", async () => {
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("upload failed"));

    await feishuOutbound.sendMedia?.({
      ...outboundContext,
      text: "spoken reply",
      mediaUrl: "https://example.com/reply.mp3",
      audioAsVoice: true,
    });

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageCall()?.text).toBe("spoken reply\n\n📎 https://example.com/reply.mp3");
  });

  it.each([
    ["local path", path.join(os.tmpdir(), "openclaw-feishu-local-voice.mp3")],
    ["file URL", "file:///tmp/openclaw-feishu-local-voice.mp3"],
    ["relative path", "./outbound/openclaw-feishu-local-voice.mp3"],
    ["loopback URL", "http://127.0.0.1:3000/tmp/openclaw-voice.mp3"],
    ["localhost URL", "https://localhost/tmp/openclaw-voice.mp3"],
    ["private-DNS URL", "https://files.example.test/openclaw-voice.mp3"],
    ["credentialed URL", "https://user@example.com/openclaw-voice.mp3"],
    ["control-character URL", "https://example.com/\nhttp://127.0.0.1/private"],
  ])("does not leak a %s in the upload failure fallback", async (_label, mediaUrl) => {
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("upload failed"));

    await feishuOutbound.sendMedia?.({
      ...outboundContext,
      text: "spoken reply",
      mediaUrl,
      audioAsVoice: true,
    });

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageCall()?.text).toBe("spoken reply\n\nMedia upload failed. Please try again.");
    expect(sendMessageCall()?.text).not.toContain(mediaUrl);
  });

  // Regression for #112244 (seventeenth-review P1): when the caption was already
  // delivered before the media upload failed, the propagated error must preserve
  // the caption's receipt as the repository's existing partial-delivery outcome
  // — otherwise the caller treats it as a wholly failed send, retries, and
  // duplicates the already-visible caption. Pre-fix the catch block threw a plain
  // Error with no receipt; post-fix it throws a ChannelPartialDeliveryError
  // carrying the caption's messageId.
  it.each(["see attachment", "x".repeat(8_500), `\`\`\`text\n${"x".repeat(8_500)}\n\`\`\``])(
    "preserves all delivered caption chunks when media upload fails (%#)",
    async (text) => {
      const sender = text.startsWith("```") ? sendStructuredCardFeishuMock : sendMessageFeishuMock;
      sender.mockImplementation(async () => ({
        messageId: `caption_${sender.mock.calls.length}`,
        chatId: "chat_1",
      }));
      sendMediaFeishuMock.mockRejectedValueOnce(new Error("upload failed"));

      let caught: unknown;
      try {
        await feishuOutbound.sendMedia?.({
          ...outboundContext,
          text,
          mediaUrl: "https://example.com/file.png",
          propagateMediaUploadFailure: true,
        } as never);
      } catch (err) {
        caught = err;
      }

      expect(isChannelPartialDeliveryError(caught)).toBe(true);
      const partial = caught as ReturnType<typeof createChannelPartialDeliveryError>;
      expect(partial.deliveryResult.visibleReplySent).toBe(true);
      const ids = sender.mock.calls.map((_call, index) => `caption_${index + 1}`);
      expect(ids.length).toBe(text.length > 4_000 ? 3 : 1);
      expect(new Set(partial.deliveryResult.messageIds)).toEqual(new Set(ids));
      expect(partial.deliveryResult.receipt?.parts.map((part) => part.platformMessageId)).toEqual(
        ids,
      );
      expect(sendMediaFeishuMock).toHaveBeenCalledOnce();
    },
  );

  // Regression for #112244 (seventeenth-review P1, scope guard): a media-upload
  // failure with NO delivered caption is a wholly failed send, so the propagated
  // error stays a plain Error (no partial-delivery receipt to preserve).
  it("propagates a plain error when media upload fails with no delivered caption", async () => {
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("upload failed"));

    let caught: unknown;
    try {
      await feishuOutbound.sendMedia?.({
        ...outboundContext,
        mediaUrl: "https://example.com/file.png",
        propagateMediaUploadFailure: true,
      } as never);
    } catch (err) {
      caught = err;
    }

    expect(isChannelPartialDeliveryError(caught)).toBe(false);
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toContain(
      "Feishu send could not deliver the requested media attachment",
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  // Regression for #112244 (third-review P1): the direct `send` action routes
  // an attachment through the presentation-fallback path (sendPayload →
  // sendFeishuFallbackPayload → sendMedia) when a card falls back. That path
  // cannot carry `propagateMediaUploadFailure` through the shared sendPayload
  // signature, so the action stamps the marker on channelData.feishu and the
  // fallback payload must honor it — re-throwing the upload failure instead of
  // returning a fallback-text `ok:true` receipt.
  it("propagates a media-upload failure through the presentation-fallback path when the marker is set", async () => {
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("upload failed"));

    await expect(
      feishuOutbound.sendPayload?.({
        ...outboundContext,
        text: "see attachment",
        payload: {
          text: "see attachment",
          mediaUrl: "https://example.com/file.png",
          channelData: {
            feishu: { [FEISHU_PROPAGATE_MEDIA_UPLOAD_FAILURE_MARKER]: true },
          },
        },
      }),
    ).rejects.toThrow("Feishu send could not deliver the requested media attachment");

    expect(sendMediaFeishuMock).toHaveBeenCalledOnce();
    // No fallback "Media upload failed" text is emitted on top of any caption.
    expect(
      sendMessageFeishuMock.mock.calls
        .map(([args]) => (args as { text?: string })?.text ?? "")
        .some((text) => text.includes("Media upload failed")),
    ).toBe(false);
  });

  // The fanout that separates an attachment from its text used to cut the text into
  // 4,000-character fragments and send each one on its own. That cut lands on the
  // authored table, before the target converts it, so only the first fragment kept the
  // header and the rest arrived as raw pipes. The whole text goes in one call now and the
  // target chunks it after converting.
  it("keeps a long fallback table converted when an attachment splits the send", async () => {
    const table = [
      "| Name | Role |",
      "| --- | --- |",
      ...Array.from(
        { length: 260 },
        (_e, i) => `| person-number-${i} | Regional Operations Lead |`,
      ),
    ].join("\n");
    // Guard the fixture: the authored table is longer than one fanout fragment.
    expect(table.length).toBeGreaterThan(4000);

    await feishuOutbound.sendPayload?.({
      cfg: {
        channels: { feishu: { accounts: { main: { markdown: { tables: "block" } } } } },
      },
      to: "comment:docx:doxcn123:7623358762119646411",
      text: table,
      accountId: "main",
      payload: { text: table, mediaUrl: "https://example.com/file.png" },
    });

    const contents = deliverCommentThreadTextMock.mock.calls.map((_call, index) =>
      String(commentThreadParams(index)?.content ?? ""),
    );
    // The attachment is its own comment; the rest carry the answer.
    const tableContents = contents.filter((content) => content.includes("person-number-"));
    expect(tableContents.length).toBeGreaterThan(1);
    // Every comment carrying rows also carries the fence, so no continuation arrives as
    // raw pipes the way the pre-conversion cut left them.
    for (const content of tableContents) {
      expect(content).toContain("```");
    }
    const joined = contents.join("");
    expect(joined).toContain("Name");
    expect(joined).toContain("person-number-259");
  });

  it("still falls back to text on the presentation-fallback path when the marker is absent", async () => {
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("upload failed"));

    const result = await feishuOutbound.sendPayload?.({
      ...outboundContext,
      text: "see attachment",
      payload: {
        text: "see attachment",
        // A private/local media URL cannot be resolved to a public reference,
        // so the fallback renders the generic "Media upload failed" text.
        mediaUrl: path.join(os.tmpdir(), "openclaw-feishu-fallback-no-marker.png"),
      },
    });

    // Default behavior is unchanged: the caption is sent first, then the
    // fallback text, and a success receipt is returned.
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(2);
    expect(sendMessageCall(1)?.text).toContain("Media upload failed. Please try again.");
    expectFeishuResult(result, "text_msg");
  });

  it.each([
    [
      "renders the visible media-link fallback on a document-comment target even when the propagation marker is set",
      true,
    ],
    ["still degrades a comment attachment to text when the propagation marker is absent", false],
  ] as const)("%s", async (_name, propagate) => {
    const result = await feishuOutbound.sendPayload?.({
      cfg: emptyConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: "see attachment",
      accountId: "main",
      payload: {
        text: "see attachment",
        mediaUrl: "https://example.com/pipeline.png",
        ...(propagate
          ? {
              channelData: {
                feishu: { [FEISHU_PROPAGATE_MEDIA_UPLOAD_FAILURE_MARKER]: true },
              },
            }
          : {}),
      },
    });

    expect(commentThreadParams()?.content).toBe("https://example.com/pipeline.png");
    expectFeishuResult(result, "reply_msg");
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
  });
});

describe("feishuOutbound.sendMedia renderMode", () => {
  beforeEach(() => {
    resetOutboundMocks();
  });

  it("uses markdown cards for captions when renderMode=card", async () => {
    const result = await feishuOutbound.sendMedia?.({
      cfg: cardRenderConfig,
      to: "chat_1",
      text: "| a | b |\n| - | - |",
      mediaUrl: "https://example.com/image.png",
      accountId: "main",
    });

    expect(sendStructuredCardCall()?.to).toBe("chat_1");
    expect(sendStructuredCardCall()?.text).toBe("| a | b |\n| - | - |");
    expect(sendStructuredCardCall()?.accountId).toBe("main");
    expect(sendMediaCall()?.to).toBe("chat_1");
    expect(sendMediaCall()?.mediaUrl).toBe("https://example.com/image.png");
    expect(sendMediaCall()?.accountId).toBe("main");
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expectFeishuResult(result, "media_msg");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
