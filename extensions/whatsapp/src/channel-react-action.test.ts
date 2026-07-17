// Whatsapp tests cover channel react action plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleWhatsAppMessageAction } from "./channel-react-action.js";
import type { OpenClawConfig } from "./runtime-api.js";

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
  sendStatusWhatsApp: vi.fn(async () => ({
    messageId: "status-1",
    toJid: "status@broadcast",
  })),
}));

vi.mock("./channel-react-action.runtime.js", async () => {
  return {
    handleWhatsAppAction: hoisted.handleWhatsAppAction,
    resolveAuthorizedWhatsAppOutboundTarget: hoisted.resolveAuthorizedWhatsAppOutboundTarget,
    resolveWhatsAppAccount: hoisted.resolveWhatsAppAccount,
    resolveWhatsAppMediaMaxBytes: hoisted.resolveWhatsAppMediaMaxBytes,
    sendMessageWhatsApp: hoisted.sendMessageWhatsApp,
    sendStatusWhatsApp: hoisted.sendStatusWhatsApp,
    createActionGate:
      (actions?: { status?: boolean }) =>
      (name: string, defaultValue = true) =>
        name === "status" ? (actions?.status ?? defaultValue) : defaultValue,
    readStringArrayParam: (
      params: Record<string, unknown>,
      key: string,
      options?: { required?: boolean },
    ) => {
      const value = params[key];
      const entries = Array.isArray(value)
        ? value.filter(
            (entry): entry is string => typeof entry === "string" && Boolean(entry.trim()),
          )
        : [];
      if (entries.length > 0) {
        return entries;
      }
      if (options?.required) {
        throw new Error(`${key} required`);
      }
      return undefined;
    },
    readNumberParam: (params: Record<string, unknown>, key: string) => {
      const value = params[key];
      return typeof value === "number" ? value : undefined;
    },
    ToolAuthorizationError: class ToolAuthorizationError extends Error {},
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
    isWhatsAppNewsletterJid: (value?: string | null) =>
      (value ?? "").trim().endsWith("@newsletter"),
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

  beforeEach(() => {
    hoisted.handleWhatsAppAction.mockClear();
    hoisted.resolveAuthorizedWhatsAppOutboundTarget.mockClear();
    hoisted.resolveWhatsAppAccount.mockClear();
    hoisted.resolveWhatsAppMediaMaxBytes.mockClear();
    hoisted.resolveWhatsAppAccount.mockReturnValue({ accountId: "default", mediaMaxMb: 50 });
    hoisted.resolveWhatsAppMediaMaxBytes.mockReturnValue(50 * 1024 * 1024);
    hoisted.sendMessageWhatsApp.mockClear();
    hoisted.sendStatusWhatsApp.mockClear();
  });

  it("publishes a Status for an owner to an explicit allowlisted audience", async () => {
    const cfg = {
      channels: {
        whatsapp: { actions: { status: true }, allowFrom: ["+1555", "+1666"] },
      },
    } as OpenClawConfig;
    hoisted.resolveWhatsAppAccount.mockReturnValue({
      accountId: "default",
      mediaMaxMb: 50,
      allowFrom: ["+1555", "+1666"],
    });

    const result = await handleWhatsAppMessageAction({
      action: "post-status",
      params: {
        audience: ["+1555", "+1666"],
        message: "Release shipped",
        backgroundColor: "#112233",
        font: 6,
      },
      cfg,
      accountId: "default",
      senderIsOwner: true,
    });

    expect(hoisted.sendStatusWhatsApp).toHaveBeenCalledWith("Release shipped", {
      cfg,
      audience: ["+1555", "+1666"],
      mediaAccess: undefined,
      mediaLocalRoots: undefined,
      mediaReadFile: undefined,
      backgroundColor: "#112233",
      font: 6,
      accountId: "default",
    });
    expect(result.details).toEqual({
      ok: true,
      channel: "whatsapp",
      action: "post-status",
      messageId: "status-1",
      toJid: "status@broadcast",
      audienceCount: 2,
    });
  });

  it("rejects Status publishing when disabled, non-owner, or missing an audience", async () => {
    const enabledCfg = {
      channels: { whatsapp: { actions: { status: true }, allowFrom: ["+1555"] } },
    } as OpenClawConfig;

    await expect(
      handleWhatsAppMessageAction({
        action: "post-status",
        params: { audience: ["+1555"], message: "hello" },
        cfg: baseCfg,
        senderIsOwner: true,
      }),
    ).rejects.toThrow("WhatsApp Status publishing is disabled");
    await expect(
      handleWhatsAppMessageAction({
        action: "post-status",
        params: { audience: ["+1555"], message: "hello" },
        cfg: enabledCfg,
        senderIsOwner: false,
      }),
    ).rejects.toThrow("requires a trusted owner");
    await expect(
      handleWhatsAppMessageAction({
        action: "post-status",
        params: { message: "hello" },
        cfg: enabledCfg,
        senderIsOwner: true,
      }),
    ).rejects.toThrow("audience required");
    expect(hoisted.sendStatusWhatsApp).not.toHaveBeenCalled();
  });

  it("does not publish when a Status audience recipient is unauthorized", async () => {
    const cfg = {
      channels: { whatsapp: { actions: { status: true }, allowFrom: ["+1555"] } },
    } as OpenClawConfig;
    hoisted.resolveWhatsAppAccount.mockReturnValue({
      accountId: "default",
      mediaMaxMb: 50,
      allowFrom: ["+1555"],
    });

    await expect(
      handleWhatsAppMessageAction({
        action: "post-status",
        params: { audience: ["+1999"], message: "hello" },
        cfg,
        senderIsOwner: true,
      }),
    ).rejects.toThrow("WhatsApp Status audience blocked");
    expect(hoisted.sendStatusWhatsApp).not.toHaveBeenCalled();
  });

  it("rejects groups in a Status audience", async () => {
    const cfg = {
      channels: { whatsapp: { actions: { status: true }, allowFrom: ["*"] } },
    } as OpenClawConfig;
    hoisted.resolveWhatsAppAccount.mockReturnValue({
      accountId: "default",
      mediaMaxMb: 50,
      allowFrom: ["*"],
    });

    await expect(
      handleWhatsAppMessageAction({
        action: "post-status",
        params: { audience: ["123@g.us"], message: "hello" },
        cfg,
        senderIsOwner: true,
      }),
    ).rejects.toThrow("is not a direct-user target");
    expect(hoisted.sendStatusWhatsApp).not.toHaveBeenCalled();
  });

  it("does not treat the allowFrom wildcard as an explicit Status audience entry", async () => {
    const cfg = {
      channels: { whatsapp: { actions: { status: true }, allowFrom: ["*"] } },
    } as OpenClawConfig;
    hoisted.resolveWhatsAppAccount.mockReturnValue({
      accountId: "default",
      mediaMaxMb: 50,
      allowFrom: ["*"],
    });

    await expect(
      handleWhatsAppMessageAction({
        action: "post-status",
        params: { audience: ["+1555"], message: "hello" },
        cfg,
        senderIsOwner: true,
      }),
    ).rejects.toThrow("is not explicitly listed in allowFrom");
    expect(hoisted.sendStatusWhatsApp).not.toHaveBeenCalled();
  });

  it("reports the deduplicated Status audience count", async () => {
    const cfg = {
      channels: { whatsapp: { actions: { status: true }, allowFrom: ["+1555"] } },
    } as OpenClawConfig;
    hoisted.resolveWhatsAppAccount.mockReturnValue({
      accountId: "default",
      mediaMaxMb: 50,
      allowFrom: ["+1555"],
    });

    const result = await handleWhatsAppMessageAction({
      action: "post-status",
      params: { audience: ["+1555", "+1555"], message: "hello" },
      cfg,
      senderIsOwner: true,
    });

    expect(hoisted.sendStatusWhatsApp).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ audience: ["+1555"] }),
    );
    expect(result.details).toMatchObject({ audienceCount: 1 });
  });

  it("sends upload-file through the WhatsApp media send path", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("media"));

    const result = await handleWhatsAppMessageAction({
      action: "upload-file",
      params: {
        to: "+1555",
        filePath: "/tmp/pic.png",
        caption: "picture caption",
        forceDocument: "true",
        gifPlayback: true,
        asVoice: "true",
      },
      cfg: baseCfg,
      accountId: "default",
      mediaLocalRoots: ["/tmp"],
      mediaReadFile,
    });

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

  it("uses toolContext current chat for same-chat upload-file", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("media"));

    await handleWhatsAppMessageAction({
      action: "upload-file",
      params: {
        filePath: "/tmp/pic.png",
        caption: "picture caption",
      },
      cfg: baseCfg,
      accountId: "default",
      mediaLocalRoots: ["/tmp"],
      mediaReadFile,
      toolContext: {
        currentChannelId: "whatsapp:+1555",
        currentChannelProvider: "whatsapp",
        currentMessageId: "ctx-msg-42",
      },
    });

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

  it("sends upload-file from the hydrated buffer payload", async () => {
    await handleWhatsAppMessageAction({
      action: "upload-file",
      params: {
        to: "+1555",
        buffer: Buffer.from("hello").toString("base64"),
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

  it("rejects upload-file buffers above the WhatsApp media limit", async () => {
    hoisted.resolveWhatsAppMediaMaxBytes.mockReturnValueOnce(4);

    await expect(
      handleWhatsAppMessageAction({
        action: "upload-file",
        params: {
          to: "+1555",
          buffer: Buffer.from("hello").toString("base64"),
          contentType: "text/plain",
          filename: "hello.txt",
        },
        cfg: baseCfg,
        accountId: "default",
      }),
    ).rejects.toThrow("WhatsApp upload-file buffer exceeds configured media limit");
    expect(hoisted.sendMessageWhatsApp).not.toHaveBeenCalled();
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

  it("uses explicit messageId when provided", async () => {
    await handleWhatsAppMessageAction({
      action: "react",
      params: { messageId: "explicit-id", emoji: "👍", to: "+1555" },
      cfg: baseCfg,
      accountId: "default",
    });
    expect(hoisted.handleWhatsAppAction).toHaveBeenCalledWith(
      {
        action: "react",
        chatJid: "+1555",
        messageId: "explicit-id",
        emoji: "👍",
        remove: undefined,
        participant: undefined,
        accountId: "default",
        fromMe: undefined,
      },
      baseCfg,
    );
  });

  it("falls back to toolContext.currentMessageId when messageId omitted", async () => {
    await handleWhatsAppMessageAction({
      action: "react",
      params: { emoji: "❤️", to: "+1555" },
      cfg: baseCfg,
      accountId: "default",
      toolContext: {
        currentChannelId: "whatsapp:+1555",
        currentChannelProvider: "whatsapp",
        currentMessageId: "ctx-msg-42",
      },
    });
    expect(hoisted.handleWhatsAppAction).toHaveBeenCalledWith(
      {
        action: "react",
        chatJid: "+1555",
        messageId: "ctx-msg-42",
        emoji: "❤️",
        remove: undefined,
        participant: undefined,
        accountId: "default",
        fromMe: undefined,
      },
      baseCfg,
    );
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
    expect(hoisted.handleWhatsAppAction).toHaveBeenCalledWith(
      {
        action: "react",
        chatJid: "+1555",
        messageId: "ctx-msg-42",
        emoji: "❤️",
        remove: undefined,
        participant: undefined,
        accountId: "default",
        fromMe: undefined,
      },
      baseCfg,
    );
  });

  it("converts numeric toolContext messageId to string", async () => {
    await handleWhatsAppMessageAction({
      action: "react",
      params: { emoji: "🎉", to: "+1555" },
      cfg: baseCfg,
      accountId: "default",
      toolContext: {
        currentChannelId: "whatsapp:+1555",
        currentChannelProvider: "whatsapp",
        currentMessageId: 12345,
      },
    });
    expect(hoisted.handleWhatsAppAction).toHaveBeenCalledWith(
      {
        action: "react",
        chatJid: "+1555",
        messageId: "12345",
        emoji: "🎉",
        remove: undefined,
        participant: undefined,
        accountId: "default",
        fromMe: undefined,
      },
      baseCfg,
    );
  });

  it("throws ToolInputError when messageId missing and no toolContext", async () => {
    const err = await handleWhatsAppMessageAction({
      action: "react",
      params: { emoji: "👍", to: "+1555" },
      cfg: baseCfg,
      accountId: "default",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("ToolInputError");
  });

  it("skips context fallback when targeting a different chat", async () => {
    const err = await handleWhatsAppMessageAction({
      action: "react",
      params: { emoji: "👍", to: "+9999" },
      cfg: baseCfg,
      accountId: "default",
      toolContext: {
        currentChannelId: "whatsapp:+1555",
        currentChannelProvider: "whatsapp",
        currentMessageId: "ctx-msg-42",
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("ToolInputError");
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
    expect(hoisted.handleWhatsAppAction).toHaveBeenCalledWith(
      {
        action: "react",
        chatJid: "12345@g.us",
        messageId: "ctx-msg-42",
        emoji: "👍",
        remove: undefined,
        participant: "123@lid",
        accountId: "default",
        fromMe: undefined,
      },
      baseCfg,
    );
  });

  it("keeps direct-chat reactions without an inferred participant", async () => {
    await handleWhatsAppMessageAction({
      action: "react",
      params: { emoji: "👍", to: "+1555" },
      cfg: baseCfg,
      accountId: "default",
      requesterSenderId: "123@lid",
      toolContext: {
        currentChannelId: "whatsapp:+1555",
        currentChannelProvider: "whatsapp",
        currentMessageId: "ctx-msg-42",
      },
    });
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
      },
      baseCfg,
    );
  });

  it("prefers explicit participant over inferred current-message participant", async () => {
    await handleWhatsAppMessageAction({
      action: "react",
      params: {
        emoji: "👍",
        to: "12345@g.us",
        participant: "555@s.whatsapp.net",
      },
      cfg: baseCfg,
      accountId: "default",
      requesterSenderId: "123@lid",
      toolContext: {
        currentChannelId: "whatsapp:12345@g.us",
        currentChannelProvider: "whatsapp",
        currentMessageId: "ctx-msg-42",
      },
    });
    expect(hoisted.handleWhatsAppAction).toHaveBeenCalledWith(
      {
        action: "react",
        chatJid: "12345@g.us",
        messageId: "ctx-msg-42",
        emoji: "👍",
        remove: undefined,
        participant: "555@s.whatsapp.net",
        accountId: "default",
        fromMe: undefined,
      },
      baseCfg,
    );
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

  it("does not infer participant when messageId is explicitly provided", async () => {
    await handleWhatsAppMessageAction({
      action: "react",
      params: { emoji: "👍", to: "12345@g.us", messageId: "older-msg-7" },
      cfg: baseCfg,
      accountId: "default",
      requesterSenderId: "123@lid",
      toolContext: {
        currentChannelId: "whatsapp:12345@g.us",
        currentChannelProvider: "whatsapp",
        currentMessageId: "ctx-msg-42",
      },
    });
    expect(hoisted.handleWhatsAppAction).toHaveBeenCalledWith(
      {
        action: "react",
        chatJid: "12345@g.us",
        messageId: "older-msg-7",
        emoji: "👍",
        remove: undefined,
        participant: undefined,
        accountId: "default",
        fromMe: undefined,
      },
      baseCfg,
    );
  });

  it("skips context fallback when source is another provider", async () => {
    const err = await handleWhatsAppMessageAction({
      action: "react",
      params: { emoji: "👍", to: "+1555" },
      cfg: baseCfg,
      accountId: "default",
      toolContext: {
        currentChannelId: "telegram:-1003841603622",
        currentChannelProvider: "telegram",
        currentMessageId: "tg-msg-99",
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("ToolInputError");
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
