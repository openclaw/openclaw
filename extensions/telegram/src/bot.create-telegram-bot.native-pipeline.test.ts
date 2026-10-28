import { webhookCallback, type Bot } from "grammy";
import type { Message, Update } from "grammy/types";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import * as configMutation from "openclaw/plugin-sdk/config-mutation";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { addChannelAllowFromStoreEntry } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import * as replyRuntime from "openclaw/plugin-sdk/reply-dispatch-runtime";
import {
  getSessionEntry,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { assert, expect, it, vi } from "vitest";
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

vi.mock("openclaw/plugin-sdk/agent-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-runtime")>()),
  loadPreparedModelCatalog: vi.fn(async () => []),
}));
const requireRecord = createRequireRecord("record", "expected-label-object");
type TelegramConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>;
const openDm = { dmPolicy: "open", allowFrom: ["*"] } satisfies TelegramConfig;
const openUnstreamed = { ...openDm, streaming: { mode: "off" } } satisfies TelegramConfig;
const apiPayloads = (method: string) =>
  apiCalls.mock.calls.flatMap(([name, payload]) => (name === method ? [payload] : []));
const configuredBot = (
  telegram: TelegramConfig,
  config: OpenClawConfig = {},
  topics = false,
  account?: string,
) => createBot(false, true, { ...config, channels: { telegram } }, topics, account);
const messageBase = { date: 1736380800, chat, from };
const handleMessage = (bot: Bot, update_id: number, message: Message & Update.NonChannel) =>
  bot.handleUpdate({ update_id, message });
const callback = (id: string, data: string, chat_instance: string, message_id: number) => ({
  id,
  data,
  chat_instance,
  from,
  message: { message_id, date: messageBase.date, chat },
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
  const bot = await configuredBot(
    dm
      ? { dmPolicy: "pairing", autoTopicLabel: false, streaming: { mode: "off" } }
      : {
          ...openUnstreamed,
          replyToMode: "first",
          groups: { "*": { requireMention: false } },
        },
    { commands: { native: true } },
    dm,
  );
  await handleMessage(
    bot,
    1007,
    dm ? { ...commandMessage("/status"), message_thread_id: 99 } : groupCommand(),
  );
  if (dm) {
    expect(harness.replySpy).toHaveBeenCalledTimes(1);
    expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
      SessionKey: `agent:main:main:thread:${chat.id}:99`,
      CommandAuthorized: true,
      CommandTurn: { kind: "native", body: "/status", authorized: true },
    });
    expect(harness.replySpy.mock.calls[0]?.[0]).not.toHaveProperty("OwnerAllowFrom");
    expect(apiCalls).not.toHaveBeenCalledWith(
      "sendMessage",
      expect.objectContaining({ text: "You are not authorized to use this command." }),
    );
  } else {
    const replies = apiPayloads("sendMessage");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      chat_id: String(groupChat.id),
      text: "response",
      message_thread_id: 99,
    });
    expect(replies[0]).not.toHaveProperty("reply_parameters");
  }
});

it.each([
  ["owner DM", "dm", "owner", "turn", "/status"],
  ["command overrides group", "group", "command", "turn", "/status"],
  ["unlisted DM", "dm", "denied", "pairing", "/status"],
  ["disabled topic", "disabled-topic", "command", "silent", "/status"],
  ["group sender scope", "scoped-group", "command", "no-menu", "/think"],
  ["included topic sender", "topic-included", "command", "menu", "/think"],
  ["excluded topic owner", "topic-excluded", "owner", "no-menu", "/status"],
  ["direct sender scope", "scoped-direct", "command", "no-menu", "/status"],
  ["restricted owner", "group", "restricted", "silent", "/status"],
] as const)("%s", async (_name, scope, grant, outcome, command) => {
  const direct = scope === "dm" || scope === "scoped-direct";
  const owner = { ownerAllowFrom: [`telegram:${from.id}`] };
  const allowFrom = [grant === "denied" || grant === "restricted" ? "99999" : String(from.id)];
  const commands =
    grant === "owner"
      ? owner
      : {
          ...(grant === "restricted" ? owner : {}),
          allowFrom: { telegram: allowFrom },
        };
  const senderScope =
    scope === "disabled-topic"
      ? { topics: { "99": { enabled: false } } }
      : scope === "topic-included" || scope === "topic-excluded"
        ? {
            topics: {
              "99": { allowFrom: [scope === "topic-included" ? String(from.id) : "99999"] },
            },
          }
        : { allowFrom: ["99999"] };
  const telegram: TelegramConfig = direct
    ? {
        dmPolicy: "pairing",
        ...(scope === "scoped-direct" ? { direct: { [String(chat.id)]: senderScope } } : {}),
      }
    : {
        groupPolicy: "allowlist",
        groupAllowFrom: ["99999"],
        groups:
          scope === "group"
            ? { "*": { requireMention: false } }
            : { [String(groupChat.id)]: { requireMention: false, ...senderScope } },
      };
  const bot = await configuredBot(
    { ...telegram, streaming: { mode: "off" } },
    { commands: { native: true, ...commands } },
  );
  await handleMessage(bot, 1010, direct ? commandMessage(command) : groupCommand(command));
  const pairing = [
    "sendMessage",
    expect.objectContaining({ text: expect.stringContaining("Pairing code:") }),
  ];
  expect(harness.replySpy).toHaveBeenCalledTimes(Number(outcome === "turn"));
  if (outcome === "turn") {
    expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({ CommandAuthorized: true });
    if (scope === "dm" && grant === "owner") {
      expect(apiCalls.mock.calls).not.toContainEqual(pairing);
    }
  } else if (outcome === "pairing") {
    expect(apiCalls.mock.calls).toContainEqual(pairing);
  } else if (outcome === "silent") {
    expect(apiPayloads("sendMessage")).toEqual([]);
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
});

it("enforces sender identity for ordinary senderless messages", async () => {
  const bot = await configuredBot({ dmPolicy: "allowlist", allowFrom: ["42001"] });
  const message = {
    message_id: 201,
    date: 1736380800,
    chat,
    text: "senderless request",
  };
  apiCalls.mockClear();
  await handleMessage(bot, 2001, { ...message, from: { ...from, id: 99999 } });
  expect(harness.replySpy).not.toHaveBeenCalled();
  expect(apiCalls).not.toHaveBeenCalled();
  await expect(
    admitSpooledUpdate(bot, { update_id: 2002, message: { ...message, message_id: 202 } }),
  ).resolves.toMatchObject({ kind: "durable" });
  expect(harness.replySpy.mock.calls.map(([ctx]) => [ctx.SessionKey, ctx.RawBody])).toEqual([
    ["agent:main:main", message.text],
  ]);
});

it("inherits named-account group access and composes exact-topic overrides on wildcard scope", async () => {
  const nonForumChat = { ...groupChat, id: -10042002, is_forum: undefined };
  const groupAccess = { allowFrom: ["accessGroup:operators"], requireMention: false };
  const bot = await configuredBot(
    {
      groupPolicy: "allowlist",
      groupAllowFrom: ["99999"],
      groups: {
        [String(nonForumChat.id)]: groupAccess,
        [String(groupChat.id)]: {
          ...groupAccess,
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
    {
      agents: { entries: { main: {}, "topic-agent": {} } },
      bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "work" } }],
      accessGroups: {
        operators: { type: "message.senders", members: { telegram: ["42001"] } },
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
  const topicRequest = (threadId: number) => ({
    ...message,
    message_id: 213 + threadId,
    chat: groupChat,
    from: { ...from, id: 42002 },
    message_thread_id: threadId,
    is_topic_message: true,
  });
  await handleMessage(bot, 2010, message);
  await handleMessage(bot, 2011, { ...topicRequest(77), message_id: 211 });
  expect(harness.replySpy).not.toHaveBeenCalled();
  expect(
    apiCalls.mock.calls.filter(
      ([method]) => !["getChat", "setMyCommands", "deleteMyCommands"].includes(method),
    ),
  ).toEqual([]);
  await handleMessage(bot, 2012, { ...message, message_id: 212, from });
  for (const threadId of [88, 99]) {
    await handleMessage(bot, 2013 + threadId, topicRequest(threadId));
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
    await handleMessage(bot, 2300, {
      message_id: 1,
      date: 1736380800,
      chat: { id: -1001, type: "group", title: "Old group" },
      migrate_to_chat_id: -1002,
      from,
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
  const restarted = await configuredBot({ dmPolicy: "disabled" });
  const pending = createDeferred<true>();
  const answerStarted = createDeferred<void>();
  const answer = vi.spyOn(restarted.api, "answerCallbackQuery").mockImplementation(() => {
    answerStarted.resolve();
    return pending.promise;
  });
  const update = {
    update_id: 2400,
    callback_query: callback(callbackId, "cmd:option_a", "restart-chat", 42),
  };
  const replay = runWithTelegramSpooledReplayUpdate(update, () => restarted.handleUpdate(update));
  await answerStarted.promise;
  const duplicate = startTelegramCallbackQueryAnswer(restarted, callbackId, false);
  try {
    expect(apiPayloads("answerCallbackQuery")).toHaveLength(1);
    expect(answer.mock.calls).toEqual([[callbackId]]);
  } finally {
    pending.resolve(true);
    await Promise.all([replay, duplicate]);
    answer.mockRestore();
  }
});

it("reloads native command routing bindings without recreating the registered bot", async () => {
  const config: OpenClawConfig = {
    commands: { native: true },
    channels: { telegram: { ...openDm } },
    agents: { entries: { "agent-a": {}, "agent-b": {} } },
    bindings: [{ agentId: "agent-a", match: { channel: "telegram", accountId: "default" } }],
  };
  const bot = await createBot(true, true, config);
  await handleMessage(bot, 2500, commandMessage("/status"));
  publishTelegramTestConfig({
    ...config,
    bindings: [{ agentId: "agent-b", match: { channel: "telegram", accountId: "default" } }],
  });
  await handleMessage(bot, 2501, commandMessage("/status"));
  expect(harness.replySpy.mock.calls.map(([ctx]) => ctx.SessionKey)).toEqual([
    "agent:agent-a:main",
    "agent:agent-b:main",
  ]);
});

it.each([
  ["openai", "gpt-5", "codex", "Compatible auth profile retained."],
  [
    "amazon-bedrock",
    "us.anthropic.claude-3-5-sonnet-20240620-v1:0",
    "openclaw",
    "Incompatible auth profile cleared.",
  ],
])(
  "resets a registered %s default callback and reports compatibility without credentials",
  async (provider, model, runtime, receipt) => {
    const storePath = resolveStorePath(undefined, { agentId: "main" });
    const config: OpenClawConfig = {
      agents: { defaults: { model: `${provider}/${model}` } },
      auth: { profiles: { "team:prod": { provider: "openai", mode: "api_key" } } },
      session: { store: storePath },
      channels: { telegram: { ...openDm } },
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
    harness.buildModelsProviderData.mockResolvedValue({
      byProvider: new Map([[provider, new Set([model])]]),
      providers: [provider],
      resolvedDefault: { provider, model },
      modelNames: new Map(),
      modelCatalog: [{ provider, id: model, name: model, reasoning: false }],
    });
    const bot = await createBot(false, true, config);
    await loadAuthProfileStoreWithoutExternalProfilesAsync(harness.state.agentDir());
    await bot.handleUpdate({
      update_id: 2600,
      callback_query: callback(
        "default-model-callback",
        provider === "amazon-bedrock" ? `mdl_sel/${model}` : `mdl_sel_${provider}/${model}`,
        "model-chat",
        300,
      ),
    });
    const entry = getSessionEntry({ storePath, sessionKey: "agent:main:main" });
    expect(entry?.sessionId).toBe("registered-default");
    expect(entry?.modelOverride).toBeUndefined();
    expect(entry?.providerOverride).toBeUndefined();
    const edits = apiPayloads("editMessageText");
    expect(edits).toHaveLength(1);
    const text = String(requireRecord(edits[0], "model receipt").text);
    expect(text).toContain("Model reset to default");
    expect(text).toContain(receipt);
    expect(text).toContain(`Runtime set to <b>${runtime}</b>`);
    expect(text).not.toContain("team:prod");
    expect(harness.replySpy).not.toHaveBeenCalled();
  },
);

it("labels an enabled first DM topic but not an established session with bounded Unicode input", async () => {
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
  const topicMessage = (text: string) => ({
    ...commandMessage(text),
    entities: [],
    message_thread_id: 99,
    is_topic_message: true,
  });
  try {
    const bot = await configuredBot(
      {
        ...openUnstreamed,
        autoTopicLabel: true,
        direct: { [String(chat.id)]: { autoTopicLabel: true } },
      },
      {},
      true,
    );
    await handleMessage(bot, 2700, topicMessage(`${bounded}\u{1F600}tail`));
    await renamed.promise;
    expect(generated.mock.calls[0]?.[0].userMessage).toBe(bounded);
    expect(apiPayloads("editForumTopic")).toEqual([
      expect.objectContaining({
        chat_id: chat.id,
        message_thread_id: 99,
        name: "Invoice review",
      }),
    ]);
    const sessionKey = harness.replySpy.mock.calls[0]?.[0].SessionKey;
    assert(sessionKey, "Expected the first topic turn to reach the model");
    // The controlled model substitutes for the engine that persists first-turn completion.
    await upsertSessionEntry({
      storePath: resolveStorePath(undefined, { agentId: "main" }),
      sessionKey,
      entry: { sessionId: "delivered-dm-topic", updatedAt: Date.now(), systemSent: true },
    });
    await handleMessage(bot, 2701, topicMessage("Continue the same topic"));
    expect(generated).toHaveBeenCalledTimes(1);
    expect(apiPayloads("sendMessage")).toHaveLength(2);
  } finally {
    generated.mockRestore();
  }
});

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
    channels: { telegram: { ...openUnstreamed } },
  };
  const sticker = {
    file_id: "first-sticker-file",
    file_unique_id: "stable-sticker-description",
    type: "regular" as const,
    width: 512,
    height: 512,
    is_animated: false,
    is_video: false,
    emoji: "old",
    set_name: "OldSet",
  };
  const message = {
    message_id: 2800,
    ...messageBase,
    sticker,
    reply_to_message: {
      message_id: 2799,
      ...messageBase,
      date: 1736380799,
      text: "Keep this quoted context",
      reply_to_message: undefined,
    },
  };
  const stickerUpdate = <T extends object>(id: number, changes: T) => ({
    update_id: id,
    message: { ...message, ...changes, message_id: id },
  });
  const cachedAtAdmission: Array<Awaited<ReturnType<typeof getCachedSticker>>> = [];
  harness.replySpy.mockImplementation(async () => {
    cachedAtAdmission.push(await getCachedSticker(sticker.file_unique_id));
    return { text: "Sticker received" };
  });
  try {
    const bot = await createBot(false, true, cfg);
    // Durable ingress dispatches accepted updates outside the HTTP request deadline.
    const receiving = handleMessage(bot, 2800, message);
    await Promise.race([
      describeStarted.promise,
      receiving.then(() => {
        throw new Error("Sticker handler completed before description started");
      }),
    ]);
    expect(harness.replySpy).not.toHaveBeenCalled();
    description.resolve({ text: "A curious sticker" });
    await receiving;
    await bot.handleUpdate(
      stickerUpdate(2801, {
        sticker: {
          ...sticker,
          file_id: "refreshed-sticker-file",
          emoji: "new",
          set_name: "NewSet",
        },
      }),
    );
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
      emoji: "new",
      setName: "NewSet",
    });
    await bot.handleUpdate(
      stickerUpdate(2802, {
        sticker: { ...sticker, file_unique_id: "unsupported-sticker", is_animated: true },
        reply_to_message: {
          message_id: 2798,
          ...messageBase,
          date: 1736380798,
          photo,
          caption: "Supplemental chart",
          reply_to_message: undefined,
        },
      }),
    );
    const supplemental = harness.replySpy.mock.calls.at(-1)?.[0];
    expect(supplemental?.ReplyToBody).toBe("Supplemental chart");
    expect(supplemental?.media).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "sticker", path: undefined }),
        expect.objectContaining({ kind: "image", path: "/tmp/replied-photo.jpg" }),
      ]),
    );
    expect(describeImage).toHaveBeenCalledOnce();
    expect(apiPayloads("sendMessage")).toHaveLength(3);
    const downloads = apiPayloads("getFile").length;
    await bot.handleUpdate(
      stickerUpdate(2803, {
        sticker: {
          ...sticker,
          file_unique_id: "unsupported-video",
          is_video: true,
          emoji: undefined,
        },
        reply_to_message: undefined,
      }),
    );
    expect(harness.replySpy.mock.calls.at(-1)?.[0]).toMatchObject({
      BodyForAgent: "<media:sticker>",
      media: [{ kind: "sticker", path: undefined }],
    });
    expect(apiPayloads("getFile")).toHaveLength(downloads);
    expect(describeImage).toHaveBeenCalledOnce();
    describeImage.mockImplementationOnce(() => lateDescription.promise);
    await expect(
      webhookCallback(bot, "std/http", { timeoutMilliseconds: 0 })(
        new Request("http://localhost/telegram", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            stickerUpdate(2804, { sticker: { ...sticker, file_unique_id: lateStickerId } }),
          ),
        }),
      ),
    ).rejects.toThrow("Request timed out after 0 ms");
  } finally {
    description.resolve({ text: "A curious sticker" });
    lateDescription.resolve({ text: "A sticker after webhook expiry" });
    await harness.settleUpdates();
    setTelegramRuntime(runtime);
  }
  expect(apiPayloads("sendMessage")).toHaveLength(5);
  expect(await getCachedSticker(lateStickerId)).toMatchObject({
    description: "A sticker after webhook expiry",
  });
});
