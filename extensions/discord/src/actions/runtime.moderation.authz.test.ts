import { PermissionFlagsBits } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";
import { handleDiscordModerationAction } from "./runtime.moderation.js";

const { banMemberDiscord, kickMemberDiscord, timeoutMemberDiscord, hasAnyGuildPermissionDiscord } =
  vi.hoisted(() => ({
    banMemberDiscord: vi.fn(async () => ({ ok: true })),
    kickMemberDiscord: vi.fn(async () => ({ ok: true })),
    timeoutMemberDiscord: vi.fn(async () => ({ id: "user-1" })),
    hasAnyGuildPermissionDiscord: vi.fn(async () => false),
  }));

vi.mock("../send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../send.js")>()),
  banMemberDiscord,
  kickMemberDiscord,
  timeoutMemberDiscord,
  hasAnyGuildPermissionDiscord,
}));

const cfg = EMPTY_DISCORD_TEST_CONFIG;
const target = { guildId: "guild-1", userId: "user-1", senderUserId: "sender-1" };
function moderate(action: string, params: Record<string, unknown> = {}) {
  return handleDiscordModerationAction(action, { ...target, ...params }, () => true, cfg);
}

describe("discord moderation sender authorization", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    { action: "ban", permission: PermissionFlagsBits.BanMembers, mutation: banMemberDiscord },
    { action: "kick", permission: PermissionFlagsBits.KickMembers, mutation: kickMemberDiscord },
    {
      action: "timeout",
      permission: PermissionFlagsBits.ModerateMembers,
      mutation: timeoutMemberDiscord,
    },
  ])(
    "rejects $action without its required permission",
    async ({ action, permission, mutation }) => {
      await expect(moderate(action, { durationMinutes: 60 })).rejects.toThrow(
        "required permissions",
      );
      expect(hasAnyGuildPermissionDiscord).toHaveBeenCalledWith(
        "guild-1",
        "sender-1",
        [permission],
        { cfg },
      );
      expect(mutation).not.toHaveBeenCalled();
    },
  );

  it("executes an authorized kick with the same account used for permission checks", async () => {
    hasAnyGuildPermissionDiscord.mockResolvedValueOnce(true);
    await moderate("kick", { accountId: "ops", reason: "rule violation" });
    expect(hasAnyGuildPermissionDiscord).toHaveBeenCalledWith(
      "guild-1",
      "sender-1",
      [PermissionFlagsBits.KickMembers],
      { cfg, accountId: "ops" },
    );
    expect(kickMemberDiscord).toHaveBeenCalledWith(
      { guildId: "guild-1", userId: "user-1", reason: "rule violation" },
      { cfg, accountId: "ops" },
    );
  });
});
