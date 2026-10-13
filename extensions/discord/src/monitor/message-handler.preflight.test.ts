import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";

installDiscordIngressTestRuntime();
import { ComponentType, MessageReferenceType } from "discord-api-types/v10";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as discordMessagesApi from "../internal/api.messages.js";
import { ChannelType, MessageType } from "../internal/discord.js";
import { createPartialDiscordChannelWithThrowingGetters } from "../test-support/partial-channel.js";

const transcribeFirstAudioMock = vi.hoisted(() => vi.fn());
const fetchPluralKitMessageInfoMock = vi.hoisted(() => vi.fn());
const resolveDiscordDmCommandAccessMock = vi.hoisted(() => vi.fn());
const handleDiscordDmCommandDecisionMock = vi.hoisted(() => vi.fn(async () => {}));
const saveRemoteMediaMock = vi.hoisted(() => vi.fn());

vi.mock("../pluralkit.js", () => ({
  fetchPluralKitMessageInfo: (...args: unknown[]) => fetchPluralKitMessageInfoMock(...args),
}));
vi.mock("openclaw/plugin-sdk/media-understanding-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/media-understanding-runtime")>();
  return {
    ...actual,
    createChannelPreflightAudio: (
      params: Parameters<typeof actual.createChannelPreflightAudio>[0],
    ) =>
      actual.createChannelPreflightAudio({
        ...params,
        transcribeFirstAudio: transcribeFirstAudioMock,
      }),
  };
});
vi.mock("./dm-command-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dm-command-auth.js")>()),
  resolveDiscordDmCommandAccess: resolveDiscordDmCommandAccessMock,
}));
vi.mock("./dm-command-decision.js", () => ({
  handleDiscordDmCommandDecision: handleDiscordDmCommandDecisionMock,
}));
import {
  isRecentOutboundMessageIdentity,
  recordOutboundMessageIdentity,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  testing as sessionBindingTesting,
  registerSessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import { saveRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import {
  createThreadBinding,
  createDiscordMessage,
  createDiscordPreflightArgs,
  runThreadBoundPreflight,
  createGuildEvent,
  createGuildTextClient,
  createThreadClient,
  DEFAULT_PREFLIGHT_CFG,
  type DiscordClient,
  type DiscordConfig,
  type DiscordMessageEvent,
} from "./message-handler.preflight.test-helpers.js";

vi.mock("openclaw/plugin-sdk/media-runtime", { spy: true });
let preflightDiscordMessage: typeof import("./message-handler.preflight.js").preflightDiscordMessage;
let shouldIgnoreBoundThreadWebhookMessage: typeof import("./message-handler.preflight.js").shouldIgnoreBoundThreadWebhookMessage;
let defaultThreadBindings: import("./thread-bindings.js").ThreadBindingManager;
let createNoopThreadBindingManager: typeof import("./thread-bindings.js").createNoopThreadBindingManager;
let createThreadBindingManager: typeof import("./thread-bindings.js").createThreadBindingManager;
let createDiscordMessageDispatcher: typeof import("./message-dispatcher.js").createDiscordMessageDispatcher;

beforeAll(async () => {
  ({ preflightDiscordMessage, shouldIgnoreBoundThreadWebhookMessage } =
    await import("./message-handler.preflight.js"));
  ({ createThreadBindingManager, createNoopThreadBindingManager } =
    await import("./thread-bindings.js"));
  ({ createDiscordMessageDispatcher } = await import("./message-dispatcher.js"));
});

beforeEach(() => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  defaultThreadBindings = createNoopThreadBindingManager("default");
  fetchPluralKitMessageInfoMock.mockReset();
  saveRemoteMediaMock.mockReset();
  saveRemoteMediaMock.mockImplementation(
    async (options: { fallbackContentType?: string; filePathHint?: string }) => ({
      id: "test-media",
      path: `/tmp/openclaw-discord-test/${options.filePathHint ?? "media"}`,
      size: 5,
      contentType: options.fallbackContentType,
    }),
  );
  vi.mocked(saveRemoteMedia).mockImplementation((...args) => saveRemoteMediaMock(...args));
});

afterEach(async () => {
  await defaultThreadBindings.stop();
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
});

function createPreflightArgs(
  params: Parameters<typeof createDiscordPreflightArgs>[0],
): Parameters<typeof preflightDiscordMessage>[0] {
  return createDiscordPreflightArgs({ threadBindings: defaultThreadBindings, ...params });
}

const ALICE = { id: "user-1", bot: false, username: "alice" };
const HUMAN = { id: "user-1", bot: false, username: "Alice" };
const RELAY = { id: "relay-bot-1", bot: true, username: "Relay" };

const MENTION_CFG = {
  ...DEFAULT_PREFLIGHT_CFG,
  messages: { groupChat: { mentionPatterns: ["openclaw"] } },
};
const VOICE_ATTACHMENT = {
  id: "voice",
  url: "https://cdn.discordapp.com/attachments/voice.ogg",
  content_type: "audio/ogg",
  filename: "voice.ogg",
};

type DiscordPreflightResult = NonNullable<Awaited<ReturnType<typeof preflightDiscordMessage>>>;

function expectPreflightResult(
  result: Awaited<ReturnType<typeof preflightDiscordMessage>>,
): DiscordPreflightResult {
  if (result === null) {
    throw new Error("Expected Discord preflight result");
  }
  return result;
}

function createDmClient(channelId: string): DiscordClient {
  return {
    fetchChannel: async (id: string) =>
      id === channelId ? { id: channelId, type: ChannelType.DM } : null,
  } as unknown as DiscordClient;
}

function allowedChannel(guildId: string, channelId: string, requireMention: boolean) {
  return { [guildId]: { channels: { [channelId]: { enabled: true, requireMention } } } };
}

async function runGuildPreflight({
  channelId,
  guildId,
  message,
  includeGuildObject,
  cfg = DEFAULT_PREFLIGHT_CFG,
  discordConfig = {},
  client = createGuildTextClient(channelId),
  botUserId = "openclaw-bot",
  ...overrides
}: {
  channelId: string;
  guildId: string;
  message: import("../internal/discord.js").Message;
  includeGuildObject?: boolean;
} & Partial<Omit<Parameters<typeof preflightDiscordMessage>[0], "data">>) {
  return preflightDiscordMessage({
    ...createPreflightArgs({
      cfg,
      discordConfig,
      data: createGuildEvent({
        channelId,
        guildId,
        author: message.author,
        message,
        includeGuildObject,
      }),
      client,
    }),
    botUserId,
    ...overrides,
  });
}

async function runDmPreflight({
  channelId,
  message,
  discordConfig = { dmPolicy: "open" },
  cfg = DEFAULT_PREFLIGHT_CFG,
  client = createDmClient(channelId),
}: {
  channelId: string;
  message: import("../internal/discord.js").Message;
  discordConfig?: DiscordConfig;
  cfg?: import("openclaw/plugin-sdk/config-contracts").OpenClawConfig;
  client?: DiscordClient;
}) {
  return preflightDiscordMessage(
    createPreflightArgs({
      cfg,
      discordConfig,
      client,
      data: { channel_id: channelId, author: message.author, message } as DiscordMessageEvent,
    }),
  );
}

async function runBotReply(
  id: string,
  message: Partial<Parameters<typeof createDiscordMessage>[0]>,
  patterns?: string[],
  botUserId = "openclaw-bot",
) {
  const channelId = `channel-${id}`;
  return runGuildPreflight({
    channelId,
    guildId: `guild-${id}`,
    botUserId,
    discordConfig: { allowBots: "mentions" },
    cfg: patterns
      ? { ...DEFAULT_PREFLIGHT_CFG, messages: { groupChat: { mentionPatterns: patterns } } }
      : DEFAULT_PREFLIGHT_CFG,
    message: createDiscordMessage({
      id,
      channelId,
      content: "",
      author: RELAY,
      type: MessageType.Reply,
      mentionedUsers: [{ id: botUserId }],
      ...message,
    }),
  });
}

describe("preflightDiscordMessage", () => {
  beforeEach(() => {
    transcribeFirstAudioMock.mockReset();
    resolveDiscordDmCommandAccessMock.mockReset();
    resolveDiscordDmCommandAccessMock.mockResolvedValue({
      senderAccess: {
        allowed: true,
        decision: "allow",
        reasonCode: "dm_policy_allowlisted",
      },
      commandAccess: {
        authorized: true,
      },
    });
    handleDiscordDmCommandDecisionMock.mockReset();
    handleDiscordDmCommandDecisionMock.mockResolvedValue(undefined);
  });

  it("admits embed-only messages when their text appears after a textless first embed", async () => {
    const channelId = "dm-channel-multiple-embeds";
    const message = createDiscordMessage({
      id: "m-multiple-embeds",
      channelId,
      content: "",
      author: ALICE,
      embeds: [
        { image: { url: "https://cdn.discordapp.com/image.png" } },
        { title: "Alert", description: "Details" },
        { description: "Follow-up" },
      ],
    });

    const result = await runDmPreflight({
      channelId,
      message,
    });

    const preflight = expectPreflightResult(result);
    expect(preflight.baseText).toBe("Alert\nDetails\nFollow-up");
    expect(preflight.messageText).toBe("Alert\nDetails\nFollow-up");
  });

  it("drops bound-thread bot system messages to prevent ACP self-loop", async () => {
    const threadBinding = createThreadBinding({
      targetKind: "session",
      targetSessionKey: "agent:main:acp:discord-thread-1",
    });
    const threadId = "thread-system-1";
    const parentId = "channel-parent-1";
    const message = createDiscordMessage({
      id: "m-system-1",
      channelId: threadId,
      content:
        "⚙️ codex-acp session active (idle expiry in 24h). Messages here go directly to this session.",
      author: {
        id: "relay-bot-1",
        bot: true,
        username: "OpenClaw",
      },
    });

    const result = await runThreadBoundPreflight({
      threadBindings: defaultThreadBindings,
      threadId,
      parentId,
      message,
      threadBinding,
      discordConfig: {
        allowBots: true,
      },
    });

    expect(result).toBeNull();
  });

  it("restores direct-message bindings by user target instead of DM channel id", async () => {
    const binding = createThreadBinding({
      conversation: { channel: "discord", accountId: "default", conversationId: "user:user-1" },
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/test/plugins/codex-app-server",
      },
    });
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (ref) => (ref.conversationId === "user:user-1" ? binding : null),
    });

    const result = await runDmPreflight({
      channelId: "dm-channel-1",
      message: createDiscordMessage({
        id: "m-dm-1",
        channelId: "dm-channel-1",
        content: "who are you",
        author: ALICE,
      }),
      discordConfig: {
        allowBots: true,
        dmPolicy: "open",
      },
    });

    const preflight = expectPreflightResult(result);
    expect(preflight.threadBinding).toEqual(binding);
  });

  it("ignores stale route-shaped bindings after the configured agent changes", async () => {
    const channelId = "stale-route";
    const binding = createThreadBinding({
      targetKind: "session",
      targetSessionKey: `agent:oldagent:discord:channel:${channelId}`,
      conversation: { channel: "discord", accountId: "default", conversationId: channelId },
      metadata: undefined,
    });
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (ref) => (ref.conversationId === channelId ? binding : null),
    });
    const result = await runGuildPreflight({
      channelId,
      guildId: "guild-stale-route",
      message: createDiscordMessage({
        id: "stale-route",
        channelId,
        content: "which agent is this?",
        author: ALICE,
      }),
      cfg: {
        agents: { entries: { newagent: {} } },
        bindings: [
          {
            agentId: "newagent",
            match: {
              channel: "discord",
              accountId: "default",
              peer: { kind: "channel", id: channelId },
            },
          },
        ],
        channels: { discord: {} },
      },
      discordConfig: { allowBots: true },
      guildEntries: allowedChannel("guild-stale-route", channelId, false),
    });
    const preflight = expectPreflightResult(result);
    expect(preflight.route.agentId).toBe("newagent");
    expect(preflight.route.sessionKey).toBe(`agent:newagent:discord:channel:${channelId}`);
    expect(preflight.boundSessionKey).toBeUndefined();
    expect(preflight.threadBinding).toBeUndefined();
  });

  it("preflights direct-message voice notes without mention gating", async () => {
    transcribeFirstAudioMock.mockResolvedValue("hello openclaw from dm audio");

    const result = await runDmPreflight({
      channelId: "dm-channel-audio-1",
      message: createDiscordMessage({
        id: "m-dm-audio-1",
        channelId: "dm-channel-audio-1",
        content: "",
        attachments: [VOICE_ATTACHMENT],
        author: ALICE,
      }),
    });

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(transcribeFirstAudioMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: {
          media: [
            { url: "https://cdn.discordapp.com/attachments/voice.ogg", contentType: "audio/ogg" },
          ],
        },
      }),
    );
    const preflight = expectPreflightResult(result);
    expect(preflight.isDirectMessage).toBe(true);
    expect(preflight.preflightAudioTranscript).toBe("hello openclaw from dm audio");
    // CDN URLs can expire while queued; preflight must already own the local media.
    expect(saveRemoteMediaMock).toHaveBeenCalledTimes(1);
    expect(preflight.preparedMedia).toEqual([
      {
        path: "/tmp/openclaw-discord-test/voice.ogg",
        contentType: "audio/ogg",
        fileName: "voice.ogg",
        kind: "audio",
      },
    ]);
  });

  it("keeps no-guild messages direct when channel lookup is unavailable", async () => {
    const result = await runDmPreflight({
      client: { fetchChannel: async () => null } as unknown as DiscordClient,
      cfg: {
        ...DEFAULT_PREFLIGHT_CFG,
        session: {
          ...DEFAULT_PREFLIGHT_CFG.session,
          dmScope: "per-channel-peer",
        },
      },
      channelId: "dm-channel-unresolved-1",
      message: createDiscordMessage({
        id: "m-dm-unresolved-1",
        channelId: "dm-channel-unresolved-1",
        content: "hello from a degraded dm",
        author: ALICE,
      }),
    });

    const preflight = expectPreflightResult(result);
    expect(preflight.channelInfo).toBeNull();
    expect(preflight.isDirectMessage).toBe(true);
    expect(preflight.isGroupDm).toBe(false);
    expect(preflight.route.sessionKey).toBe("agent:main:discord:direct:user-1");
  });

  it("suppresses repeated bot messages before downloading attachments (#58789)", async () => {
    const channelId = "channel-bot-loop";
    const guildId = "guild-bot-loop";
    const senderBotId = "relay-bot-1";
    const messageTimestamp = "2026-05-13T05:00:00.000Z";

    const cfg = {
      ...DEFAULT_PREFLIGHT_CFG,
      channels: { defaults: { botLoopProtection: { maxEventsPerWindow: 1, cooldownSeconds: 60 } } },
    };
    const message = createDiscordMessage({
      id: "m-loop-1",
      channelId,
      content: "chatter <@openclaw-bot>",
      mentionedUsers: [{ id: "openclaw-bot" }],
      author: { id: senderBotId, bot: true, username: "Relay" },
      timestamp: messageTimestamp,
    });
    const result = await runGuildPreflight({
      cfg,
      discordConfig: {
        allowBots: true,
        pluralkit: { enabled: true },
      },
      channelId,
      guildId,
      message,
    });

    expect(result).not.toBeNull();
    expect(fetchPluralKitMessageInfoMock).not.toHaveBeenCalled();

    const repeatedMessage = createDiscordMessage({
      id: "m-loop-2",
      channelId,
      content: "more chatter <@openclaw-bot>",
      mentionedUsers: [{ id: "openclaw-bot" }],
      attachments: [
        {
          id: "att-loop",
          url: "https://cdn.discordapp.com/attachments/1/loop.png",
          content_type: "image/png",
          filename: "loop.png",
        },
      ],
      author: { id: senderBotId, bot: true, username: "Relay" },
      timestamp: "2026-05-13T05:00:00.001Z",
    });

    expect(
      await runGuildPreflight({
        cfg,
        channelId,
        guildId,
        message: repeatedMessage,
        discordConfig: {
          allowBots: true,
          pluralkit: { enabled: true },
        },
      }),
    ).toBeNull();
    expect(saveRemoteMediaMock).not.toHaveBeenCalled();
  });

  it("does not count bot messages that earlier preflight gates drop (#58789)", async () => {
    const channelId = "channel-bot-loop-dropped";
    const guildId = "guild-bot-loop-dropped";
    const run = (id: string, content: string, mentionedUsers: Array<{ id: string }> = []) =>
      runGuildPreflight({
        channelId,
        guildId,
        message: createDiscordMessage({
          id,
          channelId,
          content,
          mentionedUsers,
          author: { id: "relay-bot-dropped", bot: true, username: "Relay" },
        }),
        discordConfig: {
          allowBots: true,
          botLoopProtection: { enabled: true, maxEventsPerWindow: 1, cooldownSeconds: 60 },
        },
        guildEntries: { [guildId]: { requireMention: false, ignoreOtherMentions: true } },
      });
    expect(await run("dropped", "cc <@999>", [{ id: "999" }])).toBeNull();
    expect(await run("accepted", "legitimate bot relay")).not.toBeNull();
  });

  it.each([undefined, false])(
    "handles bound-thread bot messages with allowBots=%s",
    async (allowBots) => {
      const threadBinding = createThreadBinding({
        targetKind: "session",
        targetSessionKey: "agent:main:acp:discord-thread-1",
      });
      const threadId = "thread-bot-regular-1";
      const parentId = "channel-parent-regular-1";
      const message = createDiscordMessage({
        id: "m-bot-regular-1",
        channelId: threadId,
        content: "here is tool output chunk",
        author: RELAY,
      });

      const result = await runThreadBoundPreflight({
        threadBindings: defaultThreadBindings,
        threadId,
        parentId,
        message,
        threadBinding,
        discordConfig: {
          allowBots,
        },
        registerBindingAdapter: true,
      });

      if (allowBots === false) {
        expect(result).toBeNull();
      } else {
        const preflight = expectPreflightResult(result);
        expect(preflight.boundSessionKey).toBe(threadBinding.targetSessionKey);
        expect(preflight.shouldRequireMention).toBe(false);
        expect(preflight.groupRequireMention).toBe(true);
      }
    },
  );

  it("drops hydrated bound-thread webhook copies after fetching an empty payload", async () => {
    const threadBinding = createThreadBinding({
      targetKind: "session",
      targetSessionKey: "agent:main:acp:discord-thread-1",
    });
    const threadId = "thread-webhook-hydrated-1";
    const parentId = "channel-parent-webhook-hydrated-1";
    const message = createDiscordMessage({
      id: "1001",
      channelId: threadId,
      content: "",
      author: RELAY,
    });
    const restGet = vi.fn(async () => ({
      ...message.rawData,
      id: message.id,
      content: "webhook relay",
      webhook_id: "foreign-webhook",
      attachments: [],
      embeds: [],
      mentions: [],
      mention_roles: [],
      mention_everyone: false,
      author: {
        id: "relay-bot-1",
        username: "Relay",
        bot: true,
      },
    }));
    const client = Object.assign(createThreadClient({ threadId, parentId }), {
      rest: {
        get: restGet,
      },
    }) as unknown as DiscordClient;

    const result = await runGuildPreflight({
      discordConfig: {
        allowBots: true,
        pluralkit: { enabled: true },
      },
      client,
      channelId: threadId,
      guildId: "guild-1",
      message,
      threadBindings: {
        getByThreadId: (id: string) => (id === threadId ? threadBinding : undefined),
      } as import("./thread-bindings.js").ThreadBindingManager,
    });

    expect(restGet).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
    expect(fetchPluralKitMessageInfoMock).not.toHaveBeenCalled();
  });

  it("canonicalizes PluralKit webhook messages to the original Discord message id", async () => {
    const abortController = new AbortController();
    fetchPluralKitMessageInfoMock.mockResolvedValue({
      id: "proxy-456",
      original: "orig-123",
      member: { id: "member-1", name: "Echo" },
      system: { id: "system-1", name: "System" },
    });

    const result = await runGuildPreflight({
      channelId: "c1",
      guildId: "g1",
      message: createDiscordMessage({
        id: "proxy-456",
        channelId: "c1",
        content: "<@openclaw-bot> hello",
        webhookId: "pluralkit-webhook-1",
        author: {
          id: "webhook-author",
          bot: true,
          username: "PluralKit",
        },
        mentionedUsers: [{ id: "openclaw-bot" }],
      }),
      discordConfig: {
        pluralkit: { enabled: true },
      },
      abortSignal: abortController.signal,
    });

    expect(fetchPluralKitMessageInfoMock).toHaveBeenCalledTimes(1);
    expect(fetchPluralKitMessageInfoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "proxy-456",
        config: { enabled: true },
        signal: abortController.signal,
      }),
    );
    const preflight = expectPreflightResult(result);
    expect(preflight.sender.isPluralKit).toBe(true);
    expect(preflight.canonicalMessageId).toBe("orig-123");
  });

  it("uses the resolved PluralKit member id when creating DM pairing requests", async () => {
    fetchPluralKitMessageInfoMock.mockResolvedValue({
      id: "proxy-dm-1",
      original: "orig-dm-1",
      member: { id: "pk-member-1", name: "Echo" },
      system: { id: "system-1", name: "System" },
    });
    resolveDiscordDmCommandAccessMock.mockResolvedValue({
      senderAccess: {
        allowed: false,
        decision: "pairing",
        reasonCode: "dm_policy_pairing_required",
      },
      commandAccess: {
        authorized: false,
      },
    });

    const result = await runDmPreflight({
      channelId: "dm-channel-pk-1",
      message: createDiscordMessage({
        id: "proxy-dm-1",
        channelId: "dm-channel-pk-1",
        content: "hello",
        webhookId: "pluralkit-webhook-1",
        author: {
          id: "webhook-author",
          bot: true,
          username: "PluralKit",
        },
      }),
      discordConfig: {
        allowBots: true,
        dmPolicy: "pairing",
        pluralkit: { enabled: true },
      },
    });

    expect(result).toBeNull();
    expect(resolveDiscordDmCommandAccessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sender: {
          id: "pk-member-1",
          name: "Echo",
          tag: "Echo",
          isPluralKit: true,
          authorKind: "bot",
        },
      }),
    );
    expect(handleDiscordDmCommandDecisionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sender: {
          id: "pk:pk-member-1",
          tag: "Echo",
          name: "Echo",
        },
      }),
    );
  });

  it("drops bot control commands without a real mention in mention-only mode", async () => {
    expect(
      await runBotReply("bot-command", {
        content: "/new incident room",
        type: MessageType.Default,
        mentionedUsers: [],
      }),
    ).toBeNull();
  });

  it("drops a bot reply whose only mention is the reply ping", async () => {
    expect(
      await runBotReply("reply-ping", {
        content: "reply without an inline mention",
        referencedMessage: createDiscordMessage({
          id: "parent",
          channelId: "channel-reply-ping",
          content: "parent message",
          author: { id: "openclaw-bot", bot: true, username: "OpenClaw" },
        }),
      }),
    ).toBeNull();
  });

  it.each([
    { name: "indented code", content: "    openclaw" },
    { name: "escaped native token", content: "\\<@123456789012345678>" },
  ])("does not re-admit reply-ping metadata through $name", async ({ content }) => {
    expect(
      await runBotReply("inactive-pattern", { content }, ["openclaw"], "123456789012345678"),
    ).toBeNull();
  });

  it.each([
    { content: "`example`\nopenclaw", pattern: "^openclaw$", accepted: false },
    { content: "`example` openclaw", pattern: "(?<=`example` )openclaw", accepted: true },
    { content: "hello `openclaw`", pattern: "hello.*openclaw", accepted: false },
  ])(
    "matches reply pattern $pattern against the whole document $content",
    async ({ content, pattern, accepted }) => {
      const result = await runBotReply("active-pattern", { content }, [pattern]);
      if (accepted) {
        expect(expectPreflightResult(result).message.id).toBe("active-pattern");
      } else {
        expect(result).toBeNull();
      }
    },
  );

  it.each<{
    contents: [string, string];
    mentions: [boolean, boolean];
    patterns: string[];
    accepted: boolean;
    botId?: string;
    hydrate?: { content: string; native: boolean };
    expectedText?: string;
  }>([
    {
      contents: ["<@openclaw-bot> without native mention metadata", "reply ping"],
      mentions: [false, true],
      patterns: [],
      accepted: false,
    },
    {
      contents: ["~~~\nexample", "openclaw"],
      mentions: [true, true],
      patterns: ["^openclaw$"],
      accepted: true,
    },
    {
      contents: ["prior context", "<@123456789012345678> missing metadata"],
      mentions: [false, false],
      patterns: [],
      accepted: true,
      botId: "123456789012345678",
      hydrate: { content: "<@123456789012345678> take over", native: true },
      expectedText: "prior context\n@OpenClaw take over",
    },
    {
      contents: ["prior context", "<@123456789012345678> missing content"],
      mentions: [false, false],
      patterns: ["^openclaw take over$"],
      accepted: true,
      botId: "123456789012345678",
      hydrate: { content: "openclaw take over", native: false },
      expectedText: "prior context\nopenclaw take over",
    },
  ])(
    "preserves mention documents through a reply batch: $contents",
    async ({
      contents,
      mentions,
      patterns,
      accepted,
      botId = "openclaw-bot",
      hydrate,
      expectedText,
    }) => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const channelId = "channel-bot-reply-batch";
      const guildId = "guild-bot-reply-batch";
      const client = createGuildTextClient(channelId);
      client.fetchGuild = async () => {
        throw new Error("Guild icon unavailable");
      };
      if (hydrate) {
        const payload = createDiscordMessage({
          id: "m-batch-1",
          channelId,
          content: hydrate.content,
          author: { id: "relay-bot", bot: true, username: "Relay" },
          mentionedUsers: hydrate.native ? [{ id: botId, username: "OpenClaw" }] : [],
          type: MessageType.Reply,
        });
        const fetchMessage = vi
          .spyOn(discordMessagesApi, "getChannelMessage")
          .mockResolvedValue({ ...payload.rawData });
        onTestFinished(() => fetchMessage.mockRestore());
      }
      const parent = createDiscordMessage({
        id: "m-batch-parent",
        channelId,
        content: "handoff",
        author: { id: botId, bot: true },
      });
      const events = contents.map((content, index) => {
        const message = createDiscordMessage({
          id: `m-batch-${index}`,
          channelId,
          content,
          mentionedUsers: mentions[index] ? [{ id: botId }] : [],
          type: MessageType.Reply,
          referencedMessage: parent,
          author: { id: "relay-bot", bot: true },
        });
        return createGuildEvent({ channelId, guildId, author: message.author, message });
      });
      const evaluated = createDeferred<DiscordPreflightResult | null>();
      const dispatcher = createDiscordMessageDispatcher({
        ...createPreflightArgs({
          cfg: {
            ...DEFAULT_PREFLIGHT_CFG,
            messages: { inbound: { debounceMs: 20 }, groupChat: { mentionPatterns: patterns } },
          },
          discordConfig: { allowBots: "mentions", groupPolicy: "open" },
          data: events[0]!,
          client,
        }),
        botUserId: botId,
        runtime: {
          log: vi.fn(),
          error: (...args) => evaluated.reject(new Error(args.join(" "))),
          exit: vi.fn(),
        },
        testing: {
          preflightDiscordMessage: async (params) => {
            const result = await preflightDiscordMessage(params);
            evaluated.resolve(result);
            return result;
          },
          processDiscordMessage: async () => {},
        },
      });
      onTestFinished(() => dispatcher.deactivate());
      for (const event of events) {
        await dispatcher(event, client);
      }
      await vi.advanceTimersByTimeAsync(20);
      const result = await evaluated.promise;
      if (accepted) {
        expect(expectPreflightResult(result).message.id).toBe("m-batch-1");
        if (expectedText) {
          expect(expectPreflightResult(result).messageText).toBe(expectedText);
        }
      } else {
        expect(result).toBeNull();
      }
    },
  );

  it.each([
    { requireMention: false, transcript: "hey openclaw", accepted: true },
    { requireMention: false, transcript: "hello everyone", accepted: false },
  ])(
    "gates bot audio replies by transcript: $requireMention, $transcript",
    async ({ requireMention, transcript, accepted }) => {
      transcribeFirstAudioMock.mockResolvedValue(transcript);
      const channelId = "channel-bot-audio-mention";
      const guildId = "guild-bot-audio-mention";
      const message = createDiscordMessage({
        id: "m-bot-audio-mention",
        channelId,
        content: "",
        type: MessageType.Reply,
        mentionedUsers: [{ id: "openclaw-bot" }],
        referencedMessage: createDiscordMessage({
          id: "m-audio-parent",
          channelId,
          content: "audio handoff",
          author: { id: "openclaw-bot", bot: true },
        }),
        attachments: [VOICE_ATTACHMENT],
        author: RELAY,
      });

      const result = await runGuildPreflight({
        cfg: MENTION_CFG,
        channelId,
        guildId,
        message,
        discordConfig: { allowBots: "mentions" },
        guildEntries: { [guildId]: { requireMention } },
      });

      if (accepted) {
        const preflight = expectPreflightResult(result);
        expect(preflight.wasMentioned).toBe(true);
        expect(preflight.preflightAudioTranscript).toBe(transcript);
      } else {
        expect(result).toBeNull();
      }
      expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    },
  );

  it("parses component mention tokens as independent Markdown documents", async () => {
    const result = await runBotReply("component-documents", {
      components: [
        { type: ComponentType.TextDisplay, content: "~~~\nexample" },
        { type: ComponentType.TextDisplay, content: "hi <@openclaw-bot>" },
      ],
    });
    expect(expectPreflightResult(result).message.id).toBe("component-documents");
  });

  it.each([
    {
      name: "authoritative mention",
      content: "hi <@123456789012345678>",
      mentions: true,
      accepted: true,
    },
    {
      name: "authoritative absence",
      content: "hi <@123456789012345678>",
      accepted: false,
    },
    {
      name: "raw nickname mention fallback",
      content: "hi <@!123456789012345678>",
      unavailable: true,
      accepted: true,
    },
    {
      name: "escaped fallback token",
      content: "example: \\<@123456789012345678>",
      unavailable: true,
      accepted: false,
    },
  ])(
    "uses $name when hydrating mention metadata",
    async ({ content, mentions, unavailable, accepted }) => {
      const channelId = "channel-bot-hydration";
      const botUserId = "123456789012345678";
      const message = createDiscordMessage({ id: "1002", channelId, content, author: RELAY });
      const client = createGuildTextClient(channelId);
      client.rest = {
        get: vi.fn(async () => {
          if (unavailable) {
            throw new Error("Discord REST unavailable");
          }
          return {
            ...message.rawData,
            mentions: mentions ? [{ id: botUserId, username: "OpenClaw", bot: true }] : [],
          };
        }),
      } as unknown as DiscordClient["rest"];
      const result = await runGuildPreflight({
        channelId,
        guildId: "guild-bot-hydration",
        message,
        client,
        botUserId,
        discordConfig: { allowBots: "mentions" },
      });
      if (accepted) {
        expect(expectPreflightResult(result).message.id).toBe(message.id);
      } else {
        expect(result).toBeNull();
      }
    },
  );

  it("routes ordinary guild text control commands through authorization instead of dropping them", async () => {
    const channelId = "channel-text-control-command";
    const guildId = "guild-text-control-command";
    const message = createDiscordMessage({
      id: "m-text-control-command",
      channelId,
      content: "/steer keep digging",
      author: HUMAN,
    });

    const result = await runGuildPreflight({
      channelId,
      guildId,
      message,
      allowFrom: ["discord:user-1"],
      guildEntries: allowedChannel(guildId, channelId, true),
    });

    const preflight = expectPreflightResult(result);
    expect(preflight.baseText).toBe("/steer keep digging");
    expect(preflight.commandAuthorized).toBe(true);
    expect(preflight.shouldRequireMention).toBe(true);
    expect(preflight.shouldBypassMention).toBe(true);
  });

  it("still drops Discord native command echo messages", async () => {
    const channelId = "channel-native-command-echo";
    const guildId = "guild-native-command-echo";
    const message = createDiscordMessage({
      id: "m-native-command-echo",
      channelId,
      content: "/steer keep digging",
      type: MessageType.ChatInputCommand,
      author: HUMAN,
    });

    const result = await runGuildPreflight({
      channelId,
      guildId,
      message,
      allowFrom: ["discord:user-1"],
      guildEntries: allowedChannel(guildId, channelId, true),
    });

    expect(result).toBeNull();
  });

  it("does not mask mention gating when bot id is missing but mention patterns can detect", async () => {
    const channelId = "channel-missing-bot-id-mention-gate";
    const guildId = "guild-missing-bot-id-mention-gate";
    const message = createDiscordMessage({
      id: "m-missing-bot-id-mention-gate",
      channelId,
      content: "general update without the configured mention",
      author: HUMAN,
    });

    const result = await preflightDiscordMessage({
      ...createPreflightArgs({
        cfg: MENTION_CFG,
        discordConfig: {},
        data: createGuildEvent({
          channelId,
          guildId,
          author: message.author,
          message,
        }),
        client: createGuildTextClient(channelId),
      }),
      botUserId: undefined,
      guildEntries: allowedChannel(guildId, channelId, true),
    });

    expect(result).toBeNull();
  });

  it("treats @everyone as a mention when requireMention is true", async () => {
    const channelId = "channel-everyone-mention";
    const guildId = "guild-everyone-mention";
    const message = createDiscordMessage({
      id: "m-everyone-mention",
      channelId,
      content: "@everyone standup time!",
      mentionedEveryone: true,
      author: HUMAN,
    });

    const result = await runGuildPreflight({
      channelId,
      guildId,
      message,
      guildEntries: { [guildId]: { requireMention: true, ignoreOtherMentions: true } },
    });

    const preflight = expectPreflightResult(result);
    expect(preflight.shouldRequireMention).toBe(true);
    expect(preflight.wasMentioned).toBe(true);
  });

  it.each([
    { threadAgents: undefined, peerId: "parent-1", mentionedAgentIds: ["analyst"] },
    { threadAgents: ["writer"], peerId: "thread-1", mentionedAgentIds: ["writer"] },
  ])(
    "resolves group thread admission with exact entry $threadAgents",
    async ({ threadAgents, peerId, mentionedAgentIds }) => {
      const threadId = "thread-1";
      const parentId = "parent-1";
      const message = createDiscordMessage({
        id: "group-thread-admission",
        channelId: threadId,
        content: "@Analyst @Writer please review",
        author: { id: "user-1", bot: false, username: "Pat" },
      });
      const result = await runGuildPreflight({
        cfg: {
          ...DEFAULT_PREFLIGHT_CFG,
          agents: {
            entries: {
              primary: { identity: { name: "Primary" } },
              analyst: { identity: { name: "Analyst" } },
              writer: { identity: { name: "Writer" } },
            },
          },
          bindings: [{ agentId: "primary", match: { channel: "discord" } }],
          broadcast: {
            [`discord:${parentId}`]: ["analyst"],
            ...(threadAgents ? { [`discord:${threadId}`]: threadAgents } : {}),
          },
        },
        client: createThreadClient({ threadId, parentId }),
        channelId: threadId,
        guildId: "guild-1",
        message,
        guildEntries: allowedChannel("guild-1", parentId, true),
      });
      const preflight = expectPreflightResult(result);
      expect(preflight.groupThread?.peerId).toBe(peerId);
      expect(preflight.groupThread?.mentionedAgentIds).toEqual(mentionedAgentIds);
      expect(preflight.messageChannelId).toBe(threadId);
      expect(preflight.wasMentioned).toBe(true);
    },
  );

  it("handles partial thread channel owner getters during mention preflight", async () => {
    const threadId = "thread-partial-owner";
    const parentId = "parent-partial-owner";
    const message = createDiscordMessage({
      id: "m-thread-partial-owner",
      channelId: threadId,
      content: "thread hello",
      author: HUMAN,
    });
    Object.defineProperty(message, "channel", {
      value: createPartialDiscordChannelWithThrowingGetters(
        {
          id: threadId,
          isThread: () => true,
          ownerId: "owner-1",
          parentId,
          parent: { id: parentId, name: "general" },
        },
        ["ownerId", "parentId", "parent"],
      ),
      configurable: true,
      enumerable: true,
    });

    const result = await runGuildPreflight({
      client: createThreadClient({
        threadId,
        parentId,
      }),
      channelId: threadId,
      guildId: "guild-1",
      message,
      includeGuildObject: false,
      guildEntries: allowedChannel("guild-1", parentId, false),
    });

    const preflight = expectPreflightResult(result);
    expect(preflight.threadParentId).toBe(parentId);
    expect(preflight.shouldRequireMention).toBe(false);
  });

  it.each([
    {
      name: "another bot",
      accepted: false,
    },
    {
      name: "forwarded bot message",
      forwarded: true,
      accepted: true,
    },
    {
      name: "explicit current-bot mention",
      mentioned: true,
      accepted: true,
    },
    {
      name: "webhook bot",
      webhookId: "webhook-1",
      accepted: true,
    },
  ])(
    "applies ignoreOtherMentions to $name",
    async ({ forwarded, mentioned, webhookId, accepted }) => {
      const channelId = "channel-other-bot-reply";
      const message = createDiscordMessage({
        id: "other-bot-reply",
        channelId,
        author: HUMAN,
        content: mentioned ? "<@openclaw-bot> please weigh in" : "following up",
        mentionedUsers: mentioned ? [{ id: "openclaw-bot" }] : [],
        messageReference: forwarded
          ? { type: MessageReferenceType.Forward, channel_id: channelId }
          : undefined,
        referencedMessage: createDiscordMessage({
          id: "other-bot",
          channelId,
          content: "earlier answer",
          webhookId,
          author: { id: "other-bot", bot: true, username: "OtherBot" },
        }),
      });
      const result = await runGuildPreflight({
        channelId,
        guildId: "guild-other-bot-reply",
        message,
        guildEntries: {
          "guild-other-bot-reply": { requireMention: false, ignoreOtherMentions: true },
        },
      });
      if (!accepted) {
        expect(result).toBeNull();
      } else {
        expect(expectPreflightResult(result).message.id).toBe(message.id);
        if (mentioned) {
          expect(expectPreflightResult(result).wasMentioned).toBe(true);
        }
      }
    },
  );

  it.each([
    { kind: "document", body: "<media:document>", count: 0 },
    { kind: "sticker", body: "<media:sticker>", count: 1 },
    { kind: "image", body: "<media:image>", count: 4 },
  ])(
    "records bounded local $kind media in skipped guild history",
    async ({ kind, body, count }) => {
      const channelId = "channel-history";
      const guildId = "guild-history";
      const guildHistories = new Map();
      const sticker = { id: "sticker-history", name: "history-sticker", format_type: 1 };
      if (kind === "sticker") {
        saveRemoteMediaMock.mockResolvedValueOnce({
          id: "test-sticker",
          path: "/tmp/openclaw-discord-test/sticker.png",
          size: 5,
          contentType: "image/png",
        });
      }
      const message = createDiscordMessage({
        id: "history",
        channelId,
        content: "",
        author: HUMAN,
        attachments:
          kind === "document"
            ? [
                {
                  id: "document",
                  url: "https://cdn.discordapp.com/attachments/1/history.pdf",
                  filename: "history.pdf",
                  content_type: "application/pdf",
                },
              ]
            : kind === "image"
              ? Array.from({ length: 4 }, (_, index) => ({
                  id: `image-${index}`,
                  url: `https://cdn.discordapp.com/attachments/1/history-${index}.png`,
                  filename: `history-${index}.png`,
                  content_type: "image/png",
                }))
              : [],
        stickers: kind === "document" ? [] : [sticker],
      });
      const result = await runGuildPreflight({
        channelId,
        guildId,
        message,
        guildHistories,
        historyLimit: 4,
        guildEntries: allowedChannel(guildId, channelId, true),
      });
      expect(result).toBeNull();
      const entries = guildHistories.get(channelId);
      expect(entries).toHaveLength(1);
      // Image attachments consume the media cap before the trailing sticker.
      expect(entries[0]).toMatchObject({ sender: "Alice", messageId: "history" });
      if (kind !== "image") {
        expect(entries[0].body).toBe(body);
      }
      expect(saveRemoteMediaMock).toHaveBeenCalledTimes(count);
      if (kind === "document") {
        expect(entries[0].media).toBeUndefined();
      } else {
        expect(entries[0].media).toEqual(
          Array.from({ length: count }, (_, index) => ({
            path: `/tmp/openclaw-discord-test/${kind === "sticker" ? "sticker" : `history-${index}`}.png`,
            contentType: "image/png",
            kind,
            messageId: "history",
          })),
        );
      }
    },
  );

  it("does not count bot-sent @everyone as a mention", async () => {
    const channelId = "channel-everyone-1";
    const guildId = "guild-everyone-1";
    const client = createGuildTextClient(channelId);
    const message = createDiscordMessage({
      id: "m-everyone-1",
      channelId,
      content: "@everyone heads up",
      mentionedEveryone: true,
      author: RELAY,
    });

    const result = await runGuildPreflight({
      discordConfig: {
        allowBots: true,
      },
      client,
      channelId,
      guildId,
      message,
      guildEntries: {
        [guildId]: {
          requireMention: false,
        },
      },
    });

    const preflight = expectPreflightResult(result);
    expect(preflight.hasAnyMention).toBe(false);
    expect(preflight.wasMentioned).toBe(false);
  });

  it("does not transcribe guild audio from unauthorized members", async () => {
    const channelId = "channel-audio-unauthorized-1";
    const guildId = "guild-audio-unauthorized-1";
    const client = createGuildTextClient(channelId);

    const message = createDiscordMessage({
      id: "m-audio-unauthorized-1",
      channelId,
      content: "",
      attachments: [VOICE_ATTACHMENT],
      author: {
        id: "user-2",
        bot: false,
        username: "Mallory",
      },
    });

    const result = await runGuildPreflight({
      cfg: MENTION_CFG,
      client,
      channelId,
      guildId,
      message,
      guildEntries: {
        [guildId]: {
          channels: {
            [channelId]: {
              enabled: true,
              requireMention: true,
              users: ["user-1"],
            },
          },
        },
      },
    });

    expect(transcribeFirstAudioMock).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});

describe("shouldIgnoreBoundThreadWebhookMessage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves a sent webhook identity suppressible after the Discord thread is unbound", async () => {
    let nowMs = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const manager = await createThreadBindingManager({
      cfg: DEFAULT_PREFLIGHT_CFG,
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });
    onTestFinished(() => manager.stop());
    const binding = await manager.bindTarget({
      threadId: "thread-1",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child-1",
      agentId: "main",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });
    expect(binding).not.toBeNull();
    recordOutboundMessageIdentity({
      channel: "discord",
      accountId: "default",
      conversationId: "thread-1",
      sourceId: "wh-1",
    });

    nowMs += 30_000;
    await manager.unbindThread({ threadId: "thread-1", sendFarewell: false });

    expect(
      isRecentOutboundMessageIdentity({
        channel: "discord",
        accountId: "default",
        conversationId: "thread-1",
        sourceId: "wh-1",
      }),
    ).toBe(true);
    expect(
      shouldIgnoreBoundThreadWebhookMessage({
        threadId: "thread-1",
        webhookId: "wh-1",
      }),
    ).toBe(false);

    const guildHistories = new Map();
    const message = createDiscordMessage({
      id: "m-unbound-webhook-echo-1",
      channelId: "thread-1",
      content: "outbound webhook echo without a mention",
      webhookId: "wh-1",
      author: {
        id: "relay-bot-1",
        bot: true,
        username: "OpenClaw",
      },
    });
    const result = await runGuildPreflight({
      discordConfig: { allowBots: true },
      client: createThreadClient({ threadId: "thread-1", parentId: "parent-1" }),
      threadBindings: manager,
      channelId: "thread-1",
      guildId: "guild-1",
      message,
      guildHistories,
      historyLimit: 4,
      guildEntries: {
        "guild-1": {
          channels: {
            "parent-1": {
              enabled: true,
              requireMention: true,
            },
          },
        },
      },
    });

    expect(result).toBeNull();
    expect(guildHistories.get("thread-1")).toBeUndefined();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
