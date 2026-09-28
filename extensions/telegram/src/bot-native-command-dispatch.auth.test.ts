import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { addChannelAllowFromStoreEntry } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  commandMessage,
  createBot,
  from,
  harness,
} from "./bot.create-telegram-bot.native-pipeline.test-support.js";

vi.mock("openclaw/plugin-sdk/agent-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-runtime")>()),
  loadPreparedModelCatalog: vi.fn(async () => []),
}));

const groupChat = {
  id: -100999,
  type: "supergroup",
  title: "Test group",
  is_forum: true,
} as const;

function groupCommand(text = "/status") {
  return {
    ...commandMessage(text),
    chat: groupChat,
    message_thread_id: 42,
    is_topic_message: true,
  };
}

async function setup(
  params: {
    telegram?: TelegramAccountConfig;
    commands?: OpenClawConfig["commands"];
  } = {},
) {
  const bot = await createBot(true, true, {
    commands: { native: true, text: true, ...params.commands },
    channels: {
      telegram: {
        dmPolicy: "allowlist",
        allowFrom: [],
        groupAllowFrom: [],
        groupPolicy: "open",
        streaming: { mode: "off" },
        groups: { "*": { requireMention: false } },
        ...params.telegram,
      },
    },
  });
  return { bot, sendMessage: vi.spyOn(bot.api, "sendMessage") };
}

describe("native command auth in groups", () => {
  it("authorizes native commands in groups when sender is in groupAllowFrom", async () => {
    const { bot } = await setup({ telegram: { groupAllowFrom: [String(from.id)] } });

    await bot.handleUpdate({ update_id: 1001, message: groupCommand() });

    expect(harness.replySpy).toHaveBeenCalledTimes(1);
    expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
      CommandSource: "native",
      CommandAuthorized: true,
      CommandBody: "/status",
    });
  });

  it("does not authorize group native commands from the DM allowlist store", async () => {
    await addChannelAllowFromStoreEntry({
      channel: "telegram",
      entry: from.id,
      accountId: "default",
    });
    const { bot, sendMessage } = await setup();

    await bot.handleUpdate({ update_id: 1001, message: groupCommand() });

    expect(harness.replySpy).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("authorizes native commands in admitted groups from commands.allowFrom.telegram", async () => {
    const { bot } = await setup({
      commands: { allowFrom: { telegram: [String(from.id)] } },
      telegram: { allowFrom: ["99999"], groupAllowFrom: ["99999"] },
    });

    await bot.handleUpdate({ update_id: 1001, message: groupCommand() });

    expect(harness.replySpy).toHaveBeenCalledTimes(1);
    expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({ CommandAuthorized: true });
  });

  it("uses commands.allowFrom.telegram as the sole command auth source when configured", async () => {
    const { bot, sendMessage } = await setup({
      commands: { allowFrom: { telegram: ["99999"] } },
      telegram: { groupAllowFrom: [String(from.id)] },
    });

    await bot.handleUpdate({ update_id: 1001, message: groupCommand() });

    expect(harness.replySpy).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("silently drops account-disabled native commands", async () => {
    const { bot, sendMessage } = await setup({
      commands: { allowFrom: { telegram: [String(from.id)] } },
      telegram: { groupPolicy: "disabled" },
    });

    await bot.handleUpdate({ update_id: 1001, message: groupCommand() });

    expect(harness.replySpy).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("silently drops topic-disabled native commands before dispatch", async () => {
    const { bot, sendMessage } = await setup({
      commands: { allowFrom: { telegram: [String(from.id)] } },
      telegram: {
        groups: {
          [String(groupChat.id)]: {
            groupPolicy: "open",
            topics: { "42": { groupPolicy: "disabled" } },
          },
        },
      },
    });

    await bot.handleUpdate({ update_id: 1001, message: groupCommand() });

    expect(harness.replySpy).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("silently drops native commands that inherit disabled group policy", async () => {
    const { bot, sendMessage } = await setup({
      commands: { allowFrom: { telegram: [String(from.id)] } },
      telegram: { groups: { [String(groupChat.id)]: { groupPolicy: "disabled" } } },
    });

    await bot.handleUpdate({ update_id: 1001, message: groupCommand() });

    expect(harness.replySpy).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("silently drops native commands from groups outside the chat allowlist", async () => {
    const { bot, sendMessage } = await setup({
      commands: { allowFrom: { telegram: [String(from.id)] } },
      telegram: { groups: { "-100888": { requireMention: false } } },
    });

    await bot.handleUpdate({ update_id: 1001, message: groupCommand() });

    expect(harness.replySpy).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("silently drops native commands in groups when sender is in neither allowlist", async () => {
    const { bot, sendMessage } = await setup({
      telegram: { allowFrom: ["99999"], groupAllowFrom: ["99999"] },
    });

    await bot.handleUpdate({ update_id: 1001, message: groupCommand() });

    expect(harness.replySpy).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("replies in the originating forum topic when command menu auth is rejected", async () => {
    const { bot, sendMessage } = await setup({
      telegram: { allowFrom: ["99999"], groupAllowFrom: ["99999"] },
    });

    await bot.handleUpdate({ update_id: 1001, message: groupCommand("/think") });

    expect(harness.replySpy).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      groupChat.id,
      "You are not authorized to use this command.",
      { message_thread_id: 42 },
    );
  });
});
