import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Whatsapp tests cover channel react action plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleWhatsAppMessageAction } from "./channel-react-action.js";

const hoisted = vi.hoisted(() => ({
  handleWhatsAppAction: vi.fn(async () => ({ content: [{ type: "text", text: '{"ok":true}' }] })),
  resolveAuthorizedWhatsAppOutboundTarget: vi.fn(
    ({
      chatJid,
      accountId,
    }: {
      chatJid: string;
      accountId?: string;
    }): { to: string; accountId: string } => ({
      to: chatJid,
      accountId: accountId ?? "default",
    }),
  ),
  resolveWhatsAppAccount: vi.fn(() => ({ accountId: "default", mediaMaxMb: 50 })),
  resolveWhatsAppMediaMaxBytes: vi.fn(() => 50 * 1024 * 1024),
  sendMessageWhatsApp: vi.fn(async () => ({
    messageId: "msg-media-1",
    toJid: "1555@s.whatsapp.net",
  })),
}));

vi.mock("./channel-react-action.runtime.js", async () => {
  return {
    handleWhatsAppAction: hoisted.handleWhatsAppAction,
    resolveAuthorizedWhatsAppOutboundTarget: hoisted.resolveAuthorizedWhatsAppOutboundTarget,
    resolveWhatsAppAccount: hoisted.resolveWhatsAppAccount,
    resolveWhatsAppMediaMaxBytes: hoisted.resolveWhatsAppMediaMaxBytes,
    sendMessageWhatsApp: hoisted.sendMessageWhatsApp,
    resolveReactionMessageId: ({
      args,
      toolContext,
    }: {
      args: Record<string, unknown>;
      toolContext?: { currentMessageId?: string | number | null };
    }) => args.messageId ?? toolContext?.currentMessageId ?? null,
    readStringOrNumberParam: (params: Record<string, unknown>, key: string) => {
      const value = params[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === "string" && value.trim()) {
        return value;
      }
      return undefined;
    },
    isWhatsAppGroupJid: (value?: string | null) => (value ?? "").trim().endsWith("@g.us"),
    normalizeWhatsAppTarget: (value?: string | null) => {
      const raw = (value ?? "").trim();
      if (!raw) {
        return null;
      }
      const stripped = raw.replace(/^whatsapp:/, "");
      if (stripped.endsWith("@g.us")) {
        return stripped;
      }
      return stripped.startsWith("+") ? stripped : `+${stripped.replace(/^\+/, "")}`;
    },
    readStringParam: (
      params: Record<string, unknown>,
      key: string,
      options?: { required?: boolean; allowEmpty?: boolean; trim?: boolean },
    ) => {
      const value = params[key];
      if (value == null) {
        if (options?.required) {
          const err = new Error(`${key} required`);
          err.name = "ToolInputError";
          throw err;
        }
        return undefined;
      }
      const text = typeof value === "string" ? value : "";
      if (!options?.allowEmpty && !text.trim()) {
        if (options?.required) {
          const err = new Error(`${key} required`);
          err.name = "ToolInputError";
          throw err;
        }
        return undefined;
      }
      return text;
    },
  };
});

describe("whatsapp react action messageId resolution", () => {
  const baseCfg = {
    channels: { whatsapp: { actions: { reactions: true }, allowFrom: ["*"] } },
  } as OpenClawConfig;

  function expectReactionForwarded(params: {
    chatJid?: string;
    messageId?: string;
    emoji?: string;
    participant?: string;
  }) {
    expect(hoisted.handleWhatsAppAction).toHaveBeenCalledWith(
      {
        action: "react",
        chatJid: "+1555",
        messageId: "ctx-msg-42",
        emoji: "👍",
        remove: undefined,
        participant: undefined,
        accountId: "default",
        fromMe: undefined,
        ...params,
      },
      baseCfg,
    );
  }

  beforeEach(() => {
    hoisted.handleWhatsAppAction.mockClear();
    hoisted.resolveAuthorizedWhatsAppOutboundTarget.mockClear();
    hoisted.resolveWhatsAppAccount.mockClear();
    hoisted.resolveWhatsAppMediaMaxBytes.mockClear();
    hoisted.resolveWhatsAppAccount.mockReturnValue({ accountId: "default", mediaMaxMb: 50 });
    hoisted.resolveWhatsAppMediaMaxBytes.mockReturnValue(50 * 1024 * 1024);
    hoisted.sendMessageWhatsApp.mockClear();
  });

  it.each([
    {
      name: "a URL's mimeType alias",
      source: { mediaUrl: "https://example.com/video" },
      metadata: { mimeType: "video/mp4" },
      expectedContentType: "video/mp4",
    },
  ])("preserves $name for upload-file", async ({ source, metadata, expectedContentType }) => {
    await handleWhatsAppMessageAction({
      action: "upload-file",
      params: { to: "+1555", ...source, ...metadata },
      cfg: baseCfg,
      accountId: "default",
    });

    expect(hoisted.sendMessageWhatsApp).toHaveBeenCalledWith(
      "+1555",
      "",
      expect.objectContaining({
        mediaUrl: source.mediaUrl,
        contentType: expectedContentType,
      }),
    );
  });

  it("does not send upload-file when target authorization fails", async () => {
    hoisted.resolveAuthorizedWhatsAppOutboundTarget.mockImplementationOnce(() => {
      throw new Error("WhatsApp upload-file blocked");
    });

    await expect(
      handleWhatsAppMessageAction({
        action: "upload-file",
        params: {
          to: "+1555",
          filePath: "/tmp/pic.png",
        },
        cfg: baseCfg,
        accountId: "default",
      }),
    ).rejects.toThrow("WhatsApp upload-file blocked");
    expect(hoisted.sendMessageWhatsApp).not.toHaveBeenCalled();
  });

  it("sends upload-file from a whitespace-heavy base64 data URL", async () => {
    await handleWhatsAppMessageAction({
      action: "upload-file",
      params: {
        to: "+1555",
        buffer: " \n DATA:text/plain;BASE64, aG Vs\nbG8= \n ",
        contentType: "text/plain",
        filename: "hello.txt",
        filePath: "/tmp/hello.txt",
        forceDocument: true,
        message: "file caption",
      },
      cfg: baseCfg,
      accountId: "default",
    });

    expect(hoisted.sendMessageWhatsApp).toHaveBeenCalledWith("+1555", "file caption", {
      verbose: false,
      cfg: baseCfg,
      mediaPayload: {
        buffer: Buffer.from("hello"),
        contentType: "text/plain",
        fileName: "hello.txt",
      },
      mediaAccess: undefined,
      mediaLocalRoots: undefined,
      mediaReadFile: undefined,
      gifPlayback: undefined,
      audioAsVoice: undefined,
      forceDocument: true,
      accountId: "default",
    });
  });

  it.each([
    {
      name: "the data URL",
      metadata: {},
      expectedContentType: "image/png",
    },
  ])(
    "resolves upload-file buffer MIME metadata from $name",
    async ({ metadata, expectedContentType }) => {
      await handleWhatsAppMessageAction({
        action: "upload-file",
        params: {
          to: "+1555",
          buffer: `data:image/png;base64,${Buffer.from("image").toString("base64")}`,
          ...metadata,
        },
        cfg: baseCfg,
        accountId: "default",
      });

      expect(hoisted.sendMessageWhatsApp).toHaveBeenCalledWith(
        "+1555",
        "",
        expect.objectContaining({
          mediaPayload: expect.objectContaining({
            buffer: Buffer.from("image"),
            contentType: expectedContentType,
          }),
        }),
      );
    },
  );

  it("prefers the filename field over its fileName alias for URL uploads", async () => {
    await handleWhatsAppMessageAction({
      action: "upload-file",
      params: {
        to: "+1555",
        mediaUrl: "https://example.com/download",
        filename: "preferred.pdf",
        fileName: "ignored.pdf",
      },
      cfg: baseCfg,
      accountId: "default",
    });

    expect(hoisted.sendMessageWhatsApp).toHaveBeenCalledWith(
      "+1555",
      "",
      expect.objectContaining({ fileName: "preferred.pdf" }),
    );
  });

  it.each(["SGVsbG8=!"])("rejects malformed upload-file buffer %s", async (buffer) => {
    await expect(
      handleWhatsAppMessageAction({
        action: "upload-file",
        params: { to: "+1555", buffer },
        cfg: baseCfg,
        accountId: "default",
      }),
    ).rejects.toThrow("must be valid base64 or a base64 data URL");
    expect(hoisted.sendMessageWhatsApp).not.toHaveBeenCalled();
  });

  it("rejects upload-file buffers above the WhatsApp media limit", async () => {
    hoisted.resolveWhatsAppMediaMaxBytes.mockReturnValueOnce(4);
    const encoded = Buffer.from("hello").toString("base64");
    const bufferFromSpy = vi.spyOn(Buffer, "from");

    try {
      await expect(
        handleWhatsAppMessageAction({
          action: "upload-file",
          params: {
            to: "+1555",
            buffer: encoded,
            contentType: "text/plain",
            filename: "hello.txt",
          },
          cfg: baseCfg,
          accountId: "default",
        }),
      ).rejects.toThrow("WhatsApp upload-file buffer exceeds configured media limit");
      const bufferFromCalls = bufferFromSpy.mock.calls as unknown[][];
      expect(bufferFromCalls.some((call) => call[1] === "base64")).toBe(false);
      expect(hoisted.sendMessageWhatsApp).not.toHaveBeenCalled();
    } finally {
      bufferFromSpy.mockRestore();
    }
  });

  it("requires upload-file media path input", async () => {
    await expect(
      handleWhatsAppMessageAction({
        action: "upload-file",
        params: {
          to: "+1555",
          caption: "missing media",
        },
        cfg: baseCfg,
        accountId: "default",
      }),
    ).rejects.toThrow("WhatsApp upload-file requires media");
    expect(hoisted.sendMessageWhatsApp).not.toHaveBeenCalled();
  });

  it("falls back to toolContext current chat for same-chat reactions", async () => {
    await handleWhatsAppMessageAction({
      action: "react",
      params: { emoji: "❤️" },
      cfg: baseCfg,
      accountId: "default",
      toolContext: {
        currentChannelId: "whatsapp:+1555",
        currentChannelProvider: "whatsapp",
        currentMessageId: "ctx-msg-42",
      },
    });
    expectReactionForwarded({
      emoji: "❤️",
    });
  });

  it("uses context fallback when target matches current chat", async () => {
    await handleWhatsAppMessageAction({
      action: "react",
      params: { emoji: "👍", to: "12345@g.us" },
      cfg: baseCfg,
      accountId: "default",
      requesterSenderId: "123@lid",
      toolContext: {
        currentChannelId: "whatsapp:12345@g.us",
        currentChannelProvider: "whatsapp",
        currentMessageId: "ctx-msg-42",
      },
    });
    expectReactionForwarded({
      chatJid: "12345@g.us",
      participant: "123@lid",
    });
  });

  it("does not reuse the current-chat participant for cross-chat reactions", async () => {
    const err = await handleWhatsAppMessageAction({
      action: "react",
      params: { emoji: "👍", to: "99999@g.us" },
      cfg: baseCfg,
      accountId: "default",
      requesterSenderId: "123@lid",
      toolContext: {
        currentChannelId: "whatsapp:12345@g.us",
        currentChannelProvider: "whatsapp",
        currentMessageId: "ctx-msg-42",
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("ToolInputError");
    expect(hoisted.handleWhatsAppAction).not.toHaveBeenCalled();
  });

  it("skips context fallback when currentChannelId is missing with explicit target", async () => {
    const err = await handleWhatsAppMessageAction({
      action: "react",
      params: { emoji: "👍", to: "+1555" },
      cfg: baseCfg,
      accountId: "default",
      toolContext: {
        currentChannelProvider: "whatsapp",
        currentMessageId: "ctx-msg-42",
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("ToolInputError");
  });
});
