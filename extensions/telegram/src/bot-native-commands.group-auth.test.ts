import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ChannelGroupPolicy } from "openclaw/plugin-sdk/config-runtime";
import type { TelegramAccountConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNativeCommandsHarness,
  createTelegramGroupCommandContext,
  findNotAuthorizedCalls,
} from "./bot-native-commands.test-helpers.js";
import { clearGroupMembershipCache } from "./group-membership-cache.js";

describe("native command auth in groups", () => {
  function setup(params: {
    cfg?: OpenClawConfig;
    telegramCfg?: TelegramAccountConfig;
    allowFrom?: string[];
    groupAllowFrom?: string[];
    useAccessGroups?: boolean;
    groupConfig?: Record<string, unknown>;
    resolveGroupPolicy?: () => ChannelGroupPolicy;
  }) {
    return createNativeCommandsHarness({
      cfg: params.cfg ?? ({} as OpenClawConfig),
      telegramCfg: params.telegramCfg ?? ({} as TelegramAccountConfig),
      allowFrom: params.allowFrom ?? [],
      groupAllowFrom: params.groupAllowFrom ?? [],
      useAccessGroups: params.useAccessGroups ?? false,
      resolveGroupPolicy:
        params.resolveGroupPolicy ??
        (() =>
          ({
            allowlistEnabled: false,
            allowed: true,
          }) as ChannelGroupPolicy),
      groupConfig: params.groupConfig,
    });
  }

  it("authorizes native commands in groups when sender is in groupAllowFrom", async () => {
    const { handlers, sendMessage } = setup({
      groupAllowFrom: ["12345"],
      useAccessGroups: true,
      // no allowFrom — sender is NOT in DM allowlist
    });

    const ctx = createTelegramGroupCommandContext();

    await handlers.status?.(ctx);

    const notAuthCalls = findNotAuthorizedCalls(sendMessage);
    expect(notAuthCalls).toHaveLength(0);
  });

  it("authorizes native commands in groups from commands.allowFrom.telegram", async () => {
    const { handlers, sendMessage } = setup({
      cfg: {
        commands: {
          allowFrom: {
            telegram: ["12345"],
          },
        },
      } as OpenClawConfig,
      allowFrom: ["99999"],
      groupAllowFrom: ["99999"],
      useAccessGroups: true,
    });

    const ctx = createTelegramGroupCommandContext();

    await handlers.status?.(ctx);

    const notAuthCalls = findNotAuthorizedCalls(sendMessage);
    expect(notAuthCalls).toHaveLength(0);
  });

  it("uses commands.allowFrom.telegram as the sole auth source when configured", async () => {
    const { handlers, sendMessage } = setup({
      cfg: {
        commands: {
          allowFrom: {
            telegram: ["99999"],
          },
        },
      } as OpenClawConfig,
      groupAllowFrom: ["12345"],
      useAccessGroups: true,
    });

    const ctx = createTelegramGroupCommandContext();

    await handlers.status?.(ctx);

    expect(sendMessage).toHaveBeenCalledWith(
      -100999,
      "You are not authorized to use this command.",
      expect.objectContaining({ message_thread_id: 42 }),
    );
  });

  it("keeps groupPolicy disabled enforced when commands.allowFrom is configured", async () => {
    const { handlers, sendMessage } = setup({
      cfg: {
        channels: {
          telegram: {
            groupPolicy: "disabled",
          },
        },
        commands: {
          allowFrom: {
            telegram: ["12345"],
          },
        },
      } as OpenClawConfig,
      useAccessGroups: true,
      resolveGroupPolicy: () =>
        ({
          allowlistEnabled: false,
          allowed: false,
        }) as ChannelGroupPolicy,
    });

    const ctx = createTelegramGroupCommandContext();

    await handlers.status?.(ctx);

    expect(sendMessage).toHaveBeenCalledWith(
      -100999,
      "Telegram group commands are disabled.",
      expect.objectContaining({ message_thread_id: 42 }),
    );
  });

  it("keeps group chat allowlists enforced when commands.allowFrom is configured", async () => {
    const { handlers, sendMessage } = setup({
      cfg: {
        commands: {
          allowFrom: {
            telegram: ["12345"],
          },
        },
      } as OpenClawConfig,
      useAccessGroups: true,
      resolveGroupPolicy: () =>
        ({
          allowlistEnabled: true,
          allowed: false,
        }) as ChannelGroupPolicy,
    });

    const ctx = createTelegramGroupCommandContext();

    await handlers.status?.(ctx);

    expect(sendMessage).toHaveBeenCalledWith(
      -100999,
      "This group is not allowed.",
      expect.objectContaining({ message_thread_id: 42 }),
    );
  });

  it("rejects native commands in groups when sender is in neither allowlist", async () => {
    const { handlers, sendMessage } = setup({
      allowFrom: ["99999"],
      groupAllowFrom: ["99999"],
      useAccessGroups: true,
    });

    const ctx = createTelegramGroupCommandContext({
      username: "intruder",
    });

    await handlers.status?.(ctx);

    const notAuthCalls = findNotAuthorizedCalls(sendMessage);
    expect(notAuthCalls.length).toBeGreaterThan(0);
  });

  it("replies in the originating forum topic when auth is rejected", async () => {
    const { handlers, sendMessage } = setup({
      allowFrom: ["99999"],
      groupAllowFrom: ["99999"],
      useAccessGroups: true,
    });

    const ctx = createTelegramGroupCommandContext({
      username: "intruder",
    });

    await handlers.status?.(ctx);

    expect(sendMessage).toHaveBeenCalledWith(
      -100999,
      "You are not authorized to use this command.",
      expect.objectContaining({ message_thread_id: 42 }),
    );
  });

  // Regression: without these gates native commands would keep executing even
  // though regular messages from the same chat are blocked by `members`, which
  // would break the security boundary the policy promises.
  describe('groupPolicy "members" native-command gating', () => {
    afterEach(() => {
      // The membership cache is module-level singleton state; reset between
      // cases so results from the untrusted-members test do not leak into the
      // trusted-members test via an identical cache key.
      clearGroupMembershipCache();
    });

    it("rejects native commands when group membership contains an untrusted user", async () => {
      const { handlers, sendMessage } = createNativeCommandsHarness({
        cfg: {
          channels: {
            telegram: { groupPolicy: "members" },
          },
        } as OpenClawConfig,
        telegramCfg: { groupPolicy: "members" } as TelegramAccountConfig,
        allowFrom: ["12345"],
        groupAllowFrom: ["12345"],
        useAccessGroups: true,
        // Telegram reports three participants but only two trusted IDs
        // (the bot + 12345) exist, so one untrusted member is present.
        getChatMemberCount: async () => 3,
      });

      const ctx = createTelegramGroupCommandContext();
      await handlers.status?.(ctx);

      expect(sendMessage).toHaveBeenCalledWith(
        -100999,
        "You are not authorized to use this command.",
        expect.objectContaining({ message_thread_id: 42 }),
      );
    });

    it("authorizes native commands when all group members are trusted", async () => {
      const { handlers, sendMessage } = createNativeCommandsHarness({
        cfg: {
          channels: {
            telegram: { groupPolicy: "members" },
          },
        } as OpenClawConfig,
        telegramCfg: { groupPolicy: "members" } as TelegramAccountConfig,
        allowFrom: ["12345"],
        groupAllowFrom: ["12345"],
        useAccessGroups: true,
        // Two members (bot + trusted sender) and both present.
        getChatMemberCount: async () => 2,
        getChatMember: async () => ({ status: "member" }),
      });

      const ctx = createTelegramGroupCommandContext();
      await handlers.status?.(ctx);

      const notAuthCalls = findNotAuthorizedCalls(sendMessage);
      expect(notAuthCalls).toHaveLength(0);
    });
  });
});
