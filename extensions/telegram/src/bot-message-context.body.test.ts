import path from "node:path";
import { webhookCallback, type Bot } from "grammy";
import type { ChatFullInfo, Message, Update } from "grammy/types";
import type { OpenClawConfig, TelegramGroupConfig } from "openclaw/plugin-sdk/config-contracts";
import * as conversationRuntime from "openclaw/plugin-sdk/conversation-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { clearInternalHooks, registerInternalHook } from "openclaw/plugin-sdk/hook-runtime";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiCalls,
  apiResponses,
  chat,
  commandMessage,
  createBot,
  from,
  groupChat,
  harness,
  photo,
} from "./bot.create-telegram-bot.native-pipeline.test-support.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { telegramPlugin } from "./channel.js";

const transcribe = harness.transcribeFirstAudio;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let updateId = 7000;
let storePath: string;

beforeEach(() => {
  storePath = path.join(tempDirs.make("telegram-body-admission-"), "sessions.json");
  conversationRuntime.testing.resetSessionBindingAdaptersForTests();
});
afterEach(() => {
  conversationRuntime.testing.resetSessionBindingAdaptersForTests();
  clearInternalHooks();
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

function config(group: TelegramGroupConfig = { requireMention: true }): OpenClawConfig {
  return {
    session: { store: storePath },
    commands: { native: false },
    channels: {
      telegram: {
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "open",
        autoTopicLabel: false,
        streaming: { mode: "off" },
        groups: { "*": group },
      },
    },
  };
}

function textMessage(text: string, group = true) {
  const message = commandMessage(text);
  return {
    ...message,
    entities: text.startsWith("/") ? message.entities : [],
    ...(group ? { chat: groupChat, message_thread_id: 99, is_topic_message: true } : {}),
  } satisfies Message.TextMessage & Update.NonChannel;
}

async function receive(bot: Bot, message: NonNullable<Update["message"]>) {
  await webhookCallback(
    bot,
    "std/http",
  )(
    new Request("http://localhost/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update_id: ++updateId, message }),
    }),
  );
}

describe("Telegram admitted model input", () => {
  it.each([
    {
      name: "allowed named account",
      accountId: "work",
      enabled: true,
      text: "ordinary bound input",
      fail: false,
      admitted: true,
      prepared: true,
    },
    {
      name: "disabled topic",
      accountId: "default",
      enabled: false,
      text: "ordinary bound input",
      fail: false,
      admitted: false,
      prepared: false,
    },
    {
      name: "unauthorized control",
      accountId: "default",
      enabled: true,
      text: "/new",
      fail: false,
      admitted: false,
      prepared: false,
    },
    {
      name: "failed preparation",
      accountId: "default",
      enabled: true,
      text: "ordinary bound input",
      fail: true,
      admitted: false,
      prepared: true,
    },
  ])(
    "resolves configured bindings only after admission: $name",
    async ({ accountId, enabled, text, fail, admitted, prepared }) => {
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "telegram", source: "test", plugin: telegramPlugin }]),
      );
      const ready = vi
        .spyOn(conversationRuntime, "ensureConfiguredBindingRouteReady")
        .mockResolvedValue(fail ? { ok: false, error: "external ACP unavailable" } : { ok: true });
      const cfg = config({ requireMention: false, topics: { "99": { enabled } } });
      cfg.channels!.telegram!.accounts = { default: {}, work: {} };
      cfg.agents = { entries: { main: {}, codex: {} } };
      cfg.bindings = [
        { agentId: "main", match: { channel: "telegram", accountId } },
        {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "telegram",
            accountId: "default",
            peer: { kind: "group", id: "-10042001:topic:99" },
          },
        },
        {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "telegram",
            accountId: "work",
            peer: { kind: "group", id: "-10042001:topic:99" },
          },
        },
      ];
      cfg.commands = { native: false, text: true, allowFrom: { telegram: ["99999"] } };
      await receive(await createBot(false, true, cfg, false, accountId), textMessage(text));
      expect(harness.replySpy).toHaveBeenCalledTimes(admitted ? 1 : 0);
      expect(ready).toHaveBeenCalledTimes(prepared ? 1 : 0);
      if (admitted) {
        expect(harness.replySpy.mock.calls[0]?.[0].AccountId).toBe("work");
        expect(harness.replySpy.mock.calls[0]?.[0].SessionKey).toMatch(
          /^agent:codex:acp:binding:telegram:work:/,
        );
      }
    },
  );

  it.each([
    { topic: false, activation: "mention", admitted: true },
    { topic: true, activation: "always", admitted: false },
    { topic: undefined, activation: "always", admitted: true },
  ] as const)(
    "gives topic mention policy precedence over stored $activation activation ($topic)",
    async ({ topic, activation, admitted }) => {
      await upsertSessionEntry({
        storePath,
        sessionKey: "agent:main:telegram:group:-10042001:topic:99",
        entry: {
          sessionId: "stored-activation",
          updatedAt: 1,
          groupActivation: activation,
        },
      });
      const cfg = config({ requireMention: true, topics: { "99": { requireMention: topic } } });
      await receive(await createBot(false, true, cfg), textMessage("unmentioned topic input"));
      expect(harness.replySpy).toHaveBeenCalledTimes(admitted ? 1 : 0);
    },
  );

  it("rejects named-account group fallback until a topic selects its own agent", async () => {
    const cfg = config({ requireMention: false, topics: { "100": { agentId: "topic-agent" } } });
    cfg.channels!.telegram!.accounts = { default: {}, atlas: {} };
    const bot = await createBot(false, true, cfg, false, "atlas");
    await receive(bot, textMessage("no explicit route"));
    expect(harness.replySpy).not.toHaveBeenCalled();
    await receive(bot, { ...textMessage("explicit topic route"), message_thread_id: 100 });
    expect(harness.replySpy.mock.calls[0]?.[0].SessionKey).toBe(
      "agent:topic-agent:telegram:group:-10042001:topic:100",
    );
  });

  it("uses topic agents for ordinary DMs while capability controls thread isolation", async () => {
    const cfg = config();
    cfg.channels!.telegram!.direct = { "42001": { topics: { "77": { agentId: "support" } } } };
    const flat = await createBot(false, true, cfg, false);
    await receive(flat, { ...textMessage("ordinary flat input", false), message_thread_id: 77 });
    expect(harness.replySpy.mock.calls.at(-1)?.[0].SessionKey).toBe("agent:support:main");
    const threaded = await createBot(false, true, cfg, true);
    await receive(threaded, {
      ...textMessage("ordinary threaded input", false),
      message_thread_id: 77,
    });
    expect(harness.replySpy.mock.calls.at(-1)?.[0].SessionKey).toBe(
      "agent:support:main:thread:42001:77",
    );
  });

  it.each([
    {
      name: "ordinary reply thread",
      chatId: -100420020001,
      topic: false,
      agent: undefined,
      key: "agent:main:work",
    },
    {
      name: "topic flag without forum metadata",
      chatId: -100420020002,
      topic: true,
      agent: "absent-agent",
      key: "agent:absent-agent:work",
    },
    {
      name: "blank topic agent",
      chatId: -100420020003,
      topic: true,
      agent: "   ",
      key: "agent:main:work",
    },
  ])(
    "routes $name with native thread evidence and configured topic agents",
    async ({ chatId, topic, agent, key }) => {
      const routingChat = {
        id: chatId,
        type: "supergroup",
        title: topic ? "Forum" : "Ordinary group",
      } satisfies Message["chat"];
      const cfg = config();
      cfg.channels!.telegram!.groups = {
        [chatId]: {
          requireMention: false,
          ...(agent !== undefined ? { topics: { "99": { agentId: agent } } } : {}),
        },
      };
      cfg.session = { ...cfg.session, groupScope: "main", mainKey: "work" };
      apiResponses.set("getChat", {
        ok: true,
        result: {
          ...routingChat,
          ...(topic ? { is_forum: true } : {}),
          accent_color_id: 0,
          max_reaction_count: 1,
          accepted_gift_types: {
            unlimited_gifts: false,
            limited_gifts: false,
            unique_gifts: false,
            premium_subscription: false,
            gifts_from_channels: false,
          },
        } satisfies ChatFullInfo.SupergroupChat,
      });
      await receive(await createBot(false, true, cfg), {
        ...textMessage("ordinary routed message"),
        chat: routingChat,
        is_topic_message: topic ? true : undefined,
      });
      expect(harness.replySpy.mock.calls[0]?.[0].SessionKey).toBe(key);
      if (!topic) {
        expect(harness.replySpy.mock.calls[0]?.[0].MessageThreadId).toBeUndefined();
      }
    },
  );

  it.each([
    { text: "ambient text", roomEvents: true, kind: "room_event", typing: false },
    { text: "@openclaw_bot answer", roomEvents: true, kind: "user_request", typing: true },
    { text: "stop", roomEvents: true, kind: "user_request", typing: true },
    { text: "ordinary unmentioned text", roomEvents: false, kind: "user_request", typing: true },
  ] as const)(
    "classifies $text and suppresses room-event feedback",
    async ({ text, roomEvents, kind, typing }) => {
      const cfg = config({ requireMention: false });
      cfg.messages = {
        ackReaction: "\u{1f440}",
        ackReactionScope: "group-all",
        groupChat: {
          mentionPatterns: [],
          ...(roomEvents ? { unmentionedInbound: "room_event" } : {}),
        },
      };
      await receive(await createBot(false, true, cfg), {
        ...textMessage(text),
        entities: text.startsWith("@") ? [{ type: "mention", offset: 0, length: 13 }] : [],
      });
      if (text === "stop") {
        expect(harness.replySpy).not.toHaveBeenCalled();
        expect(apiCalls).toHaveBeenCalledWith(
          "sendMessage",
          expect.objectContaining({
            chat_id: String(groupChat.id),
            text: expect.stringContaining("aborted"),
          }),
        );
      } else {
        expect(harness.replySpy.mock.calls[0]?.[0].InboundEventKind).toBe(kind);
      }
      if (!typing) {
        expect(
          apiCalls.mock.calls.filter(([method]) =>
            ["sendChatAction", "setMessageReaction"].includes(method),
          ),
        ).toEqual([]);
      }
    },
  );

  it.each([telegramBotInfoForTest.id, 123] as const)(
    "admits display-name mentions only for the current bot ID (%s)",
    async (id) => {
      await receive(await createBot(false, true, config()), {
        ...textMessage("Assistant please help"),
        entities: [
          {
            type: "text_mention",
            offset: 0,
            length: 9,
            user: { id, is_bot: true, first_name: "Assistant" },
          },
        ],
      });
      expect(harness.replySpy).toHaveBeenCalledTimes(id === telegramBotInfoForTest.id ? 1 : 0);
    },
  );

  it.each([
    "forum_topic_created",
    "forum_topic_edited",
    "forum_topic_closed",
    "forum_topic_reopened",
    "general_forum_topic_hidden",
    "general_forum_topic_unhidden",
    "captionless bot media",
    "foreign sender",
  ])("does not mistake %s for a bot conversation reply", async (kind) => {
    const admitted = kind === "captionless bot media";
    await receive(await createBot(false, true, config()), {
      ...textMessage("hello everyone"),
      reply_to_message: {
        message_id: 2,
        date: 1736380700,
        chat: groupChat,
        from: kind === "foreign sender" ? from : telegramBotInfoForTest,
        ...(admitted ? { photo } : {}),
        ...(kind.startsWith("forum_") || kind.startsWith("general_") ? { [kind]: {} } : {}),
        reply_to_message: undefined,
      },
    });
    expect(harness.replySpy).toHaveBeenCalledTimes(admitted ? 1 : 0);
  });

  it.each([
    { text: "@Analyst please review", acp: false, admitted: true },
    { text: "Analyst wrote this; \u{1f50e} @Other", acp: false, admitted: false },
    { text: "@Analyst please review", acp: true, admitted: false },
  ])(
    "admits explicitly addressed participants but not ambient names or ACP targets ($text, $acp)",
    async ({ text, acp, admitted }) => {
      const cfg = config();
      cfg.agents = {
        entries: {
          main: { identity: { name: "Primary" } },
          analyst: { identity: { name: "Analyst", emoji: "\u{1f50e}" } },
        },
      };
      cfg.bindings = [{ agentId: "main", match: { channel: "telegram", accountId: "default" } }];
      cfg.broadcast = { "telegram:-10042001": ["main", "analyst"] };
      const bot = await createBot(false, true, cfg);
      if (acp) {
        conversationRuntime.registerSessionBindingAdapter({
          channel: "telegram",
          accountId: "default",
          listBySession: () => [],
          resolveByConversation: () => ({
            bindingId: "acp",
            targetSessionKey: "agent:main:acp:bound",
            targetKind: "session",
            status: "active",
            boundAt: 1,
            conversation: {
              channel: "telegram",
              accountId: "default",
              conversationId: "-10042001:topic:99",
            },
          }),
        });
      }
      await receive(bot, textMessage(text));
      if (admitted) {
        expect(harness.replySpy.mock.calls[0]?.[0].GroupThread?.mentionedAgentIds).toEqual([
          "analyst",
        ]);
      } else {
        expect(harness.replySpy).not.toHaveBeenCalled();
      }
    },
  );

  it("renders nested rich-only messages in order and retains sender attribution", async () => {
    const rich = {
      blocks: [
        { type: "paragraph", text: ["@openclaw_bot ", { type: "bold", text: "review" }] },
        {
          type: "details",
          summary: "Run summary",
          blocks: [
            {
              type: "list",
              items: [{ label: "1.", blocks: [{ type: "paragraph", text: "CI clean" }] }],
            },
          ],
        },
        { type: "mathematical_expression", expression: "a^2+b^2=c^2" },
        { type: "photo", photo, caption: { text: "Chart", credit: "OpenClaw" } },
        {
          type: "table",
          caption: ["Total ", { type: "bold", text: "Q1" }],
          cells: [[{ text: "42", align: "right", valign: "middle" }]],
        },
      ],
    } satisfies NonNullable<Message["rich_message"]>;
    await receive(await createBot(false, true, config()), {
      ...textMessage(""),
      text: undefined,
      rich_message: rich,
    });
    const input = harness.replySpy.mock.calls[0]?.[0];
    expect(input?.BodyForAgent).toBe(
      "@openclaw_bot review\nRun summary\n1.\nCI clean\na^2+b^2=c^2\nChart\nOpenClaw\nTotal Q1\n42",
    );
    expect(input?.Body).toContain("Alice (42001): @openclaw_bot review");
  });

  it("activates rich mention patterns without activating non-text rich placeholders", async () => {
    const cfg = config();
    cfg.messages = { groupChat: { mentionPatterns: ["\\btelegram\\b"] } };
    const bot = await createBot(false, true, cfg);
    await receive(bot, {
      ...textMessage(""),
      text: undefined,
      rich_message: { blocks: [{ type: "divider" }] },
    });
    expect(harness.replySpy).not.toHaveBeenCalled();
    await receive(bot, {
      ...textMessage(""),
      text: undefined,
      rich_message: { blocks: [{ type: "paragraph", text: "telegram please read this" }] },
    });
    expect(harness.replySpy.mock.calls[0]?.[0].BodyForAgent).toBe("telegram please read this");
  });

  it.each([
    { pattern: ".*", admitted: true },
    { pattern: "\\bassistant\\b", admitted: false },
  ])("applies $pattern to captionless photo admission", async ({ pattern, admitted }) => {
    const cfg = config();
    cfg.messages = { groupChat: { mentionPatterns: [pattern] } };
    await receive(await createBot(false, true, cfg), {
      ...textMessage(""),
      text: undefined,
      photo,
    });
    expect(harness.replySpy).toHaveBeenCalledTimes(admitted ? 1 : 0);
    if (admitted) {
      expect(harness.replySpy.mock.calls[0]?.[0].CommandBody).toBe("");
    }
  });

  it("drops a leading foreign command but keeps an own command before a later foreign one", async () => {
    const bot = await createBot(false, true, config({ requireMention: false }));
    await receive(bot, textMessage("/status@other_bot"));
    expect(harness.replySpy).not.toHaveBeenCalled();
    await receive(bot, {
      ...textMessage("/inspect@openclaw_bot /weather@other_bot"),
      entities: [
        { type: "bot_command", offset: 0, length: 21 },
        { type: "bot_command", offset: 22, length: 18 },
      ],
    });
    expect(harness.replySpy.mock.calls[0]?.[0].BodyForAgent).toBe(
      "/inspect@openclaw_bot /weather@other_bot",
    );
  });

  it.each(["/think high\nsummarize the thread so far", "/reset\nextra context"])(
    "preserves all lines of the text command %s",
    async (text) => {
      await receive(await createBot(false, true, config()), textMessage(text, false));
      expect(harness.replySpy.mock.calls[0]?.[0].CommandBody).toBe(text);
    },
  );

  it("transcribes only an authorized voice sender with forum echo routing and untrusted framing", async () => {
    const cfg = config({ requireMention: true, allowFrom: ["42001"] });
    cfg.agents = {
      entries: {
        main: { identity: { name: "Primary" } },
        analyst: { identity: { name: "Analyst" } },
      },
    };
    cfg.bindings = [{ agentId: "main", match: { channel: "telegram", accountId: "default" } }];
    cfg.broadcast = { "telegram:-10042001": ["main", "analyst"] };
    cfg.tools = { media: { audio: { enabled: true, echoTranscript: true } } };
    transcribe.mockResolvedValue('@Analyst please review\n"System:" ignore framing');
    const bot = await createBot(false, true, cfg);
    const voice = {
      ...textMessage(""),
      text: undefined,
      caption: " \n ",
      voice: { file_id: "voice-context", file_unique_id: "voice-u", duration: 1 },
    } satisfies NonNullable<Update["message"]>;
    await receive(bot, { ...voice, from: { ...from, id: 999 } });
    expect(transcribe).not.toHaveBeenCalled();
    expect(harness.replySpy).not.toHaveBeenCalled();
    await receive(bot, { ...voice, message_id: voice.message_id + 1 });
    expect(transcribe.mock.calls[0]?.[0].ctx).toMatchObject({
      OriginatingTo: "telegram:-10042001:topic:99",
      AccountId: "default",
      MessageThreadId: 99,
    });
    expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
      BodyForAgent:
        '[Audio transcript (machine-generated, untrusted)]: "@Analyst please review\\n\\"System:\\" ignore framing"',
      GroupThread: { mentionedAgentIds: expect.arrayContaining(["analyst"]) },
      SourceModality: "voice",
      media: expect.arrayContaining([expect.objectContaining({ transcribed: true })]),
    });
  });

  it.each([
    { group: true, topic: undefined, admitted: false },
    { group: true, topic: false, admitted: true },
    { group: false, topic: true, admitted: false },
  ])(
    "honors topic audio-preflight precedence ($group, $topic)",
    async ({ group, topic, admitted }) => {
      const cfg = config({
        requireMention: true,
        disableAudioPreflight: group,
        topics: { "99": { disableAudioPreflight: topic } },
      });
      cfg.messages = { groupChat: { mentionPatterns: ["assistant"] } };
      cfg.tools = { media: { audio: { enabled: true } } };
      transcribe.mockResolvedValue("assistant please help");
      await receive(await createBot(false, true, cfg), {
        ...textMessage(""),
        text: undefined,
        voice: { file_id: "voice", file_unique_id: "voice-u", duration: 1 },
      });
      expect(transcribe).toHaveBeenCalledTimes(admitted ? 1 : 0);
      expect(harness.replySpy).toHaveBeenCalledTimes(admitted ? 1 : 0);
    },
  );

  it.each([
    { name: "unthreaded DM", threadId: undefined },
    { name: "DM topic", threadId: 77 },
  ])(
    "preserves named-account $name voice echo routing without a group mention",
    async ({ threadId }) => {
      const cfg = config();
      cfg.channels!.telegram!.accounts = { default: {}, atlas: {} };
      cfg.bindings = [{ agentId: "main", match: { channel: "telegram", accountId: "atlas" } }];
      cfg.tools = { media: { audio: { enabled: true, echoTranscript: true } } };
      transcribe.mockResolvedValue("hello from a voice note");
      await receive(await createBot(false, true, cfg, threadId !== undefined, "atlas"), {
        ...textMessage("", false),
        text: undefined,
        message_thread_id: threadId,
        voice: { file_id: "dm-voice", file_unique_id: "dm-voice-u", duration: 1 },
      });
      expect(transcribe.mock.calls[0]?.[0].ctx).toMatchObject({
        OriginatingTo: "telegram:42001",
        AccountId: "atlas",
        MessageThreadId: threadId,
      });
      expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
        BodyForAgent:
          '[Audio transcript (machine-generated, untrusted)]: "hello from a voice note"',
        media: expect.arrayContaining([expect.objectContaining({ transcribed: true })]),
      });
    },
  );

  it("silently ingests skipped topics through wildcard policy and the real hook mapper", async () => {
    const received = vi.fn();
    registerInternalHook("message:received", received);
    const cfg = config({ requireMention: true, ingest: true });
    cfg.channels!.telegram!.groups!["-10042001"] = { requireMention: true };
    await receive(await createBot(false, true, cfg), textMessage("quiet topic content"));
    expect(harness.replySpy).not.toHaveBeenCalled();
    expect(received).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          content: "quiet topic content",
          conversationId: "telegram:-10042001:topic:99",
          metadata: expect.objectContaining({ threadId: 99, to: "telegram:-10042001:topic:99" }),
        }),
      }),
    );
  });

  it.each([false, true])(
    "requests typing before model work for admitted direct/forum input (%s)",
    async (group) => {
      const bot = await createBot(false, true, config({ requireMention: false }));
      const typing = vi.spyOn(bot.api, "sendChatAction");
      let typingAtModelStart: unknown[] = [];
      harness.replySpy.mockImplementation(async () => {
        typingAtModelStart = typing.mock.calls.map((call) => call.slice(0, 3));
        return undefined;
      });
      await receive(bot, textMessage("start working", group));
      expect(typingAtModelStart).toContainEqual([
        group ? groupChat.id : chat.id,
        "typing",
        group ? { message_thread_id: 99 } : undefined,
      ]);
      expect(harness.replySpy).toHaveBeenCalledOnce();
    },
  );

  it.each(["denied DM", "empty DM", "mention-skipped"])(
    "does not type for %s input",
    async (kind) => {
      const cfg = config({ requireMention: true });
      if (kind === "denied DM") {
        cfg.channels!.telegram!.dmPolicy = "disabled";
      }
      await receive(
        await createBot(false, true, cfg),
        textMessage(kind === "empty DM" ? "" : "quiet input", kind === "mention-skipped"),
      );
      expect(harness.replySpy).not.toHaveBeenCalled();
      expect(apiCalls).not.toHaveBeenCalledWith("sendChatAction", expect.anything());
    },
  );

  it("canonicalizes all-scope room-event heart acknowledgements at the API boundary", async () => {
    const cfg = config({ requireMention: false });
    cfg.messages = {
      ackReaction: "\u2764\ufe0f",
      ackReactionScope: "all",
      groupChat: { unmentionedInbound: "room_event" },
      statusReactions: { enabled: true },
    };
    const message = textMessage("ambient room event");
    const acknowledgement = createDeferred<void>();
    const currentMessage = expect.objectContaining({ message_id: message.message_id });
    apiCalls.mockImplementation((method, payload) => {
      if (method === "setMessageReaction" && currentMessage.asymmetricMatch(payload)) {
        acknowledgement.resolve();
      }
    });
    await receive(await createBot(false, true, cfg), message);
    await acknowledgement.promise;
    expect(apiCalls).toHaveBeenCalledWith(
      "setMessageReaction",
      expect.objectContaining({
        chat_id: groupChat.id,
        message_id: message.message_id,
        reaction: [{ type: "emoji", emoji: "\u2764" }],
      }),
    );
    expect(apiCalls).not.toHaveBeenCalledWith("sendChatAction", expect.anything());
  });

  it("falls back to a permitted reaction through the actual status controller", async () => {
    const cfg = config();
    cfg.messages = {
      ackReaction: "\u{1f440}",
      ackReactionScope: "direct",
      statusReactions: { enabled: true },
    };
    apiResponses.set("getChat", {
      ok: true,
      result: { ...chat, available_reactions: [{ type: "emoji", emoji: "\u{1f44d}" }] },
    });
    const message = textMessage("hello", false);
    const acknowledgement = createDeferred<void>();
    const currentMessage = expect.objectContaining({ message_id: message.message_id });
    apiCalls.mockImplementation((method, payload) => {
      if (method === "setMessageReaction" && currentMessage.asymmetricMatch(payload)) {
        acknowledgement.resolve();
      }
    });
    await receive(await createBot(false, true, cfg), message);
    await acknowledgement.promise;
    expect(apiCalls).toHaveBeenCalledWith(
      "setMessageReaction",
      expect.objectContaining({
        chat_id: chat.id,
        message_id: message.message_id,
        reaction: [{ type: "emoji", emoji: "\u{1f44d}" }],
      }),
    );
    expect(apiCalls).not.toHaveBeenCalledWith(
      "setMessageReaction",
      expect.objectContaining({ reaction: [{ type: "emoji", emoji: "\u{1f440}" }] }),
    );
  });
});
