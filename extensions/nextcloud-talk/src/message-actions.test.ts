import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "./types.js";

const hoisted = vi.hoisted(() => ({
  sendReactionNextcloudTalk: vi.fn(),
  listNextcloudTalkAccountIds: vi.fn(),
  resolveNextcloudTalkAccount: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendReactionNextcloudTalk: hoisted.sendReactionNextcloudTalk,
}));

vi.mock("./accounts.js", () => ({
  listNextcloudTalkAccountIds: hoisted.listNextcloudTalkAccountIds,
  resolveNextcloudTalkAccount: hoisted.resolveNextcloudTalkAccount,
}));

const { nextcloudTalkMessageActions } = await import("./message-actions.js");

const configuredAccount = {
  accountId: "default",
  enabled: true,
  baseUrl: "https://nc.example.com",
  secret: "bot-secret",
} as const;

const unconfiguredAccount = { ...configuredAccount, baseUrl: "", secret: null };
const disabledAccount = { ...configuredAccount, enabled: false };
const reaction = { to: "room:abc123", messageId: "1", emoji: "👍" };

describe("nextcloudTalkMessageActions", () => {
  beforeEach(() => {
    hoisted.sendReactionNextcloudTalk.mockReset();
    hoisted.sendReactionNextcloudTalk.mockResolvedValue(undefined);
    hoisted.listNextcloudTalkAccountIds.mockReset();
    hoisted.resolveNextcloudTalkAccount.mockReset();
  });

  describe("describeMessageTool", () => {
    it("returns null when configured account has no secret/baseUrl", () => {
      hoisted.listNextcloudTalkAccountIds.mockReturnValue([unconfiguredAccount.accountId]);
      hoisted.resolveNextcloudTalkAccount.mockReturnValue(unconfiguredAccount);

      expect(nextcloudTalkMessageActions.describeMessageTool?.({ cfg: {} })).toBeNull();
    });

    it("scopes discovery to a specific accountId when provided", () => {
      hoisted.resolveNextcloudTalkAccount.mockReturnValue(configuredAccount);

      const result = nextcloudTalkMessageActions.describeMessageTool?.({
        cfg: {},
        accountId: "work",
      });

      expect(hoisted.resolveNextcloudTalkAccount).toHaveBeenCalledWith({
        cfg: {},
        accountId: "work",
      });
      expect(hoisted.listNextcloudTalkAccountIds).not.toHaveBeenCalled();
      expect(result?.actions).toEqual(["send", "react"]);
    });
  });

  it("handles react locally", () => {
    expect(nextcloudTalkMessageActions.supportsAction?.({ action: "react" })).toBe(true);
  });

  describe("handleAction", () => {
    const cfg = {} as CoreConfig;

    function react(
      params: Record<string, unknown>,
      context: Pick<
        Parameters<NonNullable<typeof nextcloudTalkMessageActions.handleAction>>[0],
        "accountId" | "toolContext"
      > = {},
    ) {
      return nextcloudTalkMessageActions.handleAction?.({
        channel: "nextcloud-talk",
        action: "react",
        params,
        cfg,
        ...context,
      });
    }

    beforeEach(() => {
      hoisted.resolveNextcloudTalkAccount.mockReturnValue(configuredAccount);
    });

    it.each([
      ["disabled account", disabledAccount, reaction, /is disabled or not configured/],
      ["unconfigured account", unconfiguredAccount, reaction, /is disabled or not configured/],
      [
        "missing id",
        configuredAccount,
        { to: reaction.to, emoji: reaction.emoji },
        /messageId required/,
      ],
      ["removal", configuredAccount, { ...reaction, remove: true }, /removal is not supported/],
    ] as const)("rejects %s before reaching the sender", async (_name, account, params, error) => {
      hoisted.resolveNextcloudTalkAccount.mockReturnValue(account);
      await expect(react(params, { accountId: "work" })).rejects.toThrow(error);
      expect(hoisted.sendReactionNextcloudTalk).not.toHaveBeenCalled();
    });

    it("uses toolContext.currentMessageId when params.messageId is missing", async () => {
      await react(
        { to: "room:abc123", emoji: "✅", remove: false },
        { accountId: null, toolContext: { currentMessageId: 99 } },
      );

      expect(hoisted.sendReactionNextcloudTalk).toHaveBeenCalledWith("room:abc123", "99", "✅", {
        accountId: undefined,
        cfg,
      });
    });

    it.each([
      ["send", /handled by outbound/],
      ["delete", /Action delete not supported for nextcloud-talk/],
    ] as const)("rejects %s through the action handler", async (action, error) => {
      await expect(
        nextcloudTalkMessageActions.handleAction?.({
          channel: "nextcloud-talk",
          action,
          params: { to: "room:abc123", text: "hi" },
          cfg,
        }),
      ).rejects.toThrow(error);
    });
  });
});
