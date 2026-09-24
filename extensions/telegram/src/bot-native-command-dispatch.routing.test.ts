import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BotCommand } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import { addChannelAllowFromStoreEntry } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { listSkillCommandsForAgents } from "openclaw/plugin-sdk/skill-commands-runtime";
import { writeSkill } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import {
  enqueueTelegramMenuSync,
  resolveTelegramMenuRemoteOwner,
} from "./bot-native-command-menu-state.js";
import {
  apiCalls,
  apiResponses,
  commandMessage,
  createBot,
  from,
  harness,
} from "./bot.create-telegram-bot.native-pipeline.test-support.js";
import { beginTelegramPollRegistration } from "./poll-answer-context.js";
import { recordTelegramPollRegistryEntry } from "./poll-registry.js";

const groupChat = { id: -42001, type: "supergroup", title: "Project", is_forum: true } as const;

describe("registered native command routing through the message pipeline", () => {
  it("authorizes paired DMs without marking the sender as an owner", async () => {
    await addChannelAllowFromStoreEntry({
      channel: "telegram",
      entry: from.id,
      accountId: "default",
    });
    const bot = createBot(true, true, {
      commands: { native: true },
      channels: { telegram: { dmPolicy: "pairing", allowFrom: [], streaming: { mode: "off" } } },
    });

    await bot.handleUpdate({ update_id: 1001, message: commandMessage("/status") });

    expect(harness.replySpy).toHaveBeenCalledOnce();
    const context = harness.replySpy.mock.calls[0]?.[0];
    expect(context).toMatchObject({
      CommandAuthorized: true,
      CommandTurn: { kind: "native", body: "/status", authorized: true },
    });
    expect(context).not.toHaveProperty("OwnerAllowFrom");
  });

  it.each(["/status", "/new", "/reset"])(
    "routes %s to the topic agent and chat session",
    async (text) => {
      const cfg: OpenClawConfig = {
        commands: { native: true },
        agents: { list: [{ id: "main", default: true }, { id: "topic-agent" }] },
        channels: {
          telegram: {
            groupPolicy: "open",
            groupAllowFrom: ["42001"],
            groups: {
              "-42001": { requireMention: false, topics: { "42": { agentId: "topic-agent" } } },
            },
          },
        },
      };
      const bot = createBot(true, true, cfg);
      await bot.handleUpdate({
        update_id: 1001,
        message: {
          ...commandMessage(text),
          chat: groupChat,
          message_thread_id: 42,
          is_topic_message: true,
        },
      });
      expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
        CommandSource: "native",
        SessionKey: "agent:topic-agent:telegram:group:-42001:topic:42",
        From: "telegram:group:-42001:topic:42",
        ChatType: "group",
        ConversationRoutePeerId: "-42001:topic:42",
        MessageThreadId: 42,
        OriginatingTo: "telegram:-42001:topic:42",
        ThreadParentId: "-42001",
      });
    },
  );

  it.each([
    { name: "forum topic", threadId: 42, conversationId: "-42001:topic:42" },
    { name: "top-level group", threadId: undefined, conversationId: "-42002" },
  ])(
    "routes native commands through a bound $name session",
    async ({ threadId, conversationId }) => {
      const bot = createBot(true, true, {
        commands: { native: true },
        agents: { list: [{ id: "main", default: true }, { id: "bound-agent" }] },
        channels: {
          telegram: {
            groupPolicy: "open",
            groupAllowFrom: [String(from.id)],
            groups: { "*": { requireMention: false } },
            streaming: { mode: "off" },
          },
        },
      });
      const bindingId = `binding:${conversationId}`;
      const sessionKey = `agent:bound-agent:session:${conversationId}`;
      const resolveByConversation = vi.fn<SessionBindingAdapter["resolveByConversation"]>(
        (conversation) =>
          conversation.conversationId === conversationId
            ? {
                bindingId,
                targetSessionKey: sessionKey,
                targetKind: "session",
                conversation,
                status: "active",
                boundAt: 1,
              }
            : null,
      );
      const touch = vi.fn<NonNullable<SessionBindingAdapter["touch"]>>();
      const adapter: SessionBindingAdapter = {
        channel: "telegram",
        accountId: "default",
        listBySession: () => [],
        resolveByConversation,
        touch,
      };
      registerSessionBindingAdapter(adapter);
      try {
        await bot.handleUpdate({
          update_id: 1001,
          message: {
            ...commandMessage("/status"),
            chat:
              threadId !== undefined ? groupChat : { id: -42002, type: "group", title: "Project" },
            ...(threadId !== undefined
              ? { message_thread_id: threadId, is_topic_message: true as const }
              : {}),
          },
        });

        expect(resolveByConversation).toHaveBeenCalledWith({
          channel: "telegram",
          accountId: "default",
          conversationId,
        });
        expect(touch).toHaveBeenCalledWith(bindingId, undefined);
        expect(harness.replySpy).toHaveBeenCalledOnce();
        expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
          CommandSource: "native",
          SessionKey: sessionKey,
          OriginatingTo: `telegram:${conversationId}`,
          ConversationRoutePeerId: conversationId,
        });
      } finally {
        unregisterSessionBindingAdapter({ channel: "telegram", accountId: "default", adapter });
      }
    },
  );

  it("treats an authorized native command as a mention even with unsupported arguments", async () => {
    const bot = createBot(true, true, {
      commands: { native: true },
      channels: {
        telegram: {
          groupPolicy: "open",
          groupAllowFrom: [String(from.id)],
          groups: { "*": { requireMention: true } },
        },
      },
    });
    await bot.handleUpdate({
      update_id: 1001,
      message: { ...commandMessage("/stop later"), chat: groupChat },
    });
    expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
      CommandSource: "native",
      CommandBody: "/stop later",
      WasMentioned: true,
    });
  });

  it("silently blocks unauthorized /new in an unbound forum topic", async () => {
    const bot = createBot(true, true, {
      commands: { native: true },
      channels: {
        telegram: {
          groupPolicy: "open",
          groupAllowFrom: ["99999"],
          groups: { "*": { requireMention: false } },
        },
      },
    });

    await bot.handleUpdate({
      update_id: 1001,
      message: {
        ...commandMessage("/new"),
        chat: groupChat,
        message_thread_id: 42,
        is_topic_message: true,
      },
    });

    expect(harness.replySpy).not.toHaveBeenCalled();
    expect(apiCalls.mock.calls.filter(([method]) => method === "sendMessage")).toEqual([]);
  });

  it("does not dispatch the same update twice", async () => {
    const bot = createBot();
    const update = { update_id: 1001, message: commandMessage("/status") };
    await bot.handleUpdate(update);
    await bot.handleUpdate(update);
    expect(harness.replySpy).toHaveBeenCalledTimes(1);
  });
  it("publishes account-scoped skills and keeps omitted bound skills callable", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-native-skills-"));
    try {
      for (const name of ["alpha", "beta"]) {
        await writeSkill({
          dir: path.join(workspace, "skills", `${name}-skill`),
          name: `${name}-skill`,
          description: `${name} skill`,
        });
      }
      const cfg: OpenClawConfig = {
        commands: { native: true, nativeSkills: true },
        agents: {
          entries: {
            alpha: { default: true, workspace, skills: ["alpha-skill"] },
            beta: { workspace, skills: ["beta-skill"] },
          },
        },
        bindings: [{ agentId: "beta", match: { channel: "telegram", accountId: "bot-a" } }],
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
            streaming: { mode: "off" },
            accounts: { "bot-a": {}, "bot-b": {} },
          },
        },
      };
      harness.listSkillCommandsForAgents.mockImplementation((params) => {
        const commands = listSkillCommandsForAgents(params);
        const beta = commands.find(({ skillName }) => skillName === "beta-skill");
        if (beta) {
          beta.descriptionLocalizations = { ko: "베타 스킬" };
        }
        return commands;
      });
      const publishMenu = async (config: OpenClawConfig, accountId: string) => {
        apiCalls.mockClear();
        const bot = createBot(true, true, config, false, accountId);
        await new Promise<void>((resolve, reject) => {
          enqueueTelegramMenuSync({
            ownerKey: resolveTelegramMenuRemoteOwner({ botId: bot.botInfo.id }).queueKey,
            sync: async () => resolve(),
            onError: reject,
          });
        });
        const menus = apiCalls.mock.calls
          .filter(([method]) => method === "setMyCommands")
          .map(([, payload]) => payload as { commands: BotCommand[]; language_code?: string });
        return {
          bot,
          menus,
          commands:
            menus.find((menu) => !menu.language_code)?.commands.map(({ command }) => command) ?? [],
        };
      };
      const bound = await publishMenu(cfg, "bot-a");
      expect(bound.commands).toContain("beta_skill");
      expect(bound.commands).not.toContain("alpha_skill");
      expect(bound.menus).toContainEqual(
        expect.objectContaining({
          language_code: "ko",
          commands: expect.arrayContaining([{ command: "beta_skill", description: "베타 스킬" }]),
        }),
      );
      const fallback = await publishMenu(cfg, "bot-b");
      expect(fallback.commands).toContain("alpha_skill");
      expect(fallback.commands).not.toContain("beta_skill");
      const pressure = await publishMenu(
        {
          ...cfg,
          channels: {
            telegram: {
              ...cfg.channels?.telegram,
              customCommands: Array.from({ length: 100 }, (_, index) => ({
                command: `custom_${index}`,
                description: `Custom ${index}`,
              })),
            },
          },
        },
        "bot-a",
      );
      expect(pressure.commands).toHaveLength(100);
      expect(pressure.commands).toContain("custom_0");
      expect(pressure.commands).not.toContain("beta_skill");
      harness.replySpy.mockResolvedValue({ text: "Hidden skill reached the agent." });
      await pressure.bot.handleUpdate({
        update_id: 15599,
        message: commandMessage("/beta_skill run"),
      });
      expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
        CommandSource: "native",
        CommandTurn: { kind: "native", body: "/beta_skill run", authorized: true },
        SessionKey: "agent:beta:main",
      });
      expect(apiCalls).toHaveBeenCalledWith(
        "sendMessage",
        expect.objectContaining({ text: "Hidden skill reached the agent." }),
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("registered poll-answer lane admission", () => {
  it.each([true, false])(
    "holds only the pending poll topic until registration settles (accepted: %s)",
    async (accepted) => {
      const bot = createBot(false, true, {
        commands: { native: false },
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: { "*": { requireMention: false } },
            streaming: { mode: "off" },
          },
        },
      });
      apiResponses.set("getChatMember", { ok: true, result: { status: "member", user: from } });
      const entry = {
        pollId: "pending-topic-poll",
        messageId: 500,
        chat: groupChat,
        threadSpec: { scope: "forum" as const, id: 99 },
        question: "Ready?",
        options: ["Yes", "No"],
      };
      const registration = beginTelegramPollRegistration({ accountId: "default", entry });
      let pollSettled = false;
      const poll = bot
        .handleUpdate({
          update_id: 16000,
          poll_answer: {
            poll_id: entry.pollId,
            option_ids: [0],
            option_persistent_ids: ["yes"],
            user: from,
          },
        })
        .then(() => {
          pollSettled = true;
        });
      const sameTopic = bot.handleUpdate({
        update_id: 16001,
        message: {
          ...commandMessage("same topic follows"),
          entities: [],
          chat: groupChat,
          message_thread_id: 99,
          is_topic_message: true,
        },
      });
      const pending = Promise.allSettled([poll, sameTopic]);
      try {
        await bot.handleUpdate({
          update_id: 16002,
          message: {
            ...commandMessage("independent topic"),
            entities: [],
            chat: groupChat,
            message_thread_id: 100,
            is_topic_message: true,
          },
        });
        expect(pollSettled).toBe(false);
        expect(harness.replySpy.mock.calls.map(([ctx]) => ctx.RawBody)).toEqual([
          "independent topic",
        ]);
        registration.complete(accepted ? await recordTelegramPollRegistryEntry(entry) : null);
        expect((await pending).map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
        expect(harness.replySpy.mock.calls.map(([ctx]) => ctx.RawBody)).toEqual([
          "independent topic",
          ...(accepted ? ['Poll response to "Ready?": Yes'] : []),
          "same topic follows",
        ]);
      } finally {
        registration.complete(null);
        await pending;
      }
    },
  );
});
