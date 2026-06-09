// Qqbot tests cover group-allways command plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueuedMessage } from "../../gateway/message-queue.js";
import type { GatewayAccount } from "../../gateway/types.js";
import { sendText } from "../../messaging/sender.js";
import { trySlashCommand } from "../slash-command-handler.js";
import { installCommandRuntime } from "../slash-command-test-support.js";

vi.mock("../../messaging/outbound.js", () => ({
  sendDocument: vi.fn(async () => undefined),
}));

vi.mock("../../messaging/sender.js", () => ({
  accountToCreds: vi.fn(() => ({ appId: "app", clientSecret: "" })),
  buildDeliveryTarget: vi.fn(() => ({ targetType: "c2c", targetId: "TRUSTED_OPENID" })),
  sendText: vi.fn(async () => undefined),
}));

function createGroupAllwaysMessage(arg = ""): QueuedMessage {
  return {
    type: "c2c",
    senderId: "TRUSTED_OPENID",
    content: `/bot-group-allways ${arg}`.trim(),
    messageId: "msg-1",
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function createDefaultAccount(overrides?: Record<string, unknown>): GatewayAccount {
  return {
    accountId: "default",
    appId: "app",
    clientSecret: "",
    markdownSupport: true,
    config: {
      allowFrom: ["*"],
      defaultRequireMention: true,
      ...overrides,
    },
  };
}

function createNamedAccount(
  accountId = "bot-a",
  overrides?: Record<string, unknown>,
): GatewayAccount {
  return {
    accountId,
    appId: "app",
    clientSecret: "",
    markdownSupport: true,
    config: {
      allowFrom: ["*"],
      ...overrides,
    },
  };
}

type WrittenQQBotConfigWithAllways = {
  defaultRequireMention?: unknown;
  accounts?: Record<string, { defaultRequireMention?: unknown }>;
};

function getAllwaysConfig(
  write: OpenClawConfig | undefined,
): WrittenQQBotConfigWithAllways | undefined {
  return write?.channels?.qqbot as WrittenQQBotConfigWithAllways | undefined;
}

describe("bot-group-allways command", () => {
  beforeEach(() => {
    vi.mocked(sendText).mockClear();
  });

  describe("no args — show current status", () => {
    it("shows requireMention=true (off) when defaultRequireMention is true", async () => {
      const writes: OpenClawConfig[] = [];
      const config: OpenClawConfig = {
        commands: {
          allowFrom: { qqbot: ["TRUSTED_OPENID"] },
        },
        channels: {
          qqbot: {
            allowFrom: ["*"],
            defaultRequireMention: true,
          },
        },
      };
      installCommandRuntime(config, writes);

      const result = await trySlashCommand(createGroupAllwaysMessage(), {
        account: createDefaultAccount(),
        cfg: config,
        getMessagePeerId: () => "c2c:TRUSTED_OPENID",
        getQueueSnapshot: () => ({
          totalPending: 0,
          activeUsers: 0,
          maxConcurrentUsers: 1,
          senderPending: 0,
        }),
      });

      expect(result).toBe("handled");
      expect(writes).toHaveLength(0);
      expect(vi.mocked(sendText).mock.calls.at(0)?.[1]).toContain("仅被 @ 时回复");
    });

    it("shows requireMention=false (on) when defaultRequireMention is false", async () => {
      const writes: OpenClawConfig[] = [];
      const config: OpenClawConfig = {
        commands: {
          allowFrom: { qqbot: ["TRUSTED_OPENID"] },
        },
        channels: {
          qqbot: {
            allowFrom: ["*"],
            defaultRequireMention: false,
          },
        },
      };
      installCommandRuntime(config, writes);

      const result = await trySlashCommand(createGroupAllwaysMessage(), {
        account: createDefaultAccount({ defaultRequireMention: false }),
        cfg: config,
        getMessagePeerId: () => "c2c:TRUSTED_OPENID",
        getQueueSnapshot: () => ({
          totalPending: 0,
          activeUsers: 0,
          maxConcurrentUsers: 1,
          senderPending: 0,
        }),
      });

      expect(result).toBe("handled");
      expect(vi.mocked(sendText).mock.calls.at(0)?.[1]).toContain("自主判断何时发言");
    });
  });

  describe("toggle on/off", () => {
    it("writes defaultRequireMention=false (on) for default account", async () => {
      const writes: OpenClawConfig[] = [];
      const config: OpenClawConfig = {
        commands: {
          allowFrom: { qqbot: ["TRUSTED_OPENID"] },
        },
        channels: {
          qqbot: {
            allowFrom: ["*"],
            defaultRequireMention: true,
          },
        },
      };
      installCommandRuntime(config, writes);

      const result = await trySlashCommand(createGroupAllwaysMessage("on"), {
        account: createDefaultAccount(),
        cfg: config,
        getMessagePeerId: () => "c2c:TRUSTED_OPENID",
        getQueueSnapshot: () => ({
          totalPending: 0,
          activeUsers: 0,
          maxConcurrentUsers: 1,
          senderPending: 0,
        }),
      });

      expect(result).toBe("handled");
      expect(writes).toHaveLength(1);
      const qqbot = getAllwaysConfig(writes[0]);
      expect(qqbot?.defaultRequireMention).toBe(false);
      expect(vi.mocked(sendText).mock.calls.at(0)?.[1]).toContain("**on**");
    });

    it("writes defaultRequireMention=true (off) for default account", async () => {
      const writes: OpenClawConfig[] = [];
      const config: OpenClawConfig = {
        commands: {
          allowFrom: { qqbot: ["TRUSTED_OPENID"] },
        },
        channels: {
          qqbot: {
            allowFrom: ["*"],
            defaultRequireMention: false,
          },
        },
      };
      installCommandRuntime(config, writes);

      const result = await trySlashCommand(createGroupAllwaysMessage("off"), {
        account: createDefaultAccount({ defaultRequireMention: false }),
        cfg: config,
        getMessagePeerId: () => "c2c:TRUSTED_OPENID",
        getQueueSnapshot: () => ({
          totalPending: 0,
          activeUsers: 0,
          maxConcurrentUsers: 1,
          senderPending: 0,
        }),
      });

      expect(result).toBe("handled");
      expect(writes).toHaveLength(1);
      const qqbot = getAllwaysConfig(writes[0]);
      expect(qqbot?.defaultRequireMention).toBe(true);
      expect(vi.mocked(sendText).mock.calls.at(0)?.[1]).toContain("**off**");
    });

    it("writes to accounts.{accountId}.defaultRequireMention for named accounts", async () => {
      const writes: OpenClawConfig[] = [];
      const config: OpenClawConfig = {
        commands: {
          allowFrom: { qqbot: ["TRUSTED_OPENID"] },
        },
        channels: {
          qqbot: {
            allowFrom: ["*"],
            accounts: {
              "bot-a": {},
            },
          },
        },
      };
      installCommandRuntime(config, writes);

      const result = await trySlashCommand(createGroupAllwaysMessage("on"), {
        account: createNamedAccount("bot-a"),
        cfg: config,
        getMessagePeerId: () => "c2c:TRUSTED_OPENID",
        getQueueSnapshot: () => ({
          totalPending: 0,
          activeUsers: 0,
          maxConcurrentUsers: 1,
          senderPending: 0,
        }),
      });

      expect(result).toBe("handled");
      expect(writes).toHaveLength(1);
      const qqbot = getAllwaysConfig(writes[0]);
      expect(qqbot?.accounts?.["bot-a"]?.defaultRequireMention).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("returns no-op when toggling to same state", async () => {
      const writes: OpenClawConfig[] = [];
      const config: OpenClawConfig = {
        commands: {
          allowFrom: { qqbot: ["TRUSTED_OPENID"] },
        },
        channels: {
          qqbot: {
            allowFrom: ["*"],
            defaultRequireMention: true,
          },
        },
      };
      installCommandRuntime(config, writes);

      // current is true (requireMention), try off → same state
      const result = await trySlashCommand(createGroupAllwaysMessage("off"), {
        account: createDefaultAccount(),
        cfg: config,
        getMessagePeerId: () => "c2c:TRUSTED_OPENID",
        getQueueSnapshot: () => ({
          totalPending: 0,
          activeUsers: 0,
          maxConcurrentUsers: 1,
          senderPending: 0,
        }),
      });

      expect(result).toBe("handled");
      expect(writes).toHaveLength(0);
      expect(vi.mocked(sendText).mock.calls.at(0)?.[1]).toContain("无需操作");
    });

    it("returns error for invalid argument", async () => {
      const writes: OpenClawConfig[] = [];
      const config: OpenClawConfig = {
        commands: {
          allowFrom: { qqbot: ["TRUSTED_OPENID"] },
        },
        channels: {
          qqbot: {
            allowFrom: ["*"],
          },
        },
      };
      installCommandRuntime(config, writes);

      const result = await trySlashCommand(createGroupAllwaysMessage("invalid"), {
        account: createDefaultAccount(),
        cfg: config,
        getMessagePeerId: () => "c2c:TRUSTED_OPENID",
        getQueueSnapshot: () => ({
          totalPending: 0,
          activeUsers: 0,
          maxConcurrentUsers: 1,
          senderPending: 0,
        }),
      });

      expect(result).toBe("handled");
      expect(writes).toHaveLength(0);
      expect(vi.mocked(sendText).mock.calls.at(0)?.[1]).toContain("参数错误");
    });
  });
});
