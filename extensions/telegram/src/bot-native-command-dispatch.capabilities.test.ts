import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type * as CommandAuthNative from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type * as ConversationRuntime from "openclaw/plugin-sdk/conversation-runtime";
import { PLUGIN_COMMAND_DISPATCH } from "openclaw/plugin-sdk/plugin-command-runtime";
import { getActivePluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  registerSessionBindingAdapter,
  testing as sessionBindingTesting,
} from "openclaw/plugin-sdk/session-binding-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginTelegramNativeCommandHandoff,
  shouldRunTelegramNativeCommandAfterHandoff,
} from "./bot-native-command-handoff.js";
import {
  createTelegramSpooledReplayDeferredParticipant,
  recordTelegramMessageProcessingResult,
  runWithTelegramSpooledReplayUpdate,
  runWithTelegramUpdateProcessingFrame,
} from "./bot-processing-outcome.js";
import {
  apiCalls,
  commandMessage,
  createBot,
  from,
  groupChat,
  harness,
} from "./bot.create-telegram-bot.native-pipeline.test-support.js";

// One-shot failures the message pipeline meets before it keeps an offered command.
const failures = vi.hoisted(() => ({ store: false, auth: false }));
vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof ConversationRuntime>();
  return {
    ...actual,
    readChannelAllowFromStore: async (
      ...args: Parameters<typeof actual.readChannelAllowFromStore>
    ) => {
      if (failures.store) {
        failures.store = false;
        throw new Error("pairing store unavailable");
      }
      return await actual.readChannelAllowFromStore(...args);
    },
  };
});
vi.mock("openclaw/plugin-sdk/command-auth-native", async (importOriginal) => {
  const actual = await importOriginal<typeof CommandAuthNative>();
  return {
    ...actual,
    resolveCommandAuthorizationAsync: async (
      ...args: Parameters<typeof actual.resolveCommandAuthorizationAsync>
    ) => {
      const turn = (args[0].ctx as { CommandTurn?: { kind?: string } }).CommandTurn;
      if (failures.auth && turn?.kind === "native") {
        failures.auth = false;
        throw new Error("authorization unavailable");
      }
      return await actual.resolveCommandAuthorizationAsync(...args);
    },
  };
});

function commandConfig(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return {
    commands: { native: true },
    session: { store: join(process.env.OPENCLAW_STATE_DIR!, `${randomUUID()}.json`) },
    ...overrides,
    channels: {
      telegram: {
        botToken: "123:test-token",
        dmPolicy: "open",
        allowFrom: ["*"],
        streaming: { mode: "off" },
        ...overrides.channels?.telegram,
      },
    },
  };
}

function registerCapabilityCommand(
  access: {
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    runtimeCapabilities?: Array<"subagents" | "models">;
  } = {},
) {
  const handler = vi.fn(async () => ({ text: "native executor" }));
  getActivePluginRegistry()!.commands.push({
    pluginId: "capability-test",
    source: "test",
    command: {
      name: "plug",
      description: "Exercise capability routing",
      acceptsArgs: access.acceptsArgs ?? true,
      requireAuth: access.requireAuth ?? true,
      runtimeCapabilities: access.runtimeCapabilities ?? ["subagents"],
      handler,
    },
  });
  return handler;
}

async function sendCommand(
  cfg: OpenClawConfig,
  text: string,
  updateId: number,
  message: Record<string, unknown> = {},
  accountId?: string,
) {
  const bot = await createBot(true, true, cfg, false, accountId);
  const update = { ...commandMessage(text), ...message };
  await bot.handleUpdate({ update_id: updateId, message: update });
  return { bot, update };
}

const sentTexts = () =>
  apiCalls.mock.calls
    .filter(([method]) => method === "sendMessage")
    .map(([, payload]) => (payload as { text?: string }).text);

const commandsFor = (senderId: string) =>
  commandConfig({ commands: { native: true, allowFrom: { telegram: [senderId] } } });

describe("Telegram native plugin commands with runtime capabilities", () => {
  it.each([
    ["commands.allowFrom", () => commandsFor(String(from.id))],
    ["the DM allowlist", () => commandConfig()],
    [
      "an owner allowlist",
      () => commandConfig({ commands: { native: true, ownerAllowFrom: [`telegram:${from.id}`] } }),
    ],
  ] as const)(
    "runs the typed command of a sender authorized by %s on the reply pipeline, like its /Command",
    async (_, config) => {
      const handler = registerCapabilityCommand();
      await sendCommand(config(), "/plug now", 3301);
      expect(handler).not.toHaveBeenCalled();
      expect(harness.replySpy).toHaveBeenCalledOnce();
      const [ctx, options] = harness.replySpy.mock.calls[0] ?? [];
      expect(ctx).toMatchObject({
        CommandSource: "native",
        CommandTurn: { kind: "native", body: "/plug now" },
      });
      expect(options?.[PLUGIN_COMMAND_DISPATCH]?.kind).toBe("plugin");
    },
  );

  it("answers arguments the command does not accept on the native executor", async () => {
    const handler = registerCapabilityCommand({ acceptsArgs: false });
    await sendCommand(commandsFor(String(from.id)), "/plug now", 3302);
    expect(handler).not.toHaveBeenCalled();
    expect(harness.replySpy).not.toHaveBeenCalled();
    expect(sentTexts()).toEqual(["Command not found."]);
  });

  it.each([
    [
      "a public command from a sender commands.allowFrom does not list",
      () => commandsFor(String(from.id + 1)),
      { requireAuth: false, runtimeCapabilities: ["models" as const] },
    ],
    [
      "a non-owner sender while an owner allowlist is configured",
      () => commandConfig({ commands: { native: true, ownerAllowFrom: ["telegram:999"] } }),
      {},
    ],
    [
      "a direct message while direct messages are disabled",
      () =>
        commandConfig({
          channels: { telegram: { dmPolicy: "disabled", allowFrom: [String(from.id)] } },
        }),
      {},
    ],
  ])("keeps %s on the native executor", async (_, config, access) => {
    const handler = registerCapabilityCommand(access);
    await sendCommand(config(), "/plug now", 3303);
    expect(harness.replySpy).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
    expect(sentTexts()).toEqual(["native executor"]);
  });

  it("refuses an unpaired direct message sender natively, without a pairing reply", async () => {
    const handler = registerCapabilityCommand();
    await sendCommand(
      commandConfig({ channels: { telegram: { dmPolicy: "pairing", allowFrom: [] } } }),
      "/plug now",
      3304,
    );
    expect(harness.replySpy).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(sentTexts()).toEqual(["You are not authorized to use this command."]);
  });

  it.each([
    ["the default account keeps it in the reply pipeline", undefined, "pipeline"],
    ["an unbound non-default account keeps it on the native executor", "alt", "native"],
  ] as const)("for a group command, %s", async (_, accountId, executor) => {
    const handler = registerCapabilityCommand();
    const groupAccess = {
      dmPolicy: "open" as const,
      allowFrom: ["*"],
      groupPolicy: "open" as const,
      groups: { "*": { requireMention: false } },
    };
    const cfg = commandConfig({
      channels: {
        telegram: {
          ...groupAccess,
          accounts: { alt: { botToken: "456:alt-token", ...groupAccess } },
        },
      },
    });
    await sendCommand(
      cfg,
      "/plug now",
      3305,
      { chat: { ...groupChat, is_forum: false } },
      accountId,
    );
    expect(harness.replySpy).toHaveBeenCalledTimes(executor === "pipeline" ? 1 : 0);
    expect(handler).toHaveBeenCalledTimes(executor === "native" ? 1 : 0);
  });

  it("keeps another bot's group command, which bot-loop protection could drop, on the native executor", async () => {
    const handler = registerCapabilityCommand();
    const cfg = commandConfig({
      channels: { telegram: { groupPolicy: "open", groups: { "*": { requireMention: false } } } },
    });
    await sendCommand(cfg, "/plug now", 3312, {
      chat: { ...groupChat, is_forum: false },
      from: { id: 4242, is_bot: true, first_name: "Other bot" },
    });
    expect(harness.replySpy).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("leaves a differently cased command from a sender the pipeline does not admit as text", async () => {
    const handler = registerCapabilityCommand({
      requireAuth: false,
      runtimeCapabilities: ["models"],
    });
    await sendCommand(commandsFor(String(from.id + 1)), "/Plug now", 3306);
    expect(handler).not.toHaveBeenCalled();
    expect(harness.replySpy).toHaveBeenCalledOnce();
    const [ctx, options] = harness.replySpy.mock.calls[0] ?? [];
    expect(ctx?.CommandSource).not.toBe("native");
    expect(options?.[PLUGIN_COMMAND_DISPATCH]).toBeUndefined();
  });

  it("does not run a message the pipeline already dispatched a second time", async () => {
    const handler = registerCapabilityCommand();
    const { bot, update } = await sendCommand(commandConfig(), "/plug now", 3307);
    await bot.handleUpdate({ update_id: 3308, message: update });
    expect(harness.replySpy).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
  });

  describe("conversation shapes the reply pipeline would not run as a command", () => {
    afterEach(() => {
      sessionBindingTesting.resetSessionBindingAdaptersForTests();
    });

    it("keeps a command in a runtime-bound conversation on the native executor", async () => {
      const handler = registerCapabilityCommand();
      const binding = {
        bindingId: "capability-runtime-binding",
        targetSessionKey: "agent:main:bound-runtime",
        targetKind: "session" as const,
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: String(from.id),
        },
        status: "active" as const,
        boundAt: 1,
      };
      // The bot registers its own binding adapter; this conversation's binding replaces it.
      const bot = await createBot(true, true, commandConfig());
      registerSessionBindingAdapter({
        ...binding.conversation,
        listBySession: () => [binding],
        resolveByConversation: () => binding,
      });
      await bot.handleUpdate({ update_id: 3309, message: commandMessage("/plug now") });
      expect(harness.replySpy).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalledOnce();
      expect(sentTexts()).toEqual(["native executor"]);
    });

    it.each([
      ["the bot's message keeps it on the native executor", true, "native"],
      ["a person's message keeps it in the reply pipeline", false, "pipeline"],
    ] as const)("for a command sent as a reply to %s", async (_, isBot, executor) => {
      const handler = registerCapabilityCommand();
      const prompt = commandMessage("Which build should I check?");
      await sendCommand(commandConfig(), "/plug now", 3310, {
        reply_to_message: { ...prompt, from: { id: 999, is_bot: isBot, first_name: "Other" } },
      });
      expect(harness.replySpy).toHaveBeenCalledTimes(executor === "pipeline" ? 1 : 0);
      expect(handler).toHaveBeenCalledTimes(executor === "native" ? 1 : 0);
    });

    it("dispatches a forum topic command, whose implicit topic reply is not a reply, through the reply pipeline", async () => {
      const handler = registerCapabilityCommand();
      const forum = { ...groupChat, is_forum: true };
      const cfg = commandConfig({
        channels: {
          telegram: { groupPolicy: "open", groups: { "*": { requireMention: false } } },
        },
      });
      await sendCommand(cfg, "/plug now", 3311, {
        chat: forum,
        message_thread_id: 77,
        is_topic_message: true,
        reply_to_message: {
          message_id: 77,
          date: 1,
          chat: forum,
          // The bot created this topic, so only the service message marks it as no prompt.
          from: { id: 123, is_bot: true, first_name: "Bot" },
          forum_topic_created: { name: "Builds", icon_color: 7322096 },
        },
      });
      expect(handler).not.toHaveBeenCalled();
      expect(harness.replySpy).toHaveBeenCalledOnce();
    });
  });
});

describe("Telegram native plugin command handoff outcome", () => {
  const offer = () =>
    beginTelegramNativeCommandHandoff(
      {},
      {
        commandName: "plug",
        candidate: {} as never,
        args: "",
        chatId: 1,
        messageId: 2,
      },
    );

  it("runs the native executor only when the pipeline neither kept nor retries the update", async () => {
    await runWithTelegramUpdateProcessingFrame(async () => {
      expect(await shouldRunTelegramNativeCommandAfterHandoff(offer())).toBe(true);
      const kept = offer();
      kept.outcome = "admitted";
      expect(await shouldRunTelegramNativeCommandAfterHandoff(kept)).toBe(false);
      recordTelegramMessageProcessingResult({ kind: "failed-retryable", error: new Error("x") });
      expect(await shouldRunTelegramNativeCommandAfterHandoff(offer())).toBe(false);
    });
  });

  it("leaves a spooled update to its pending or retried replay", async () => {
    for (const settled of [undefined, "failed-retryable", "skipped"] as const) {
      await runWithTelegramSpooledReplayUpdate({}, async () => {
        const participant = createTelegramSpooledReplayDeferredParticipant("test")!;
        if (settled === "failed-retryable") {
          participant.settle({ kind: settled, error: new Error("x") });
        } else if (settled) {
          participant.settle({ kind: settled });
        }
        expect(await shouldRunTelegramNativeCommandAfterHandoff(offer())).toBe(
          settled === "skipped",
        );
      });
    }
  });
});

describe("Telegram native plugin command handoff after a pipeline failure", () => {
  beforeEach(() => {
    failures.store = false;
    failures.auth = false;
  });

  // The drain's own composition: a spooled replay frame around the update's processing frame.
  async function deliver(cfg: OpenClawConfig, updateId: number, spooled: boolean) {
    const bot = await createBot(true, true, cfg);
    const update = { update_id: updateId, message: commandMessage("/plug now") };
    if (!spooled) {
      await bot.handleUpdate(update);
      return undefined;
    }
    const { value, deferredWork } = await runWithTelegramSpooledReplayUpdate(update, () =>
      runWithTelegramUpdateProcessingFrame(async () => {
        await bot.handleUpdate(update);
      }),
    );
    return deferredWork ? await deferredWork.task : value.result;
  }

  it.each([
    ["a spooled replay", true],
    ["a live update", false],
  ] as const)(
    "runs the command natively, once and without a retry, when authorization fails in %s",
    async (_, spooled) => {
      const handler = registerCapabilityCommand();
      failures.auth = true;
      const disposition = await deliver(commandConfig(), 3401, spooled);
      expect(failures.auth).toBe(false);
      expect(harness.replySpy).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalledOnce();
      expect(sentTexts()).toEqual(["native executor"]);
      expect(disposition?.kind).not.toBe("failed-retryable");
    },
  );

  it("refuses natively, without a retry, when the pipeline cannot read the pairing store", async () => {
    const handler = registerCapabilityCommand();
    failures.store = true;
    const disposition = await deliver(
      commandConfig({ channels: { telegram: { dmPolicy: "pairing", allowFrom: [] } } }),
      3402,
      true,
    );
    expect(failures.store).toBe(false);
    expect(harness.replySpy).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(sentTexts()).toEqual(["You are not authorized to use this command."]);
    expect(disposition?.kind).not.toBe("failed-retryable");
  });
});
