import { webhookCallback } from "grammy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import * as configMutation from "openclaw/plugin-sdk/config-mutation";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { addChannelAllowFromStoreEntry } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import * as replyRuntime from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { getSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { peekSystemEventEntries } from "openclaw/plugin-sdk/system-event-runtime";
import { createRequireRecord, resetSystemEventsForTest } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { runWithTelegramSpooledReplayUpdate } from "./bot-processing-outcome.js";
import {
  createBot,
  admitSpooledUpdate,
  commandMessage,
  harness,
  chat,
  from,
  photo,
  apiCalls,
  groupChat,
  groupCommand,
  publishTelegramTestConfig,
} from "./bot.create-telegram-bot.native-pipeline.test-support.js";
import { startTelegramCallbackQueryAnswer } from "./callback-query-answer-state.js";
import { getTelegramRuntime, setTelegramRuntime } from "./runtime.js";
import { getCachedSticker } from "./sticker-cache.js";

const { loginExecutor } = vi.hoisted(() => ({ loginExecutor: vi.fn(async () => false) }));
vi.mock("./bot-native-command-login.js", () => ({ executeTelegramLoginCommand: loginExecutor }));
vi.mock("openclaw/plugin-sdk/agent-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-runtime")>()),
  loadPreparedModelCatalog: vi.fn(async () => []),
}));
const requireRecord = createRequireRecord("record", "expected-label-object");

describe("createTelegramBot typed command pipeline", () => {
  it.each(["caption", "native"] as const)(
    "preserves the %s command body and context",
    async (kind) => {
      const raw = kind === "caption" ? "/status" : "/export_session session-notes.html";
      const bot = await createBot();
      const { text, entities, ...message } = commandMessage(raw);
      await bot.handleUpdate({
        update_id: 1002,
        message:
          kind === "caption"
            ? { ...message, caption: text, caption_entities: entities, photo }
            : { ...message, text, entities },
      });
      expect(harness.replySpy).toHaveBeenCalledTimes(1);
      expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject(
        kind === "caption"
          ? {
              CommandSource: "text",
              CommandBody: "/status",
              media: expect.arrayContaining([
                expect.objectContaining({ path: "/tmp/replied-photo.jpg" }),
              ]),
            }
          : {
              CommandSource: "native",
              CommandBody: "/export-session session-notes.html",
              RawBody: raw,
              CommandTurn: { kind: "native", body: "/export-session session-notes.html" },
            },
      );
    },
  );

  it("runs the login executor without dispatching a turn", async () => {
    const bot = await createBot();
    await bot.handleUpdate({ update_id: 1004, message: commandMessage("/login") });
    expect(loginExecutor).toHaveBeenCalledWith(expect.objectContaining({ commandText: "/login" }));
    expect(harness.replySpy).not.toHaveBeenCalled();
  });

  it.each(["forum", "DM"] as const)("routes native commands to the %s topic", async (kind) => {
    const dm = kind === "DM";
    harness.replySpy.mockResolvedValue({ text: "response" });
    if (dm) {
      await addChannelAllowFromStoreEntry({
        channel: "telegram",
        entry: from.id,
        accountId: "default",
      });
    }
    const bot = await createBot(
      true,
      true,
      {
        commands: { native: true },
        channels: {
          telegram: dm
            ? { dmPolicy: "pairing", autoTopicLabel: false, streaming: { mode: "off" } }
            : {
                dmPolicy: "open",
                allowFrom: ["*"],
                replyToMode: "first",
                streaming: { mode: "off" },
                groups: { "*": { requireMention: false } },
              },
        },
      },
      dm,
    );
    await bot.handleUpdate({
      update_id: 1007,
      message: dm ? { ...commandMessage("/status"), message_thread_id: 99 } : groupCommand(),
    });
    if (dm) {
      expect(harness.replySpy).toHaveBeenCalledTimes(1);
      expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
        SessionKey: `agent:main:main:thread:${chat.id}:99`,
        CommandAuthorized: true,
      });
      expect(apiCalls).not.toHaveBeenCalledWith(
        "sendMessage",
        expect.objectContaining({ text: "You are not authorized to use this command." }),
      );
    } else {
      const replies = apiCalls.mock.calls.filter(([method]) => method === "sendMessage");
      expect(replies).toHaveLength(1);
      expect(replies[0]?.[1]).toMatchObject({
        chat_id: String(groupChat.id),
        text: "response",
        message_thread_id: 99,
      });
      expect(replies[0]?.[1]).not.toHaveProperty("reply_parameters");
    }
  });

  const admissionCases: Array<{
    name: string;
    direct?: boolean;
    commands?: OpenClawConfig["commands"];
    telegram?: NonNullable<OpenClawConfig["channels"]>["telegram"];
    command?: string;
    outcome: "turn" | "pairing" | "silent" | "menu" | "no-menu";
    noPairing?: boolean;
  }> = [
    {
      name: "owner admits unpaired DM",
      direct: true,
      commands: { ownerAllowFrom: [`telegram:${from.id}`] },
      outcome: "turn",
      noPairing: true,
    },
    {
      name: "command allowlist admits outside group allowlist",
      commands: { allowFrom: { telegram: [String(from.id)] } },
      outcome: "turn",
    },
    {
      name: "unlisted DM receives pairing challenge",
      direct: true,
      commands: { allowFrom: { telegram: ["99999"] } },
      outcome: "pairing",
    },
    { name: "unlisted group sender is silently dropped", outcome: "silent" },
    {
      name: "command authorization cannot reopen disabled topic",
      commands: { allowFrom: { telegram: [String(from.id)] } },
      telegram: {
        groups: {
          [String(groupChat.id)]: { requireMention: false, topics: { "99": { enabled: false } } },
        },
      },
      outcome: "silent",
    },
    ...(
      [
        ["group", "command allowlist", false, "/think"],
        ["topic", "command allowlist", true, "/think"],
        ["topic", "owner", false, "/status"],
        ["direct", "command allowlist", false, "/status"],
      ] as const
    ).map(([scope, grant, included, command]) => {
      const allowFrom = [included ? String(from.id) : "99999"];
      const scopedConfig = scope === "topic" ? { topics: { "99": { allowFrom } } } : { allowFrom };
      return {
        name: `${scope} sender scope for ${grant}: included=${included}`,
        direct: scope === "direct",
        commands:
          grant === "owner"
            ? { ownerAllowFrom: [`telegram:${from.id}`] }
            : { allowFrom: { telegram: [String(from.id)] } },
        telegram:
          scope === "direct"
            ? { direct: { [String(chat.id)]: scopedConfig } }
            : { groups: { [String(groupChat.id)]: { requireMention: false, ...scopedConfig } } },
        command,
        outcome: included ? ("menu" as const) : ("no-menu" as const),
      };
    }),
    {
      name: "explicit command allowlist restricts the owner",
      commands: { ownerAllowFrom: [`telegram:${from.id}`], allowFrom: { telegram: ["99999"] } },
      outcome: "silent",
    },
  ];
  it.each(admissionCases)(
    "$name",
    async ({ direct, commands, telegram, command = "/status", outcome, noPairing }) => {
      const bot = await createBot(true, true, {
        commands: { native: true, ...commands },
        channels: {
          telegram: {
            ...(direct
              ? { dmPolicy: "pairing" as const }
              : {
                  groupPolicy: "allowlist" as const,
                  groupAllowFrom: ["99999"],
                  groups: { "*": { requireMention: false } },
                }),
            streaming: { mode: "off" },
            ...telegram,
          },
        },
      });
      await bot.handleUpdate({
        update_id: 1010,
        message: direct ? commandMessage(command) : groupCommand(command),
      });
      const pairing = [
        "sendMessage",
        expect.objectContaining({ text: expect.stringContaining("Pairing code:") }),
      ];
      if (outcome === "turn") {
        expect(harness.replySpy).toHaveBeenCalledTimes(1);
        expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({ CommandAuthorized: true });
        if (noPairing) {
          expect(apiCalls.mock.calls).not.toContainEqual(pairing);
        }
      } else {
        expect(harness.replySpy).not.toHaveBeenCalled();
        if (outcome === "pairing") {
          expect(apiCalls.mock.calls).toContainEqual(pairing);
        } else if (outcome === "silent") {
          expect(apiCalls.mock.calls.filter(([method]) => method === "sendMessage")).toEqual([]);
        } else {
          const menu = [
            "sendMessage",
            expect.objectContaining({
              reply_markup: expect.objectContaining({ inline_keyboard: expect.any(Array) }),
            }),
          ];
          if (outcome === "menu") {
            expect(apiCalls.mock.calls).toContainEqual(menu);
          } else {
            expect(apiCalls.mock.calls).not.toContainEqual(menu);
          }
        }
      }
    },
  );

  it.each(["private", "supergroup", "senderless"] as const)(
    "enforces sender identity for ordinary %s messages",
    async (kind) => {
      const senderless = kind === "senderless";
      const bot = await createBot(
        false,
        true,
        senderless
          ? {
              channels: { telegram: { dmPolicy: "allowlist", allowFrom: ["42001"] } },
            }
          : {
              accessGroups: {
                operators: { type: "message.senders", members: { telegram: ["42001"] } },
              },
              channels: {
                telegram: {
                  dmPolicy: "allowlist",
                  allowFrom: ["accessGroup:operators"],
                  groupPolicy: "allowlist",
                  groupAllowFrom: ["accessGroup:operators"],
                  groups: { "*": { requireMention: false } },
                  streaming: { mode: "off" },
                },
              },
            },
      );
      const message = {
        message_id: 201,
        date: 1736380800,
        chat: kind === "supergroup" ? groupChat : senderless ? chat : { ...chat, id: 77777 },
        text: senderless ? "senderless request" : "ordinary request",
        ...(kind === "supergroup" ? { message_thread_id: 99, is_topic_message: true } : {}),
      };
      apiCalls.mockClear();
      await bot.handleUpdate({
        update_id: 2001,
        message: { ...message, from: { ...from, id: 99999 } },
      });
      expect(harness.replySpy).not.toHaveBeenCalled();
      expect(apiCalls).not.toHaveBeenCalled();
      if (senderless) {
        await expect(
          admitSpooledUpdate(bot, { update_id: 2002, message: { ...message, message_id: 202 } }),
        ).resolves.toMatchObject({ kind: "durable" });
      } else {
        await bot.handleUpdate({ update_id: 2002, message: { ...message, message_id: 202, from } });
      }
      expect(harness.replySpy.mock.calls.map(([ctx]) => [ctx.SessionKey, ctx.RawBody])).toEqual([
        [
          kind === "supergroup"
            ? "agent:main:telegram:group:-10042001:topic:99"
            : "agent:main:main",
          message.text,
        ],
      ]);
    },
  );

  it("inherits named-account group access and composes exact-topic overrides on wildcard scope", async () => {
    const nonForumChat = {
      id: -10042002,
      type: "supergroup",
      title: "Non-forum group",
    } as const;
    const bot = await createBot(
      false,
      true,
      {
        agents: { entries: { main: {}, "topic-agent": {} } },
        bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "work" } }],
        accessGroups: {
          operators: { type: "message.senders", members: { telegram: ["42001"] } },
        },
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            groupAllowFrom: ["99999"],
            groups: {
              [String(nonForumChat.id)]: {
                allowFrom: ["accessGroup:operators"],
                requireMention: false,
              },
              [String(groupChat.id)]: {
                allowFrom: ["accessGroup:operators"],
                requireMention: false,
                skills: ["group-skill"],
                systemPrompt: "Group prompt",
                topics: {
                  "*": { allowFrom: ["42002"], agentId: "topic-agent" },
                  "77": { allowFrom: [] },
                  "99": { agentId: "main", skills: [], systemPrompt: "Topic prompt" },
                },
              },
            },
            accounts: { work: { botToken: "123:test-token" } },
            streaming: { mode: "off" },
          },
        },
      },
      false,
      "work",
    );
    const message = {
      message_id: 210,
      date: 1736380800,
      chat: nonForumChat,
      from: { ...from, id: 99999 },
      text: "group request",
    };
    apiCalls.mockClear();
    await bot.handleUpdate({ update_id: 2010, message });
    await bot.handleUpdate({
      update_id: 2011,
      message: {
        ...message,
        message_id: 211,
        chat: groupChat,
        from: { ...from, id: 42002 },
        message_thread_id: 77,
        is_topic_message: true,
      },
    });
    expect(harness.replySpy).not.toHaveBeenCalled();
    expect(
      apiCalls.mock.calls.filter(
        ([method]) => !["getChat", "setMyCommands", "deleteMyCommands"].includes(method),
      ),
    ).toEqual([]);
    await bot.handleUpdate({
      update_id: 2012,
      message: { ...message, message_id: 212, from },
    });
    for (const threadId of [88, 99]) {
      await bot.handleUpdate({
        update_id: 2013 + threadId,
        message: {
          ...message,
          message_id: 213 + threadId,
          chat: groupChat,
          from: { ...from, id: 42002 },
          message_thread_id: threadId,
          is_topic_message: true,
        },
      });
    }
    expect(harness.replySpy.mock.calls.map(([ctx]) => [ctx.SessionKey, ctx.RawBody])).toEqual([
      ["agent:main:telegram:group:-10042002", "group request"],
      ["agent:topic-agent:telegram:group:-10042001:topic:88", "group request"],
      ["agent:main:telegram:group:-10042001:topic:99", "group request"],
    ]);
    expect(harness.replySpy.mock.calls.at(-1)?.[0].GroupSystemPrompt).toBe(
      "Group prompt\n\nTopic prompt",
    );
    expect(harness.replySpy.mock.calls.at(-1)?.[1]?.skillFilter).toEqual([]);
  });

  it("dispatches registered reaction updates to the routed event queue", async () => {
    resetSystemEventsForTest();
    const bot = await createBot(false, true, {
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"], reactionNotifications: "all" } },
    });
    try {
      await bot.handleUpdate({
        update_id: 2200,
        message_reaction: {
          chat,
          message_id: 42,
          user: from,
          date: 1736380800,
          old_reaction: [],
          new_reaction: [{ type: "emoji", emoji: "\u{1F44D}" }],
        },
      });
      expect(peekSystemEventEntries("agent:main:main")).toEqual([
        expect.objectContaining({
          text: "Telegram reaction added: \u{1F44D} by Alice on msg 42",
          contextKey: "telegram:reaction:add:42001:42:42001:\u{1F44D}",
        }),
      ]);
      expect(harness.replySpy).not.toHaveBeenCalled();
    } finally {
      resetSystemEventsForTest();
    }
  });

  it("handles the overlapping migration filter once without starting an ordinary turn", async () => {
    const config: OpenClawConfig = {
      channels: {
        telegram: {
          groups: { "-1001": { requireMention: false, systemPrompt: "Keep this room" } },
        },
      },
    };
    const persist = vi.spyOn(configMutation, "mutateConfigFile").mockResolvedValue({} as never);
    try {
      const bot = await createBot(false, true, config);
      await bot.handleUpdate({
        update_id: 2300,
        message: {
          message_id: 1,
          date: 1736380800,
          chat: { id: -1001, type: "group", title: "Old group" },
          migrate_to_chat_id: -1002,
          from,
        },
      });
      expect(config.channels?.telegram?.groups).toEqual({
        "-1002": { requireMention: false, systemPrompt: "Keep this room" },
      });
      expect(persist).toHaveBeenCalledOnce();
      expect(harness.replySpy).not.toHaveBeenCalled();
    } finally {
      persist.mockRestore();
    }
  });

  it("re-answers a durable callback after a new bot loses the prior admission state", async () => {
    const callbackId = "restart-replayed-callback";
    const previousBot = await createBot();
    await startTelegramCallbackQueryAnswer(previousBot, callbackId, true);
    await previousBot.stop();
    const restarted = await createBot(false, true, {
      channels: { telegram: { dmPolicy: "disabled" } },
    });
    const pending = createDeferred<true>();
    const answerStarted = createDeferred<void>();
    const answer = vi.spyOn(restarted.api, "answerCallbackQuery").mockImplementation(() => {
      answerStarted.resolve();
      return pending.promise;
    });
    const update = {
      update_id: 2400,
      callback_query: {
        id: callbackId,
        chat_instance: "restart-chat",
        from,
        data: "cmd:option_a",
        message: { message_id: 42, date: 1736380800, chat },
      },
    };
    const replay = runWithTelegramSpooledReplayUpdate(update, () => restarted.handleUpdate(update));
    await answerStarted.promise;
    const duplicate = startTelegramCallbackQueryAnswer(restarted, callbackId, false);
    try {
      expect(
        apiCalls.mock.calls.filter(([method]) => method === "answerCallbackQuery"),
      ).toHaveLength(1);
      expect(answer).toHaveBeenCalledOnce();
      expect(answer).toHaveBeenCalledWith(callbackId);
    } finally {
      pending.resolve(true);
      await Promise.all([replay, duplicate]);
      answer.mockRestore();
    }
  });

  it("reloads native command routing bindings without recreating the registered bot", async () => {
    const config: OpenClawConfig = {
      commands: { native: true },
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
      agents: { entries: { "agent-a": {}, "agent-b": {} } },
      bindings: [{ agentId: "agent-a", match: { channel: "telegram", accountId: "default" } }],
    };
    const bot = await createBot(true, true, config);
    await bot.handleUpdate({ update_id: 2500, message: commandMessage("/status") });
    publishTelegramTestConfig({
      ...config,
      bindings: [{ agentId: "agent-b", match: { channel: "telegram", accountId: "default" } }],
    });
    await bot.handleUpdate({ update_id: 2501, message: commandMessage("/status") });
    expect(harness.replySpy.mock.calls.map(([ctx]) => ctx.SessionKey)).toEqual([
      "agent:agent-a:main",
      "agent:agent-b:main",
    ]);
  });

  it.each([
    {
      provider: "openai",
      model: "gpt-5",
      runtime: "codex",
      receipt: "Compatible auth profile retained.",
    },
    {
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-3-5-sonnet-20240620-v1:0",
      runtime: "openclaw",
      receipt: "Incompatible auth profile cleared.",
    },
  ])(
    "resets a registered $provider default callback and reports compatibility without credentials",
    async ({ provider, model, runtime, receipt }) => {
      const storePath = harness.telegramBotDepsForTest.resolveStorePath(undefined, {
        agentId: "main",
      });
      const config: OpenClawConfig = {
        agents: { defaults: { model: `${provider}/${model}` } },
        auth: { profiles: { "team:prod": { provider: "openai", mode: "api_key" } } },
        session: { store: storePath },
        channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
      };
      await upsertSessionEntry({
        storePath,
        sessionKey: "agent:main:main",
        entry: {
          sessionId: "registered-default",
          updatedAt: 1,
          providerOverride: "openai",
          modelOverride: "gpt-4o",
          authProfileOverride: "team:prod",
          authProfileOverrideSource: "user",
          agentRuntimeOverride: "codex",
        },
      });
      vi.mocked(harness.telegramBotDepsForTest.buildModelsProviderData).mockResolvedValue({
        byProvider: new Map([[provider, new Set([model])]]),
        providers: [provider],
        resolvedDefault: { provider, model },
        modelNames: new Map(),
        modelCatalog: [{ provider, id: model, name: model, reasoning: false }],
      });
      const bot = await createBot(false, true, config);
      await bot.handleUpdate({
        update_id: 2600,
        callback_query: {
          id: "default-model-callback",
          chat_instance: "model-chat",
          from,
          data: provider === "amazon-bedrock" ? `mdl_sel/${model}` : `mdl_sel_${provider}/${model}`,
          message: { message_id: 300, date: 1736380800, chat },
        },
      });
      const entry = getSessionEntry({ storePath, sessionKey: "agent:main:main" });
      expect(entry?.sessionId).toBe("registered-default");
      expect(entry?.modelOverride).toBeUndefined();
      expect(entry?.providerOverride).toBeUndefined();
      const edits = apiCalls.mock.calls.filter(([method]) => method === "editMessageText");
      expect(edits).toHaveLength(1);
      const text = String(requireRecord(edits[0]?.[1], "model receipt").text);
      expect(text).toContain("Model reset to default");
      expect(text).toContain(receipt);
      expect(text).toContain(`Runtime set to <b>${runtime}</b>`);
      expect(text).not.toContain("team:prod");
      expect(harness.replySpy).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "labels an enabled first DM topic but not an established session with bounded Unicode input (enabled=%s)",
    async (enabled) => {
      const bounded = "a".repeat(499);
      const generated = vi
        .spyOn(replyRuntime, "generateConversationLabel")
        .mockResolvedValue("Invoice review");
      const renamed = createDeferred<void>();
      apiCalls.mockImplementation((method) => {
        if (method === "editForumTopic") {
          renamed.resolve();
        }
      });
      const cfg: OpenClawConfig = {
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
            autoTopicLabel: true,
            direct: { [String(chat.id)]: { autoTopicLabel: enabled } },
            streaming: { mode: "off" },
          },
        },
      };
      try {
        const bot = await createBot(false, true, cfg, true);
        await bot.handleUpdate({
          update_id: 2700,
          message: {
            ...commandMessage(`${bounded}\u{1F600}tail`),
            entities: [],
            message_thread_id: 99,
            is_topic_message: true,
          },
        });
        if (enabled) {
          await renamed.promise;
          expect(generated.mock.calls[0]?.[0].userMessage).toBe(bounded);
          expect(apiCalls.mock.calls.filter(([method]) => method === "editForumTopic")).toEqual([
            [
              "editForumTopic",
              expect.objectContaining({
                chat_id: chat.id,
                message_thread_id: 99,
                name: "Invoice review",
              }),
            ],
          ]);
        } else {
          expect(generated).not.toHaveBeenCalled();
          expect(apiCalls.mock.calls.filter(([method]) => method === "editForumTopic")).toEqual([]);
        }
        const sessionKey = harness.replySpy.mock.calls[0]?.[0].SessionKey;
        if (!sessionKey) {
          throw new Error("Expected the first topic turn to reach the model");
        }
        // The controlled model substitutes for the engine that persists first-turn completion.
        await upsertSessionEntry({
          storePath: harness.telegramBotDepsForTest.resolveStorePath(undefined, {
            agentId: "main",
          }),
          sessionKey,
          entry: { sessionId: "delivered-dm-topic", updatedAt: Date.now(), systemSent: true },
        });
        await bot.handleUpdate({
          update_id: 2701,
          message: {
            ...commandMessage("Continue the same topic"),
            entities: [],
            message_thread_id: 99,
            is_topic_message: true,
          },
        });
        expect(generated).toHaveBeenCalledTimes(enabled ? 1 : 0);
        expect(apiCalls.mock.calls.filter(([method]) => method === "sendMessage")).toHaveLength(2);
      } finally {
        generated.mockRestore();
      }
    },
  );

  it("commits a first sticker description before model admission and never describes a supplemental image as that sticker", async () => {
    const describeStarted = createDeferred<void>();
    const description = createDeferred<{ text: string }>();
    const lateDescription = createDeferred<{ text: string }>();
    const lateStickerId = "sticker-after-webhook-expiry";
    const runtime = getTelegramRuntime();
    const describeImage = vi.fn(async () => {
      describeStarted.resolve();
      return description.promise;
    });
    setTelegramRuntime({
      ...runtime,
      mediaUnderstanding: {
        ...runtime.mediaUnderstanding,
        describeImageFileWithModel: describeImage,
      },
    });
    const cfg: OpenClawConfig = {
      // A synthetic provider keeps this controlled model out of runtime plugin activation.
      plugins: { allow: ["telegram"] },
      agents: {
        defaults: {
          model: "sticker-fixture/text-model",
          imageModel: "sticker-fixture/sticker-model",
        },
      },
      models: {
        providers: {
          "sticker-fixture": {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:9/v1",
            apiKey: "synthetic-sticker-key",
            models: [
              {
                id: "sticker-model",
                name: "Sticker model",
                input: ["text", "image"],
                reasoning: false,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8192,
                maxTokens: 1024,
              },
            ],
          },
        },
      },
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"], streaming: { mode: "off" } } },
    };
    const sticker = {
      file_id: "first-sticker-file",
      file_unique_id: "stable-sticker-description",
      type: "regular" as const,
      width: 512,
      height: 512,
      is_animated: false,
      is_video: false,
    };
    const message = {
      message_id: 2800,
      date: 1736380800,
      from,
      chat,
      sticker,
      reply_to_message: {
        message_id: 2799,
        date: 1736380799,
        from,
        chat,
        text: "Keep this quoted context",
        reply_to_message: undefined,
      },
    };
    const cachedAtAdmission: Array<Awaited<ReturnType<typeof getCachedSticker>>> = [];
    harness.replySpy.mockImplementation(async () => {
      cachedAtAdmission.push(await getCachedSticker(sticker.file_unique_id));
      return { text: "Sticker received" };
    });
    try {
      const bot = await createBot(false, true, cfg);
      // Durable ingress dispatches accepted updates outside the HTTP request deadline.
      const receiving = bot.handleUpdate({ update_id: 2800, message });
      await Promise.race([
        describeStarted.promise,
        receiving.then(() => {
          throw new Error("Sticker handler completed before description started");
        }),
      ]);
      expect(harness.replySpy).not.toHaveBeenCalled();
      description.resolve({ text: "A curious sticker" });
      await receiving;
      await bot.handleUpdate({
        update_id: 2801,
        message: {
          ...message,
          message_id: 2801,
          sticker: { ...sticker, file_id: "refreshed-sticker-file" },
        },
      });
      expect(cachedAtAdmission).toMatchObject([
        { description: "A curious sticker" },
        { description: "A curious sticker" },
      ]);
      for (const [context] of harness.replySpy.mock.calls) {
        expect(context.BodyForAgent?.match(/A curious sticker/g)).toHaveLength(1);
        expect(context.ReplyToBody).toBe("Keep this quoted context");
        expect(context.RawBody).not.toContain("A curious sticker");
        expect(context.CommandBody).not.toContain("A curious sticker");
        expect(context.SkipStickerMediaUnderstanding).toBe(true);
      }
      expect(await getCachedSticker(sticker.file_unique_id)).toMatchObject({
        fileId: "refreshed-sticker-file",
        description: "A curious sticker",
      });
      await bot.handleUpdate({
        update_id: 2802,
        message: {
          ...message,
          message_id: 2802,
          sticker: { ...sticker, file_unique_id: "unsupported-sticker", is_animated: true },
          reply_to_message: {
            message_id: 2798,
            date: 1736380798,
            from,
            chat,
            photo,
            caption: "Supplemental chart",
            reply_to_message: undefined,
          },
        },
      });
      const supplemental = harness.replySpy.mock.calls.at(-1)?.[0];
      expect(supplemental?.ReplyToBody).toBe("Supplemental chart");
      expect(supplemental?.media).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "sticker", path: undefined }),
          expect.objectContaining({ kind: "image", path: "/tmp/replied-photo.jpg" }),
        ]),
      );
      expect(describeImage).toHaveBeenCalledOnce();
      expect(apiCalls.mock.calls.filter(([method]) => method === "sendMessage")).toHaveLength(3);
      describeImage.mockImplementationOnce(() => lateDescription.promise);
      await expect(
        webhookCallback(bot, "std/http", { timeoutMilliseconds: 0 })(
          new Request("http://localhost/telegram", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              update_id: 2803,
              message: {
                ...message,
                message_id: 2803,
                sticker: { ...sticker, file_unique_id: lateStickerId },
              },
            }),
          }),
        ),
      ).rejects.toThrow("Request timed out after 0 ms");
    } finally {
      description.resolve({ text: "A curious sticker" });
      lateDescription.resolve({ text: "A sticker after webhook expiry" });
      await harness.settleUpdates();
      setTelegramRuntime(runtime);
    }
    expect(apiCalls.mock.calls.filter(([method]) => method === "sendMessage")).toHaveLength(4);
    expect(await getCachedSticker(lateStickerId)).toMatchObject({
      description: "A sticker after webhook expiry",
    });
  });
});
