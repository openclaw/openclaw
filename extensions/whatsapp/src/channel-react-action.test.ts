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

function whatsAppToolContext(currentChannelId: string, currentMessageId: string | number) {
  return {
    currentChannelId,
    currentChannelProvider: "whatsapp",
    currentMessageId,
  };
}

describe("whatsapp react action messageId resolution", () => {
  const baseCfg = {
    channels: { whatsapp: { actions: { reactions: true }, allowFrom: ["*"] } },
  } as OpenClawConfig;

  type ActionOptions = Omit<
    Parameters<typeof handleWhatsAppMessageAction>[0],
    "action" | "params" | "cfg" | "accountId"
  >;
  const action = (name: string, params: Record<string, unknown>, options: ActionOptions = {}) =>
    handleWhatsAppMessageAction({
      action: name,
      params,
      cfg: baseCfg,
      accountId: "default",
      ...options,
    });
  const upload = (params: Record<string, unknown>, options?: ActionOptions) =>
    action("upload-file", params, options);
  const react = (params: Record<string, unknown>, options?: ActionOptions) =>
    action("react", params, options);

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

  it("sends upload-file through the WhatsApp media send path", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("media"));

    const result = await upload(
      {
        to: "+1555",
        filePath: "/tmp/pic.png",
        caption: "picture caption",
        forceDocument: "true",
        gifPlayback: true,
        asVoice: "true",
      },
      { mediaLocalRoots: ["/tmp"], mediaReadFile },
    );

    expect(hoisted.resolveAuthorizedWhatsAppOutboundTarget).toHaveBeenCalledWith({
      cfg: baseCfg,
      chatJid: "+1555",
      accountId: "default",
      actionLabel: "upload-file",
    });
    expect(hoisted.sendMessageWhatsApp).toHaveBeenCalledWith("+1555", "picture caption", {
      verbose: false,
      cfg: baseCfg,
      mediaUrl: "/tmp/pic.png",
      mediaAccess: undefined,
      mediaLocalRoots: ["/tmp"],
      mediaReadFile,
      gifPlayback: true,
      audioAsVoice: true,
      forceDocument: true,
      accountId: "default",
    });
    expect(result.details).toMatchObject({
      ok: true,
      channel: "whatsapp",
      action: "upload-file",
      messageId: "msg-media-1",
      toJid: "1555@s.whatsapp.net",
    });
  });

  it.each([
    ["filename", "filePath", "/tmp/generated-attachment.bin", "Quarterly Report.pdf"],
    ["fileName", "mediaUrl", "https://example.com/download?id=42", "Invoice.pdf"],
  ] as const)(
    "preserves the requested %s for an upload-file %s",
    async (filenameKey, sourceKey, source, filename) => {
      await upload({
        to: "+1555",
        [sourceKey]: source,
        [filenameKey]: filename,
        forceDocument: true,
      });

      expect(hoisted.sendMessageWhatsApp).toHaveBeenCalledWith(
        "+1555",
        "",
        expect.objectContaining({ mediaUrl: source, fileName: filename }),
      );
    },
  );

  it.each([
    [
      "a local path's contentType",
      { filePath: "/tmp/generated-attachment.bin" },
      { contentType: "image/png" },
      "image/png",
    ],
    [
      "a URL's mimeType alias",
      { mediaUrl: "https://example.com/video" },
      { mimeType: "video/mp4" },
      "video/mp4",
    ],
    [
      "contentType before a URL's mimeType alias",
      { mediaUrl: "https://example.com/document" },
      { contentType: "application/pdf", mimeType: "image/png" },
      "application/pdf",
    ],
  ] as const)(
    "preserves %s for upload-file",
    async (_name, source, metadata, expectedContentType) => {
      await upload({ to: "+1555", ...source, ...metadata });

      expect(hoisted.sendMessageWhatsApp).toHaveBeenCalledWith(
        "+1555",
        "",
        expect.objectContaining({
          mediaUrl: "filePath" in source ? source.filePath : source.mediaUrl,
          contentType: expectedContentType,
        }),
      );
    },
  );

  it("uses toolContext current chat for same-chat upload-file", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("media"));

    await upload(
      {
        filePath: "/tmp/pic.png",
        caption: "picture caption",
      },
      {
        mediaLocalRoots: ["/tmp"],
        mediaReadFile,
        toolContext: whatsAppToolContext("whatsapp:+1555", "ctx-msg-42"),
      },
    );

    expect(hoisted.resolveAuthorizedWhatsAppOutboundTarget).toHaveBeenCalledWith({
      cfg: baseCfg,
      chatJid: "+1555",
      accountId: "default",
      actionLabel: "upload-file",
    });
    expect(hoisted.sendMessageWhatsApp).toHaveBeenCalledWith(
      "+1555",
      "picture caption",
      expect.objectContaining({
        accountId: "default",
        mediaReadFile,
        mediaUrl: "/tmp/pic.png",
      }),
    );
  });

  it("does not send upload-file when target authorization fails", async () => {
    hoisted.resolveAuthorizedWhatsAppOutboundTarget.mockImplementationOnce(() => {
      throw new Error("WhatsApp upload-file blocked");
    });

    await expect(
      upload({
        to: "+1555",
        filePath: "/tmp/pic.png",
      }),
    ).rejects.toThrow("WhatsApp upload-file blocked");
    expect(hoisted.sendMessageWhatsApp).not.toHaveBeenCalled();
  });

  it("sends upload-file from a whitespace-heavy base64 data URL", async () => {
    await upload({
      to: "+1555",
      buffer: " \n DATA:text/plain;BASE64, aG Vs\nbG8= \n ",
      contentType: "text/plain",
      filename: "hello.txt",
      filePath: "/tmp/hello.txt",
      forceDocument: true,
      message: "file caption",
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
    ["the data URL", {}, "image/png"],
    ["an explicit contentType", { contentType: "application/pdf" }, "application/pdf"],
    ["an explicit mimeType alias", { mimeType: "image/jpeg" }, "image/jpeg"],
    [
      "contentType before its mimeType alias",
      { contentType: "application/pdf", mimeType: "image/jpeg" },
      "application/pdf",
    ],
  ] as const)(
    "resolves upload-file buffer MIME metadata from %s",
    async (_name, metadata, expectedContentType) => {
      await upload({
        to: "+1555",
        buffer: `data:image/png;base64,${Buffer.from("image").toString("base64")}`,
        ...metadata,
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
    await upload({
      to: "+1555",
      mediaUrl: "https://example.com/download",
      filename: "preferred.pdf",
      fileName: "ignored.pdf",
    });

    expect(hoisted.sendMessageWhatsApp).toHaveBeenCalledWith(
      "+1555",
      "",
      expect.objectContaining({ fileName: "preferred.pdf" }),
    );
  });

  it.each(["SGVsbG8=!", "data:text/plain,hello", "data:text/plain;base64"])(
    "rejects malformed upload-file buffer %s",
    async (buffer) => {
      await expect(upload({ to: "+1555", buffer })).rejects.toThrow(
        "must be valid base64 or a base64 data URL",
      );
      expect(hoisted.sendMessageWhatsApp).not.toHaveBeenCalled();
    },
  );

  it("rejects upload-file buffers above the WhatsApp media limit", async () => {
    hoisted.resolveWhatsAppMediaMaxBytes.mockReturnValueOnce(4);
    const encoded = Buffer.from("hello").toString("base64");
    const bufferFromSpy = vi.spyOn(Buffer, "from");

    try {
      await expect(
        upload({
          to: "+1555",
          buffer: encoded,
          contentType: "text/plain",
          filename: "hello.txt",
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
      upload({
        to: "+1555",
        caption: "missing media",
      }),
    ).rejects.toThrow("WhatsApp upload-file requires media");
    expect(hoisted.sendMessageWhatsApp).not.toHaveBeenCalled();
  });

  it.each([
    ["falls back to the current chat", { emoji: "❤️" }, { emoji: "❤️" }, undefined, undefined],
    [
      "stringifies numeric message IDs",
      { emoji: "🎉", to: "+1555" },
      { messageId: "12345", emoji: "🎉" },
      12345,
      undefined,
    ],
    [
      "infers the group participant",
      { emoji: "👍", to: "12345@g.us" },
      { chatJid: "12345@g.us", participant: "123@lid" },
      undefined,
      "12345@g.us",
    ],
    [
      "does not infer a direct-chat participant",
      { emoji: "👍", to: "+1555" },
      {},
      undefined,
      undefined,
    ],
    [
      "prefers the explicit participant",
      { emoji: "👍", to: "12345@g.us", participant: "555@s.whatsapp.net" },
      { chatJid: "12345@g.us", participant: "555@s.whatsapp.net" },
      undefined,
      "12345@g.us",
    ],
    [
      "does not infer a participant for an explicit message",
      { emoji: "👍", to: "12345@g.us", messageId: "older-msg-7" },
      { chatJid: "12345@g.us", messageId: "older-msg-7" },
      undefined,
      "12345@g.us",
    ],
  ] as const)("%s", async (_name, params, expected, currentId, chat) => {
    await react(params, {
      requesterSenderId: "123@lid",
      toolContext: whatsAppToolContext(`whatsapp:${chat ?? "+1555"}`, currentId ?? "ctx-msg-42"),
    });
    expectReactionForwarded(expected);
  });

  it.each([
    ["missing message ID and context", "+1555", undefined],
    [
      "cross-chat participant",
      "99999@g.us",
      whatsAppToolContext("whatsapp:12345@g.us", "ctx-msg-42"),
    ],
    [
      "another provider",
      "+1555",
      {
        currentChannelId: "telegram:-1003841603622",
        currentChannelProvider: "telegram",
        currentMessageId: "tg-msg-99",
      },
    ],
    [
      "missing current channel",
      "+1555",
      { currentChannelProvider: "whatsapp", currentMessageId: "ctx-msg-42" },
    ],
  ] as const)("rejects reaction context: %s", async (_name, to, toolContext) => {
    const err = await react(
      { emoji: "👍", to },
      { requesterSenderId: "123@lid", toolContext },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("ToolInputError");
    expect(hoisted.handleWhatsAppAction).not.toHaveBeenCalled();
  });
});
