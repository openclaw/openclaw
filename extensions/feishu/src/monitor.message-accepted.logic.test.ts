import { describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import type { FeishuMessageEvent } from "./bot.js";
import { buildPluginMessageAcceptedHookCall } from "./monitor.account.js";
import type { ResolvedFeishuAccount } from "./types.js";

function createConfig(): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        enabled: true,
      },
    },
  } as ClawdbotConfig;
}

function createEvent(params?: {
  messageId?: string;
  text?: string;
  chatId?: string;
  chatType?: "group" | "p2p" | "private";
  rootId?: string;
  senderOpenId?: string;
  mentions?: NonNullable<FeishuMessageEvent["message"]["mentions"]>;
}): FeishuMessageEvent {
  return {
    sender: {
      sender_id: {
        open_id: params?.senderOpenId ?? "ou_user",
      },
      sender_type: "user",
    },
    message: {
      message_id: params?.messageId ?? "om_1",
      chat_id: params?.chatId ?? "oc_group",
      chat_type: params?.chatType ?? "group",
      message_type: "text",
      content: JSON.stringify({ text: params?.text ?? "@Bot hi" }),
      ...(params?.rootId ? { root_id: params.rootId, parent_id: params.rootId } : {}),
      mentions: params?.mentions ?? [
        {
          key: "@_user_1",
          id: { open_id: "ou_bot" },
          name: "Bot",
        },
      ],
    },
  };
}

describe("buildPluginMessageAcceptedHookCall", () => {
  it("builds a hook payload for plugin-mode group messages", () => {
    const result = buildPluginMessageAcceptedHookCall({
      cfg: createConfig(),
      accountId: "default",
      event: createEvent({ messageId: "om_accept", text: "@Bot hello" }),
      botOpenId: "ou_bot",
      botName: "Bot",
      allBotOpenIds: ["ou_bot"],
      accountConfig: {
        enabled: true,
        dispatchMode: "plugin",
        connectionMode: "websocket",
      } as ResolvedFeishuAccount["config"],
      isControlCommandMessage: () => false,
      resolveBoundSession: () => undefined,
      accountBotOpenId: "ou_bot",
      botOpenIdsByAccount: { default: "ou_bot" },
    });

    expect(result).toMatchObject({
      event: {
        from: "feishu:ou_user",
        content: "@Bot hello",
        metadata: {
          messageId: "om_accept",
          to: "chat:oc_group",
          channelData: {
            messageId: "om_accept",
            accountId: "default",
            accountBotOpenId: "ou_bot",
          },
        },
      },
      ctx: {
        channelId: "feishu",
        accountId: "default",
        conversationId: "oc_group",
      },
    });
  });

  it("returns null for bound thread conversations and blocked control commands", () => {
    const commandCheck = vi.fn(() => true);
    const result = buildPluginMessageAcceptedHookCall({
      cfg: createConfig(),
      accountId: "default",
      event: createEvent({ rootId: "om_root", text: "/stop" }),
      botOpenId: "ou_bot",
      botName: "Bot",
      allBotOpenIds: ["ou_bot"],
      accountConfig: {
        enabled: true,
        dispatchMode: "plugin",
        connectionMode: "websocket",
        pluginMode: {
          forwardControlCommands: false,
        },
      } as ResolvedFeishuAccount["config"],
      isControlCommandMessage: commandCheck,
      resolveBoundSession: () => "agent:bound:session",
      accountBotOpenId: "ou_bot",
      botOpenIdsByAccount: { default: "ou_bot" },
    });

    expect(result).toBeNull();
    expect(commandCheck).not.toHaveBeenCalled();
  });

  it("returns null when plugin dispatch mode is disabled", () => {
    const result = buildPluginMessageAcceptedHookCall({
      cfg: createConfig(),
      accountId: "default",
      event: createEvent({ senderOpenId: "ou_denied" }),
      botOpenId: "ou_bot",
      botName: "Bot",
      allBotOpenIds: ["ou_bot"],
      accountConfig: {
        enabled: true,
        dispatchMode: "auto",
        connectionMode: "websocket",
        groupSenderAllowFrom: ["ou_other"],
      } as ResolvedFeishuAccount["config"],
      isControlCommandMessage: () => false,
      resolveBoundSession: () => undefined,
      accountBotOpenId: "ou_bot",
      botOpenIdsByAccount: { default: "ou_bot" },
    });

    expect(result).toBeNull();
  });
});
