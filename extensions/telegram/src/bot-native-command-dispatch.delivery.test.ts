import { PLUGIN_COMMAND_DISPATCH } from "openclaw/plugin-sdk/plugin-command-runtime";
import { matchPluginCommand, registerPluginCommand } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createEmptyPluginRegistry,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import {
  apiCalls,
  chat,
  commandMessage,
  createBot,
  from,
  harness,
  photo,
} from "./bot.create-telegram-bot.native-pipeline.test-support.js";

describe("Telegram typed command delivery", () => {
  it("replies to the selected photo quote for a native command", async () => {
    harness.replySpy.mockResolvedValue({ text: "Checked the photo.", replyToId: "30101" });
    const bot = createBot(true, true, {
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          streaming: { mode: "off" },
          replyToMode: "first",
        },
      },
    });
    await bot.handleUpdate({
      update_id: 3001,
      message: {
        ...commandMessage("/btw check this pls"),
        message_id: 30101,
        reply_to_message: {
          message_id: 100,
          date: 1736380790,
          chat,
          from,
          photo,
          caption: "Photo to check",
          reply_to_message: undefined,
        },
        quote: { text: "Photo to check", position: 0 },
      },
    });
    expect(apiCalls).toHaveBeenCalledWith(
      "sendMessage",
      expect.objectContaining({
        chat_id: String(chat.id),
        text: "Checked the photo.",
        reply_parameters: expect.objectContaining({ message_id: 100, quote: "Photo to check" }),
      }),
    );
  });

  it("sends native command errors without a notification", async () => {
    harness.replySpy.mockResolvedValue({ text: "Request failed.", isError: true });
    const bot = createBot(true, true, {
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          streaming: { mode: "off" },
          silentErrorReplies: true,
        },
      },
    });
    await bot.handleUpdate({
      update_id: 3002,
      message: { ...commandMessage("/status"), message_id: 30102 },
    });
    expect(apiCalls).toHaveBeenCalledWith(
      "sendMessage",
      expect.objectContaining({ text: "Request failed.", disable_notification: true }),
    );
  });

  it("keeps structured native approval prompts with the approval monitor", async () => {
    harness.replySpy.mockResolvedValue({
      text: "Approval required.",
      channelData: {
        execApproval: {
          approvalId: "7f423fdc-1111-2222-3333-444444444444",
          approvalSlug: "7f423fdc",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
        },
      },
    });
    const bot = createBot(true, true, {
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          streaming: { mode: "off" },
          execApprovals: { enabled: true, approvers: [String(from.id)], target: "dm" },
        },
      },
    });
    await bot.handleUpdate({
      update_id: 3003,
      message: { ...commandMessage("/status"), message_id: 30103 },
    });
    expect(harness.replySpy).toHaveBeenCalledOnce();
    expect(apiCalls.mock.calls.filter(([method]) => method === "sendMessage")).toEqual([]);
  });

  it("preserves the builtin catalog choice when a plugin registers fast", async () => {
    const previousRegistry = getActivePluginRegistry();
    setActivePluginRegistry(createEmptyPluginRegistry());
    try {
      expect(
        registerPluginCommand("fast-controls", {
          name: "fast",
          description: "Fast controls",
          acceptsArgs: true,
          handler: async () => ({ text: "Plugin fast reply" }),
        }),
      ).toEqual({ ok: true });
      expect(matchPluginCommand("/fast on", { channel: "telegram" })).toMatchObject({
        command: { name: "fast", pluginId: "fast-controls" },
        args: "on",
      });
      const bot = createBot();
      await bot.handleUpdate({ update_id: 3004, message: commandMessage("/fast on") });
      expect(harness.replySpy).toHaveBeenCalledOnce();
      expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
        CommandSource: "native",
        CommandTurn: { kind: "native", body: "/fast on" },
      });
      expect(harness.replySpy.mock.calls[0]?.[1]).toMatchObject({
        [PLUGIN_COMMAND_DISPATCH]: { kind: "non-plugin" },
      });
    } finally {
      if (previousRegistry) {
        setActivePluginRegistry(previousRegistry);
      } else {
        resetPluginRuntimeStateForTest();
      }
    }
  });
});
