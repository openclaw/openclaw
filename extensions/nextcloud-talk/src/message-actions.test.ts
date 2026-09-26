// Nextcloud Talk tests cover message actions plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig, NextcloudTalkAccountConfig } from "./types.js";

const hoisted = vi.hoisted(() => ({
  sendReactionNextcloudTalk: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendReactionNextcloudTalk: hoisted.sendReactionNextcloudTalk,
}));

const { nextcloudTalkMessageActions } = await import("./message-actions.js");

function createConfig(accounts: Record<string, NextcloudTalkAccountConfig> = {}): CoreConfig {
  return {
    channels: {
      "nextcloud-talk": {
        baseUrl: "https://nc.example.com",
        botSecret: "bot-secret",
        accounts,
      },
    },
  };
}

describe("nextcloudTalkMessageActions", () => {
  let previousBotSecret: string | undefined;

  beforeEach(() => {
    // The default account prefers this ambient credential over the supplied config.
    previousBotSecret = process.env.NEXTCLOUD_TALK_BOT_SECRET;
    delete process.env.NEXTCLOUD_TALK_BOT_SECRET;
    hoisted.sendReactionNextcloudTalk.mockReset();
    hoisted.sendReactionNextcloudTalk.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    if (previousBotSecret === undefined) {
      delete process.env.NEXTCLOUD_TALK_BOT_SECRET;
    } else {
      process.env.NEXTCLOUD_TALK_BOT_SECRET = previousBotSecret;
    }
  });

  describe("describeMessageTool", () => {
    it("returns null when no accounts are configured", () => {
      const result = nextcloudTalkMessageActions.describeMessageTool?.({
        cfg: {},
      });

      expect(result).toBeNull();
    });

    it.each([
      ["secret", { baseUrl: "https://nc.example.com" }],
      ["baseUrl", { botSecret: "bot-secret" }],
    ] as const)("returns null when configured account has no %s", (_missing, config) => {
      const result = nextcloudTalkMessageActions.describeMessageTool?.({
        cfg: { channels: { "nextcloud-talk": { ...config } } },
      });

      expect(result).toBeNull();
    });

    it("returns null when the only listed account is disabled", () => {
      const result = nextcloudTalkMessageActions.describeMessageTool?.({
        cfg: createConfig({ default: { enabled: false } }),
      });

      expect(result).toBeNull();
    });

    it("advertises send + react when an account is configured", () => {
      const result = nextcloudTalkMessageActions.describeMessageTool?.({
        cfg: createConfig(),
      });

      expect(result?.actions).toEqual(["send", "react"]);
    });

    it("scopes discovery to a specific accountId when provided", () => {
      const result = nextcloudTalkMessageActions.describeMessageTool?.({
        cfg: createConfig({ default: { enabled: false }, work: { enabled: true } }),
        accountId: "work",
      });

      expect(result?.actions).toEqual(["send", "react"]);
    });

    it("returns null when the targeted account is disabled", () => {
      const result = nextcloudTalkMessageActions.describeMessageTool?.({
        cfg: createConfig({ work: { enabled: false } }),
        accountId: "work",
      });

      expect(result).toBeNull();
    });
  });

  describe("supportsAction", () => {
    it("delegates send back to outbound", () => {
      expect(nextcloudTalkMessageActions.supportsAction?.({ action: "send" })).toBe(false);
    });

    it("handles react locally", () => {
      expect(nextcloudTalkMessageActions.supportsAction?.({ action: "react" })).toBe(true);
    });

    it("rejects unsupported actions", () => {
      expect(nextcloudTalkMessageActions.supportsAction?.({ action: "delete" })).toBe(false);
      expect(nextcloudTalkMessageActions.supportsAction?.({ action: "pin" })).toBe(false);
      expect(nextcloudTalkMessageActions.supportsAction?.({ action: "edit" })).toBe(false);
      expect(nextcloudTalkMessageActions.supportsAction?.({ action: "read" })).toBe(false);
    });
  });

  describe("handleAction", () => {
    let cfg: CoreConfig;

    beforeEach(() => {
      cfg = createConfig();
    });

    it("rejects a disabled account before reaching the sender", async () => {
      cfg = createConfig({ work: { enabled: false } });

      await expect(
        nextcloudTalkMessageActions.handleAction?.({
          channel: "nextcloud-talk",
          action: "react",
          params: { to: "room:abc123", messageId: "1", emoji: "👍" },
          cfg,
          accountId: "work",
        }),
      ).rejects.toThrow(/is disabled or not configured/);
      expect(hoisted.sendReactionNextcloudTalk).not.toHaveBeenCalled();
    });

    it.each([
      ["secret", { baseUrl: "https://nc.example.com" }],
      ["baseUrl", { botSecret: "bot-secret" }],
    ] as const)(
      "rejects an account without %s before reaching the sender",
      async (_missing, config) => {
        await expect(
          nextcloudTalkMessageActions.handleAction?.({
            channel: "nextcloud-talk",
            action: "react",
            params: { to: "room:abc123", messageId: "1", emoji: "👍" },
            cfg: { channels: { "nextcloud-talk": { ...config } } },
          }),
        ).rejects.toThrow(/is disabled or not configured/);
        expect(hoisted.sendReactionNextcloudTalk).not.toHaveBeenCalled();
      },
    );

    it("invokes sendReactionNextcloudTalk with normalized params for the react action", async () => {
      const result = await nextcloudTalkMessageActions.handleAction?.({
        channel: "nextcloud-talk",
        action: "react",
        params: { to: "room:abc123", messageId: "42", emoji: "👍" },
        cfg,
        accountId: "work",
      });

      expect(hoisted.sendReactionNextcloudTalk).toHaveBeenCalledTimes(1);
      expect(hoisted.sendReactionNextcloudTalk).toHaveBeenCalledWith("room:abc123", "42", "👍", {
        accountId: "work",
        cfg,
      });
      expect(hoisted.sendReactionNextcloudTalk.mock.calls[0]?.[3].cfg).toBe(cfg);
      expect(result).toMatchObject({
        details: { ok: true, added: "👍" },
      });
    });

    it("uses toolContext.currentMessageId when params.messageId is missing", async () => {
      await nextcloudTalkMessageActions.handleAction?.({
        channel: "nextcloud-talk",
        action: "react",
        params: { to: "room:abc123", emoji: "✅" },
        cfg,
        accountId: null,
        toolContext: { currentMessageId: 99 },
      });

      expect(hoisted.sendReactionNextcloudTalk).toHaveBeenCalledWith("room:abc123", "99", "✅", {
        accountId: undefined,
        cfg,
      });
    });

    it("requires a target room token", async () => {
      await expect(
        nextcloudTalkMessageActions.handleAction?.({
          channel: "nextcloud-talk",
          action: "react",
          params: { messageId: "1", emoji: "👍" },
          cfg,
        }),
      ).rejects.toThrow(/to \(room token\) required/);
      expect(hoisted.sendReactionNextcloudTalk).not.toHaveBeenCalled();
    });

    it("requires a messageId (explicit or via toolContext)", async () => {
      await expect(
        nextcloudTalkMessageActions.handleAction?.({
          channel: "nextcloud-talk",
          action: "react",
          params: { to: "room:abc123", emoji: "👍" },
          cfg,
        }),
      ).rejects.toThrow(/messageId required/);
      expect(hoisted.sendReactionNextcloudTalk).not.toHaveBeenCalled();
    });

    it("requires an emoji", async () => {
      await expect(
        nextcloudTalkMessageActions.handleAction?.({
          channel: "nextcloud-talk",
          action: "react",
          params: { to: "room:abc123", messageId: "1" },
          cfg,
        }),
      ).rejects.toThrow(/emoji required/);
      expect(hoisted.sendReactionNextcloudTalk).not.toHaveBeenCalled();
    });

    it("rejects send through the action handler (outbound owns send)", async () => {
      await expect(
        nextcloudTalkMessageActions.handleAction?.({
          channel: "nextcloud-talk",
          action: "send",
          params: { to: "room:abc123", text: "hi" },
          cfg,
        }),
      ).rejects.toThrow(/handled by outbound/);
    });

    it("rejects unsupported actions", async () => {
      await expect(
        nextcloudTalkMessageActions.handleAction?.({
          channel: "nextcloud-talk",
          action: "delete",
          params: {},
          cfg,
        }),
      ).rejects.toThrow(/Action delete not supported for nextcloud-talk/);
    });

    it("rejects reaction removal requests without calling the add-reaction sender", async () => {
      await expect(
        nextcloudTalkMessageActions.handleAction?.({
          channel: "nextcloud-talk",
          action: "react",
          params: { to: "room:abc123", messageId: "1", emoji: "👍", remove: true },
          cfg,
        }),
      ).rejects.toThrow(/removal is not supported/);
      expect(hoisted.sendReactionNextcloudTalk).not.toHaveBeenCalled();
    });

    it("still adds the reaction when remove is explicitly false", async () => {
      await nextcloudTalkMessageActions.handleAction?.({
        channel: "nextcloud-talk",
        action: "react",
        params: { to: "room:abc123", messageId: "1", emoji: "👍", remove: false },
        cfg,
      });

      expect(hoisted.sendReactionNextcloudTalk).toHaveBeenCalledTimes(1);
    });

    it("propagates errors from sendReactionNextcloudTalk", async () => {
      hoisted.sendReactionNextcloudTalk.mockRejectedValueOnce(
        new Error("Nextcloud Talk reaction failed: 403 forbidden"),
      );

      await expect(
        nextcloudTalkMessageActions.handleAction?.({
          channel: "nextcloud-talk",
          action: "react",
          params: { to: "room:abc123", messageId: "1", emoji: "👍" },
          cfg,
        }),
      ).rejects.toThrow(/403 forbidden/);
    });
  });
});
