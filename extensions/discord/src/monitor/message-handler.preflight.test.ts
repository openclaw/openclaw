import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";
import { shouldIgnoreBoundThreadWebhookMessage } from "./message-handler.preflight-helpers.js";
import * as preflightRuntime from "./message-handler.preflight.js";
import { processDiscordMessage } from "./message-handler.process.js";

installDiscordIngressTestRuntime();
import { ComponentType, MessageReferenceType } from "discord-api-types/v10";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { DiscordConfigSchema } from "../config-schema.js";
import * as discordMessagesApi from "../internal/api.messages.js";
import { ChannelType, MessageType } from "../internal/discord.js";

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
  createGuildPreflightArgs,
  createGuildEvent,
  createGuildTextClient,
  createThreadClient,
  DEFAULT_PREFLIGHT_CFG,
  type DiscordClient,
  type DiscordConfig,
  type DiscordMessageEvent,
} from "./message-handler.preflight.test-helpers.js";

vi.mock("openclaw/plugin-sdk/media-runtime", { spy: true });
vi.mock("./message-handler.process.js", { spy: true });
let preflightDiscordMessage: typeof import("./message-handler.preflight.js").preflightDiscordMessage;
let defaultThreadBindings: import("./thread-bindings.js").ThreadBindingManager;
let createNoopThreadBindingManager: typeof import("./thread-bindings.js").createNoopThreadBindingManager;
let createThreadBindingManager: typeof import("./thread-bindings.js").createThreadBindingManager;
let createDiscordMessageDispatcher: typeof import("./message-dispatcher.js").createDiscordMessageDispatcher;
let channelSequence = 0;
let channelId: string;
const guildId = "guild-1";

beforeAll(async () => {
  ({ preflightDiscordMessage } = await import("./message-handler.preflight.js"));
  ({ createThreadBindingManager, createNoopThreadBindingManager } =
    await import("./thread-bindings.js"));
  ({ createDiscordMessageDispatcher } = await import("./message-dispatcher.js"));
});

beforeEach(() => {
  channelId = `preflight-${++channelSequence}`;
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
function makeMessage(
  content = "hello",
  overrides: Partial<Parameters<typeof createDiscordMessage>[0]> = {},
) {
  return createDiscordMessage({ id: "message-1", channelId, content, author: HUMAN, ...overrides });
}

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

function createDmClient(id: string): DiscordClient {
  return {
    fetchChannel: async (candidate: string) =>
      candidate === id ? { id, type: ChannelType.DM } : null,
  } as unknown as DiscordClient;
}

function allowedChannel(guild: string, channel: string, requireMention: boolean) {
  return { [guild]: { channels: { [channel]: { enabled: true, requireMention } } } };
}

async function runGuildPreflight({
  message,
  channelId: targetChannel = channelId,
  guildId: targetGuild = guildId,
  content = "hello",
  messageOptions = {},
  ...overrides
}: {
  channelId?: string;
  guildId?: string;
  message?: import("../internal/discord.js").Message;
  content?: string;
  messageOptions?: Partial<Parameters<typeof createDiscordMessage>[0]>;
  includeGuildObject?: boolean;
} & Partial<Omit<Parameters<typeof preflightDiscordMessage>[0], "data">>) {
  return preflightDiscordMessage(
    createGuildPreflightArgs({
      message: message ?? makeMessage(content, { channelId: targetChannel, ...messageOptions }),
      channelId: targetChannel,
      guildId: targetGuild,
      threadBindings: defaultThreadBindings,
      ...overrides,
    }),
  );
}

async function runDmPreflight({
  content = "",
  messageOptions = {},
  message = makeMessage(content, { author: ALICE, ...messageOptions }),
  channelId: targetChannel = message.channelId,
  discordConfig = { dmPolicy: "open" },
  cfg = DEFAULT_PREFLIGHT_CFG,
  client = createDmClient(targetChannel),
}: {
  channelId?: string;
  message?: import("../internal/discord.js").Message;
  content?: string;
  messageOptions?: Partial<Parameters<typeof createDiscordMessage>[0]>;
  discordConfig?: DiscordConfig;
  cfg?: import("openclaw/plugin-sdk/config-contracts").OpenClawConfig;
  client?: DiscordClient;
}) {
  return preflightDiscordMessage(
    createPreflightArgs({
      cfg,
      discordConfig,
      client,
      data: { channel_id: targetChannel, author: message.author, message } as DiscordMessageEvent,
    }),
  );
}

describe("preflightDiscordMessage", () => {
  beforeEach(() => {
    transcribeFirstAudioMock.mockReset();
    resolveDiscordDmCommandAccessMock.mockReset();
    resolveDiscordDmCommandAccessMock.mockResolvedValue({
      senderAccess: { allowed: true, decision: "allow", reasonCode: "dm_policy_allowlisted" },
      commandAccess: { authorized: true },
    });
    handleDiscordDmCommandDecisionMock.mockReset();
    handleDiscordDmCommandDecisionMock.mockResolvedValue(undefined);
  });

  it("admits embed-only messages when their text appears after a textless first embed", async () => {
    const result = await runDmPreflight({
      messageOptions: {
        embeds: [
          { image: { url: "https://cdn.discordapp.com/image.png" } },
          { title: "Alert", description: "Details" },
          { description: "Follow-up" },
        ],
      },
    });

    const preflight = expectPreflightResult(result);
    expect(preflight.baseText).toBe("Alert\nDetails\nFollow-up");
    expect(preflight.messageText).toBe("Alert\nDetails\nFollow-up");
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
      content: "who are you",
      discordConfig: { allowBots: true, dmPolicy: "open" },
    });

    const preflight = expectPreflightResult(result);
    expect(preflight.threadBinding).toEqual(binding);
  });

  it("preflights direct-message voice notes without mention gating", async () => {
    transcribeFirstAudioMock.mockResolvedValue("hello openclaw from dm audio");

    const result = await runDmPreflight({
      messageOptions: { attachments: [VOICE_ATTACHMENT] },
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
      content: "hello from a degraded dm",
    });

    const preflight = expectPreflightResult(result);
    expect(preflight.channelInfo).toBeNull();
    expect(preflight.isDirectMessage).toBe(true);
    expect(preflight.isGroupDm).toBe(false);
    expect(preflight.route.sessionKey).toBe("agent:main:discord:direct:user-1");
  });

  it("suppresses repeated bot messages before downloading attachments (#58789)", async () => {
    const senderBotId = "relay-bot-1";
    const messageTimestamp = "2026-05-13T05:00:00.000Z";

    const cfg = {
      ...DEFAULT_PREFLIGHT_CFG,
      channels: { defaults: { botLoopProtection: { maxEventsPerWindow: 1, cooldownSeconds: 60 } } },
    };
    const message = makeMessage("chatter <@openclaw-bot>", {
      mentionedUsers: [{ id: "openclaw-bot" }],
      author: { id: senderBotId, bot: true, username: "Relay" },
      timestamp: messageTimestamp,
    });
    const result = await runGuildPreflight({
      cfg,
      discordConfig: { allowBots: true, pluralkit: { enabled: true } },
      message,
    });

    expect(result).not.toBeNull();
    expect(fetchPluralKitMessageInfoMock).not.toHaveBeenCalled();

    const repeatedMessage = makeMessage("more chatter <@openclaw-bot>", {
      id: "message-2",
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
        message: repeatedMessage,
        discordConfig: { allowBots: true, pluralkit: { enabled: true } },
      }),
    ).toBeNull();
    expect(saveRemoteMediaMock).not.toHaveBeenCalled();
  });

  it("does not count bot messages that earlier preflight gates drop (#58789)", async () => {
    const run = (id: string, content: string, mentionedUsers: Array<{ id: string }> = []) =>
      runGuildPreflight({
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

  it.each([
    ["system self-loop", true, false],
    ["bound bot default admission", undefined, true],
    ["bound bot disabled", false, true],
  ] as const)("handles %s", async (_name, allowBots, registered) => {
    const threadBinding = createThreadBinding({
      targetKind: "session",
      targetSessionKey: "agent:main:acp:discord-thread-1",
    });
    if (registered) {
      registerSessionBindingAdapter({
        channel: "discord",
        accountId: "default",
        listBySession: () => [],
        resolveByConversation: (ref) => (ref.conversationId === channelId ? threadBinding : null),
      });
    }
    const result = await runGuildPreflight({
      content: registered
        ? "here is tool output chunk"
        : "⚙️ codex-acp session active (idle expiry in 24h). Messages here go directly to this session.",
      messageOptions: { author: { ...RELAY, username: registered ? "Relay" : "OpenClaw" } },
      discordConfig: { allowBots },
      client: createThreadClient({ threadId: channelId, parentId: "parent-1" }),
      threadBindings: {
        getByThreadId: (id: string) => (id === channelId ? threadBinding : undefined),
      } as import("./thread-bindings.js").ThreadBindingManager,
    });
    if (!registered || allowBots === false) {
      expect(result).toBeNull();
    } else {
      const preflight = expectPreflightResult(result);
      expect(preflight.boundSessionKey).toBe(threadBinding.targetSessionKey);
      expect(preflight.shouldRequireMention).toBe(false);
      expect(preflight.groupRequireMention).toBe(true);
    }
  });

  it("drops hydrated bound-thread webhook copies after fetching an empty payload", async () => {
    const threadBinding = createThreadBinding({
      targetKind: "session",
      targetSessionKey: "agent:main:acp:discord-thread-1",
    });
    const threadId = "thread-webhook-hydrated-1";
    const parentId = "channel-parent-webhook-hydrated-1";
    const message = makeMessage("", { id: "1001", channelId: threadId, author: RELAY });
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
      author: { id: "relay-bot-1", username: "Relay", bot: true },
    }));
    const client = Object.assign(createThreadClient({ threadId, parentId }), {
      rest: { get: restGet },
    }) as unknown as DiscordClient;

    const result = await runGuildPreflight({
      discordConfig: { allowBots: true, pluralkit: { enabled: true } },
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
      message: makeMessage("<@openclaw-bot> hello", {
        id: "proxy-456",
        channelId: "c1",
        webhookId: "pluralkit-webhook-1",
        author: { id: "webhook-author", bot: true, username: "PluralKit" },
        mentionedUsers: [{ id: "openclaw-bot" }],
      }),
      discordConfig: { pluralkit: { enabled: true } },
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
      commandAccess: { authorized: false },
    });

    const result = await runDmPreflight({
      content: "hello",
      messageOptions: {
        id: "proxy-dm-1",
        webhookId: "pluralkit-webhook-1",
        author: { id: "webhook-author", bot: true, username: "PluralKit" },
      },
      discordConfig: { allowBots: true, dmPolicy: "pairing", pluralkit: { enabled: true } },
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
      expect.objectContaining({ sender: { id: "pk:pk-member-1", tag: "Echo", name: "Echo" } }),
    );
  });

  it.each<
    [
      name: string,
      content: string,
      accepted: boolean,
      options?: {
        pattern?: string;
        botId?: string;
        replyPing?: boolean;
        message?: Partial<Parameters<typeof createDiscordMessage>[0]>;
        hydrate?: "present" | "absent" | "unavailable";
      },
    ]
  >([
    [
      "bot command without mention",
      "/new incident room",
      false,
      { message: { type: MessageType.Default, mentionedUsers: [] } },
    ],
    ["reply ping", "reply without an inline mention", false, { replyPing: true }],
    ["indented code", "    openclaw", false, { pattern: "openclaw", botId: "123456789012345678" }],
    [
      "escaped token",
      "\\<@123456789012345678>",
      false,
      { pattern: "openclaw", botId: "123456789012345678" },
    ],
    ["whole-document anchor", "`example`\nopenclaw", false, { pattern: "^openclaw$" }],
    [
      "whole-document lookbehind",
      "`example` openclaw",
      true,
      { pattern: "(?<=`example` )openclaw" },
    ],
    ["pattern overlaps code", "hello `openclaw`", false, { pattern: "hello.*openclaw" }],
    [
      "independent component documents",
      "",
      true,
      {
        message: {
          components: [
            { type: ComponentType.TextDisplay, content: "~~~\nexample" },
            { type: ComponentType.TextDisplay, content: "hi <@openclaw-bot>" },
          ],
        },
      },
    ],
    ["authoritative mention", "hi <@123456789012345678>", true, { hydrate: "present" }],
    ["authoritative absence", "hi <@123456789012345678>", false, { hydrate: "absent" }],
    ["nickname fallback", "hi <@!123456789012345678>", true, { hydrate: "unavailable" }],
    ["escaped fallback", "example: \\<@123456789012345678>", false, { hydrate: "unavailable" }],
  ])(
    "admits bot messages only for an active mention: %s",
    async (name, content, accepted, scenario = {}) => {
      const botId = scenario.botId ?? (scenario.hydrate ? "123456789012345678" : "openclaw-bot");
      const message = makeMessage(content, {
        id: scenario.hydrate ? "1002" : name,
        author: RELAY,
        type: scenario.hydrate ? MessageType.Default : MessageType.Reply,
        mentionedUsers: scenario.hydrate ? [] : [{ id: botId }],
        ...(scenario.replyPing
          ? {
              referencedMessage: makeMessage("parent message", {
                id: "parent",
                author: { id: botId, bot: true, username: "OpenClaw" },
              }),
            }
          : {}),
        ...scenario.message,
      });
      const client = createGuildTextClient(channelId);
      if (scenario.hydrate) {
        client.rest = {
          get: vi.fn(async () => {
            if (scenario.hydrate === "unavailable") {
              throw new Error("Discord REST unavailable");
            }
            return {
              ...message.rawData,
              mentions:
                scenario.hydrate === "present"
                  ? [{ id: botId, username: "OpenClaw", bot: true }]
                  : [],
            };
          }),
        } as unknown as DiscordClient["rest"];
      }
      const result = await runGuildPreflight({
        message,
        client,
        botUserId: botId,
        discordConfig: { allowBots: "mentions" },
        cfg: scenario.pattern
          ? {
              ...DEFAULT_PREFLIGHT_CFG,
              messages: { groupChat: { mentionPatterns: [scenario.pattern] } },
            }
          : DEFAULT_PREFLIGHT_CFG,
      });
      if (accepted) {
        expect(expectPreflightResult(result).message.id).toBe(message.id);
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
      const client = createGuildTextClient(channelId);
      client.fetchGuild = async () => {
        throw new Error("Guild icon unavailable");
      };
      if (hydrate) {
        const payload = makeMessage(hydrate.content, {
          id: "m-batch-1",
          author: { id: "relay-bot", bot: true, username: "Relay" },
          mentionedUsers: hydrate.native ? [{ id: botId, username: "OpenClaw" }] : [],
          type: MessageType.Reply,
        });
        const fetchMessage = vi
          .spyOn(discordMessagesApi, "getChannelMessage")
          .mockResolvedValue({ ...payload.rawData });
        onTestFinished(() => fetchMessage.mockRestore());
      }
      const parent = makeMessage("handoff", {
        id: "m-batch-parent",
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
      const preflightSpy = vi
        .spyOn(preflightRuntime, "preflightDiscordMessage")
        .mockImplementation(async (params) => {
          const result = await preflightDiscordMessage(params);
          evaluated.resolve(result);
          return result;
        });
      onTestFinished(() => preflightSpy.mockRestore());
      const processSpy = vi.mocked(processDiscordMessage).mockImplementation(async () => {});
      onTestFinished(() => processSpy.mockRestore());
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
      const message = makeMessage("", {
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
        message,
        discordConfig: { allowBots: "mentions" },
        guildEntries: { [guildId]: { requireMention } },
      });

      if (accepted) {
        const preflight = expectPreflightResult(result);
        expect(preflight.effectiveWasMentioned).toBe(true);
        expect(preflight.preflightAudioTranscript).toBe(transcript);
      } else {
        expect(result).toBeNull();
      }
      expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    },
  );

  it("routes ordinary guild text control commands through authorization instead of dropping them", async () => {
    const result = await runGuildPreflight({
      content: "/steer keep digging",
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
    const result = await runGuildPreflight({
      content: "/steer keep digging",
      messageOptions: { type: MessageType.ChatInputCommand },
      allowFrom: ["discord:user-1"],
      guildEntries: allowedChannel(guildId, channelId, true),
    });

    expect(result).toBeNull();
  });

  it("does not mask mention gating when bot id is missing but mention patterns can detect", async () => {
    const result = await runGuildPreflight({
      content: "general update without the configured mention",
      cfg: MENTION_CFG,
      botUserId: undefined,
      guildEntries: allowedChannel(guildId, channelId, true),
    });

    expect(result).toBeNull();
  });

  it("treats @everyone as a mention when requireMention is true", async () => {
    const result = await runGuildPreflight({
      content: "@everyone standup time!",
      messageOptions: { mentionedEveryone: true },
      guildEntries: { [guildId]: { requireMention: true, ignoreOtherMentions: true } },
    });

    const preflight = expectPreflightResult(result);
    expect(preflight.shouldRequireMention).toBe(true);
    expect(preflight.effectiveWasMentioned).toBe(true);
  });

  it.each([
    { threadAgents: undefined, peerId: "parent-1", mentionedAgentIds: ["analyst"] },
    { threadAgents: ["writer"], peerId: "thread-1", mentionedAgentIds: ["writer"] },
  ])(
    "resolves group thread admission with exact entry $threadAgents",
    async ({ threadAgents, peerId, mentionedAgentIds }) => {
      const threadId = "thread-1";
      const parentId = "parent-1";
      const message = makeMessage("@Analyst @Writer please review", {
        channelId: threadId,
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
      expect(preflight.effectiveWasMentioned).toBe(true);
    },
  );

  it("uses fetched thread metadata during mention preflight", async () => {
    const threadId = "thread-partial-owner";
    const parentId = "parent-partial-owner";
    const result = await runGuildPreflight({
      client: createThreadClient({ threadId, parentId }),
      channelId: threadId,
      guildId: "guild-1",
      content: "thread hello",
      includeGuildObject: false,
      guildEntries: allowedChannel("guild-1", parentId, false),
    });

    const preflight = expectPreflightResult(result);
    expect(preflight.threadParentId).toBe(parentId);
    expect(preflight.shouldRequireMention).toBe(false);
  });

  it.each([
    ["another bot", false, false, undefined, false],
    ["forwarded bot message", true, false, undefined, true],
    ["explicit current-bot mention", false, true, undefined, true],
    ["webhook bot", false, false, "webhook-1", true],
  ] as const)(
    "applies ignoreOtherMentions to %s",
    async (_name, forwarded, mentioned, webhookId, accepted) => {
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
          expect(expectPreflightResult(result).effectiveWasMentioned).toBe(true);
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
      const message = makeMessage("", {
        id: "history",
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
    const result = await runGuildPreflight({
      discordConfig: { allowBots: true },
      content: "@everyone heads up",
      messageOptions: { mentionedEveryone: true, author: RELAY },
      guildEntries: { [guildId]: { requireMention: false } },
    });

    const preflight = expectPreflightResult(result);
    expect(preflight.hasAnyMention).toBe(false);
    expect(preflight.effectiveWasMentioned).toBe(false);
  });

  it("does not transcribe guild audio from unauthorized members", async () => {
    const result = await runGuildPreflight({
      cfg: MENTION_CFG,
      content: "",
      messageOptions: {
        attachments: [VOICE_ATTACHMENT],
        author: { id: "user-2", bot: false, username: "Mallory" },
      },
      guildEntries: {
        [guildId]: {
          channels: { [channelId]: { enabled: true, requireMention: true, users: ["user-1"] } },
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
    expect(shouldIgnoreBoundThreadWebhookMessage({ threadId: "thread-1", webhookId: "wh-1" })).toBe(
      false,
    );

    const guildHistories = new Map();
    const message = makeMessage("outbound webhook echo without a mention", {
      channelId: "thread-1",
      webhookId: "wh-1",
      author: { id: "relay-bot-1", bot: true, username: "OpenClaw" },
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
        "guild-1": { channels: { "parent-1": { enabled: true, requireMention: true } } },
      },
    });

    expect(result).toBeNull();
    expect(guildHistories.get("thread-1")).toBeUndefined();
  });
});
describe("Discord bot-owned thread mention gating", () => {
  const humanId = "111111111111111111";
  it("validates guild and channel overrides without adding a default", () => {
    const guild = DiscordConfigSchema.parse({
      guilds: {
        "123": {
          requireMentionInBotThreads: false,
          channels: { "456": { requireMentionInBotThreads: true }, "789": {} },
        },
      },
    }).guilds?.["123"];
    expect({
      guild: guild?.requireMentionInBotThreads,
      channel: guild?.channels?.["456"]?.requireMentionInBotThreads,
      unset: guild?.channels?.["789"]?.requireMentionInBotThreads,
    }).toEqual({ guild: false, channel: true, unset: undefined });
    expect(
      DiscordConfigSchema.safeParse({
        guilds: { "123": { ...guild, requireMentionInBotThreads: "false" } },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["bot-created thread", "relaxed", "openclaw-bot", true],
    ["strict explicit mention", "mention", "openclaw-bot", true],
    ["strict thread implicit reply", "reply", "openclaw-bot", false],
    ["human-created thread", "relaxed", humanId, false],
    ["disallowed sender in bot-created thread", "denied", "openclaw-bot", false],
  ] as const)("checks unmentioned follow-ups in %s", async (_name, mode, ownerId, admitted) => {
    const parentId = `parent-${channelId}`;
    const strict = mode === "mention" || mode === "reply";
    const result = await runGuildPreflight({
      message: makeMessage(mode === "mention" ? "<@openclaw-bot> next?" : "next?", {
        author: { id: humanId, bot: false, username: "Pat" },
        mentionedUsers: mode === "mention" ? [{ id: "openclaw-bot" }] : [],
        referencedMessage:
          mode === "reply"
            ? makeMessage("Started this thread", {
                id: "bot-root",
                author: { id: "openclaw-bot", bot: true },
              })
            : undefined,
      }),
      client: createThreadClient({ threadId: channelId, parentId, ownerId }),
      groupPolicy: "allowlist",
      guildEntries: {
        [guildId]: {
          requireMention: true,
          requireMentionInBotThreads: mode === "reply" ? false : undefined,
          channels: {
            [parentId]: {
              enabled: true,
              requireMention: mode !== "reply",
              requireMentionInBotThreads: strict,
              users: mode === "denied" ? ["222222222222222222"] : [humanId],
            },
          },
        },
      },
    });
    if (!admitted) {
      expect(result).toBeNull();
    } else {
      expect(result).toMatchObject({
        shouldRequireMention: strict === true,
        messageChannelId: channelId,
        effectiveWasMentioned: mode === "mention",
      });
    }
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
