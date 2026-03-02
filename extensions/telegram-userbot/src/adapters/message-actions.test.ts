import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { telegramUserbotMessageActions } from "./message-actions.js";

// ---------------------------------------------------------------------------
// Mocked UserbotClient methods
// ---------------------------------------------------------------------------

const mockClient = {
  deleteMessages: vi.fn().mockResolvedValue(undefined),
  editMessage: vi.fn().mockResolvedValue(undefined),
  reactToMessage: vi.fn().mockResolvedValue(undefined),
  pinMessage: vi.fn().mockResolvedValue(undefined),
  forwardMessages: vi.fn().mockResolvedValue(undefined),
};

const mockManager = {
  getClient: vi.fn().mockReturnValue(mockClient),
};

// Mock getConnectionManager to return our mock manager
vi.mock("../channel.js", () => ({
  getConnectionManager: vi.fn((accountId: string) => {
    if (accountId === "missing") return undefined;
    return mockManager;
  }),
}));

// Mock config adapter to return a configured+enabled account by default
vi.mock("./config.js", () => ({
  resolveTelegramUserbotAccount: vi.fn(({ cfg }: { cfg: OpenClawConfig }) => {
    const section = cfg.channels?.["telegram-userbot"] as Record<string, unknown> | undefined;
    const enabled = section?.enabled !== false;
    const configured = Boolean(section?.apiId && section?.apiHash);
    return {
      accountId: "default",
      enabled,
      configured,
      apiId: section?.apiId ?? 0,
      apiHash: section?.apiHash ?? "",
      config: section ?? {},
    };
  }),
}));

describe("telegramUserbotMessageActions", () => {
  const listActions = telegramUserbotMessageActions.listActions!;
  const supportsAction = telegramUserbotMessageActions.supportsAction!;
  const handleAction = telegramUserbotMessageActions.handleAction!;

  const callAction = (
    overrides: Partial<Parameters<typeof handleAction>[0]> & {
      action: Parameters<typeof handleAction>[0]["action"];
    },
  ) =>
    handleAction({
      channel: "telegram-userbot",
      cfg: makeCfg(),
      params: {},
      accountId: "default",
      ...overrides,
    });

  function makeCfg(extra: Record<string, unknown> = {}): OpenClawConfig {
    return {
      channels: {
        "telegram-userbot": {
          apiId: 12345,
          apiHash: "abc123hash",
          ...extra,
        },
      },
    } as unknown as OpenClawConfig;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockManager.getClient.mockReturnValue(mockClient);
  });

  // -------------------------------------------------------------------------
  // listActions
  // -------------------------------------------------------------------------

  describe("listActions", () => {
    it("returns supported actions when account is enabled and configured", () => {
      const actions = listActions({ cfg: makeCfg() });
      expect(actions).toContain("delete");
      expect(actions).toContain("edit");
      expect(actions).toContain("unsend");
      expect(actions).toContain("react");
      expect(actions).toContain("pin");
    });

    it("returns empty when account is not enabled", () => {
      const cfg = makeCfg({ enabled: false });
      const actions = listActions({ cfg });
      expect(actions).toEqual([]);
    });

    it("returns empty when account is not configured", () => {
      const cfg = {
        channels: { "telegram-userbot": {} },
      } as unknown as OpenClawConfig;
      const actions = listActions({ cfg });
      expect(actions).toEqual([]);
    });

    it("excludes react when reactions gate is off", () => {
      const cfg = makeCfg({ actions: { reactions: false } });
      const actions = listActions({ cfg });
      expect(actions).not.toContain("react");
      expect(actions).toContain("delete");
      expect(actions).toContain("edit");
    });

    it("excludes message actions when messages gate is off", () => {
      const cfg = makeCfg({ actions: { messages: false } });
      const actions = listActions({ cfg });
      expect(actions).not.toContain("delete");
      expect(actions).not.toContain("edit");
      expect(actions).not.toContain("unsend");
      expect(actions).toContain("react");
      expect(actions).toContain("pin");
    });

    it("excludes pin when pins gate is off", () => {
      const cfg = makeCfg({ actions: { pins: false } });
      const actions = listActions({ cfg });
      expect(actions).not.toContain("pin");
      expect(actions).toContain("delete");
    });
  });

  // -------------------------------------------------------------------------
  // supportsAction
  // -------------------------------------------------------------------------

  describe("supportsAction", () => {
    it("returns true for delete", () => {
      expect(supportsAction({ action: "delete" })).toBe(true);
    });

    it("returns true for edit", () => {
      expect(supportsAction({ action: "edit" })).toBe(true);
    });

    it("returns true for react", () => {
      expect(supportsAction({ action: "react" })).toBe(true);
    });

    it("returns true for pin", () => {
      expect(supportsAction({ action: "pin" })).toBe(true);
    });

    it("returns true for unsend", () => {
      expect(supportsAction({ action: "unsend" })).toBe(true);
    });

    it("returns false for unsupported action", () => {
      expect(supportsAction({ action: "unknown" as never })).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // handleAction — delete
  // -------------------------------------------------------------------------

  describe("handleAction — delete", () => {
    it("calls client.deleteMessages with correct params", async () => {
      const result = await callAction({
        action: "delete",
        params: { to: "12345", messageId: 42 },
      });

      expect(mockClient.deleteMessages).toHaveBeenCalledWith("12345", [42], true);
      expect(result).toMatchObject({ details: { ok: true, deleted: 42 } });
    });

    it("uses toolContext for peer when no explicit target", async () => {
      const result = await callAction({
        action: "delete",
        params: { messageId: 99 },
        toolContext: { currentChannelId: "telegram-userbot:54321" },
      });

      expect(mockClient.deleteMessages).toHaveBeenCalledWith("54321", [99], true);
      expect(result).toMatchObject({ details: { ok: true, deleted: 99 } });
    });

    it("throws when messageId is missing", async () => {
      await expect(callAction({ action: "delete", params: { to: "12345" } })).rejects.toThrow(
        /messageId/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // handleAction — unsend (alias for delete)
  // -------------------------------------------------------------------------

  describe("handleAction — unsend", () => {
    it("calls client.deleteMessages (same as delete)", async () => {
      const result = await callAction({
        action: "unsend",
        params: { to: "12345", messageId: 7 },
      });

      expect(mockClient.deleteMessages).toHaveBeenCalledWith("12345", [7], true);
      expect(result).toMatchObject({ details: { ok: true, deleted: 7 } });
    });
  });

  // -------------------------------------------------------------------------
  // handleAction — edit
  // -------------------------------------------------------------------------

  describe("handleAction — edit", () => {
    it("calls client.editMessage with correct params", async () => {
      const result = await callAction({
        action: "edit",
        params: { to: "12345", messageId: 10, text: "updated text" },
      });

      expect(mockClient.editMessage).toHaveBeenCalledWith("12345", 10, "updated text");
      expect(result).toMatchObject({ details: { ok: true, edited: 10 } });
    });

    it("accepts newText alias", async () => {
      await callAction({
        action: "edit",
        params: { to: "12345", messageId: 10, newText: "new content" },
      });

      expect(mockClient.editMessage).toHaveBeenCalledWith("12345", 10, "new content");
    });

    it("accepts message alias", async () => {
      await callAction({
        action: "edit",
        params: { to: "12345", messageId: 10, message: "msg content" },
      });

      expect(mockClient.editMessage).toHaveBeenCalledWith("12345", 10, "msg content");
    });

    it("throws when text is missing", async () => {
      await expect(
        callAction({
          action: "edit",
          params: { to: "12345", messageId: 10 },
        }),
      ).rejects.toThrow(/text/i);
    });

    it("throws when messageId is missing", async () => {
      await expect(
        callAction({
          action: "edit",
          params: { to: "12345", text: "update" },
        }),
      ).rejects.toThrow(/messageId/);
    });
  });

  // -------------------------------------------------------------------------
  // handleAction — react
  // -------------------------------------------------------------------------

  describe("handleAction — react", () => {
    it("calls client.reactToMessage with correct params", async () => {
      const result = await callAction({
        action: "react",
        params: { to: "12345", messageId: 20, emoji: "\u2764\uFE0F" },
      });

      expect(mockClient.reactToMessage).toHaveBeenCalledWith("12345", 20, "\u2764\uFE0F");
      expect(result).toMatchObject({
        details: { ok: true, reacted: "\u2764\uFE0F", messageId: 20 },
      });
    });

    it("throws when emoji is missing", async () => {
      await expect(
        callAction({
          action: "react",
          params: { to: "12345", messageId: 20 },
        }),
      ).rejects.toThrow(/emoji/i);
    });

    it("throws when messageId is missing", async () => {
      await expect(
        callAction({
          action: "react",
          params: { to: "12345", emoji: "\u{1F44D}" },
        }),
      ).rejects.toThrow(/messageId/);
    });
  });

  // -------------------------------------------------------------------------
  // handleAction — pin
  // -------------------------------------------------------------------------

  describe("handleAction — pin", () => {
    it("calls client.pinMessage with correct params", async () => {
      const result = await callAction({
        action: "pin",
        params: { to: "12345", messageId: 55 },
      });

      expect(mockClient.pinMessage).toHaveBeenCalledWith("12345", 55);
      expect(result).toMatchObject({ details: { ok: true, pinned: 55 } });
    });

    it("throws when messageId is missing", async () => {
      await expect(callAction({ action: "pin", params: { to: "12345" } })).rejects.toThrow(
        /messageId/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // handleAction — unsupported action
  // -------------------------------------------------------------------------

  describe("handleAction — unsupported", () => {
    it("throws for an action not in the supported set", async () => {
      await expect(
        callAction({
          action: "search" as never,
          params: { to: "12345" },
        }),
      ).rejects.toThrow(/not supported/);
    });
  });

  // -------------------------------------------------------------------------
  // handleAction — client errors
  // -------------------------------------------------------------------------

  describe("handleAction — client errors", () => {
    it("propagates client errors as-is", async () => {
      mockClient.deleteMessages.mockRejectedValueOnce(new Error("FLOOD_WAIT"));

      await expect(
        callAction({
          action: "delete",
          params: { to: "12345", messageId: 1 },
        }),
      ).rejects.toThrow("FLOOD_WAIT");
    });

    it("throws when no connection manager is available", async () => {
      await expect(
        callAction({
          action: "delete",
          params: { to: "12345", messageId: 1 },
          accountId: "missing",
        }),
      ).rejects.toThrow(/no active connection/);
    });

    it("throws when client is null (disconnected)", async () => {
      mockManager.getClient.mockReturnValueOnce(null);

      await expect(
        callAction({
          action: "delete",
          params: { to: "12345", messageId: 1 },
        }),
      ).rejects.toThrow(/not connected/);
    });
  });

  // -------------------------------------------------------------------------
  // handleAction — peer resolution
  // -------------------------------------------------------------------------

  describe("handleAction — peer resolution", () => {
    it("throws when no target is provided and no toolContext", async () => {
      await expect(
        callAction({
          action: "delete",
          params: { messageId: 1 },
        }),
      ).rejects.toThrow(/requires a target/);
    });

    it("accepts chatId as peer alias", async () => {
      await callAction({
        action: "pin",
        params: { chatId: "99999", messageId: 1 },
      });

      expect(mockClient.pinMessage).toHaveBeenCalledWith("99999", 1);
    });

    it("accepts peer as peer alias", async () => {
      await callAction({
        action: "pin",
        params: { peer: "@someuser", messageId: 1 },
      });

      expect(mockClient.pinMessage).toHaveBeenCalledWith("@someuser", 1);
    });

    it("strips telegram-userbot prefix from toolContext channelId", async () => {
      await callAction({
        action: "pin",
        params: { messageId: 1 },
        toolContext: { currentChannelId: "telegram-userbot:777" },
      });

      expect(mockClient.pinMessage).toHaveBeenCalledWith("777", 1);
    });
  });

  // -------------------------------------------------------------------------
  // extractToolSend
  // -------------------------------------------------------------------------

  describe("extractToolSend", () => {
    const extract = telegramUserbotMessageActions.extractToolSend!;

    it("extracts send params from sendMessage action", () => {
      const result = extract({
        args: { action: "sendMessage", to: "12345", accountId: "acct1" },
      });
      expect(result).toEqual({ to: "12345", accountId: "acct1" });
    });

    it("returns null for non-sendMessage action", () => {
      const result = extract({ args: { action: "react", to: "12345" } });
      expect(result).toBeNull();
    });

    it("returns null when to is missing", () => {
      const result = extract({ args: { action: "sendMessage" } });
      expect(result).toBeNull();
    });
  });
});
