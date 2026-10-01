import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConfig, OpenClawConfig } from "../../runtime-api.js";
import { MSTeamsConfigSchema } from "../config-schema.js";
import { sendMSTeamsMessages } from "../messenger.js";
import { sendMSTeamsActivityWithReference } from "../sdk-proactive.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
import type { MSTeamsApp } from "../sdk.js";
import { recordMSTeamsSentMessage } from "../sent-message-cache.js";
import * as sentMessages from "../sent-message-cache.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";
import {
  buildChannelActivity,
  channelConversationId,
  createMessageHandlerDeps,
} from "./message-handler.test-support.js";

const dispatch = getRuntimeApiMockState().dispatchReplyWithBufferedBlockDispatcher;
let sequence = 0;

vi.mock("../graph-thread.js", () => ({
  fetchChannelMessage: vi.fn(async () => undefined),
  fetchThreadReplies: vi.fn(async () => []),
  fetchChatMessageText: vi.fn(async () => undefined),
  buildThreadContext: vi.fn(() => []),
  stripHtmlFromTeamsMessage: vi.fn((value: string) => value),
}));

vi.mock("../team-identity.js", () => ({
  resolveTeamGroupId: vi.fn(async () => "group-1"),
}));

async function sendChannelMessage(params: {
  messageId: string;
  botId?: string;
  conversationId?: string;
  threadActivityId?: string;
}) {
  const create = vi.fn(async () => ({ id: params.messageId }));
  const activities = vi.fn((_conversationId: string) => ({ create }));
  const serviceUrl = "https://smba.trafficmanager.net/amer/";
  await sendMSTeamsActivityWithReference(
    {
      api: {
        serviceUrl,
        conversations: { activities },
      },
    } as unknown as MSTeamsApp,
    {
      serviceUrl,
      agent: { id: params.botId ?? "bot-id" },
      conversation: {
        id: params.conversationId ?? channelConversationId,
        conversationType: "channel",
      },
    },
    { type: "message", text: "Synthetic bot message" },
    { threadActivityId: params.threadActivityId },
  );
  expect(create).toHaveBeenCalledTimes(1);
  return activities.mock.calls[0]?.[0];
}

function incoming(overrides: Partial<MSTeamsTurnContext["activity"]>): MSTeamsTurnContext {
  return {
    activity: buildChannelActivity({ id: `reply-${sequence}`, entities: [], ...overrides }),
    sendActivity: vi.fn(async () => undefined),
    sendActivities: vi.fn(async () => []),
    updateActivity: vi.fn(async () => undefined),
    deleteActivity: vi.fn(async () => undefined),
  };
}
function conversation(root: string) {
  return { id: `${channelConversationId};messageid=${root}`, conversationType: "channel" };
}

describe("Teams mention policy in bot-created channel threads", () => {
  beforeEach(() => {
    dispatch.mockClear();
  });
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    ["prefilled top-level post", false, "bot-id", channelConversationId, true, false],
    ["proactive reply is not a root", true, "bot-id", channelConversationId, false, false],
    ["another bot's root", false, "other-bot", channelConversationId, false, false],
    ["another channel's root", false, "bot-id", "19:other@thread.tacv2", false, false],
    ["expired ownership", false, "bot-id", channelConversationId, false, true],
  ] as const)("%s", async (_name, threaded, botId, conversationId, allowed, expired) => {
    const rootId = `bot-thread-root-${++sequence}`;
    const config: MSTeamsConfig = {
      groupPolicy: "open",
      requireMention: true,
      requireMentionInBotThreads: true,
      teams: {
        "team-1": {
          requireMentionInBotThreads: false,
          channels: {
            [channelConversationId]: allowed ? { requireMentionInBotThreads: false } : {},
          },
        },
      },
    };
    MSTeamsConfigSchema.parse(config);
    const { deps } = createMessageHandlerDeps({ channels: { msteams: config } });
    const clock = expired
      ? vi.spyOn(Date, "now").mockReturnValue(Date.now() - 25 * 60 * 60 * 1000)
      : undefined;
    let destination: string | undefined;
    try {
      destination = await sendChannelMessage({
        messageId: rootId,
        botId,
        conversationId: `${conversationId};messageid=stale-source-thread`,
        threadActivityId: threaded ? "human-thread-root" : undefined,
      });
    } finally {
      clock?.mockRestore();
    }
    expect(destination).toBe(
      threaded ? `${conversationId};messageid=human-thread-root` : conversationId,
    );
    const handler = createMSTeamsMessageHandler(deps);
    await handler(
      incoming({ conversation: conversation(rootId), replyToId: "human-nested-reply" }),
    );
    expect(dispatch).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });

  it("live thread replies retain reply-to-bot activation", async () => {
    const botReplyId = `bot-reply-in-human-thread-${++sequence}`;
    const { deps } = createMessageHandlerDeps({
      channels: {
        msteams: {
          groupPolicy: "open",
          requireMention: true,
          requireMentionInBotThreads: false,
        },
      },
    });
    const sendActivity = vi.fn(async () => ({ id: botReplyId }));
    const sentIds = await sendMSTeamsMessages({
      replyStyle: "thread",
      app: deps.app,
      conversationRef: {
        agent: { id: "bot-id" },
        conversation: {
          id: `${channelConversationId};messageid=human-thread-root`,
          conversationType: "channel",
        },
        threadId: "human-thread-root",
      },
      context: { sendActivity },
      messages: [{ text: "Bot reply inside a human thread" }],
      onMessageSent: (messageId) => recordMSTeamsSentMessage(channelConversationId, messageId),
    });
    expect(sentIds).toEqual([botReplyId]);
    expect(sendActivity).toHaveBeenCalledTimes(1);

    const handler = createMSTeamsMessageHandler(deps);
    await handler(incoming({ replyToId: botReplyId }));

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "sender revoked", change: { groupAllowFrom: ["other-user-aad"] }, expected: 0 },
    { name: "group disabled", change: { groupPolicy: "disabled" as const }, expected: 0 },
    { name: "mention required", change: { requireMentionInBotThreads: true }, expected: 0 },
  ])(
    "uses current admission policy after ownership lookup: $name",
    async ({ change, expected }) => {
      const rootId = `bot-thread-reread-${++sequence}`;
      const cfg: OpenClawConfig = {
        channels: {
          msteams: {
            groupPolicy: "allowlist",
            groupAllowFrom: ["user-aad"],
            requireMention: true,
            requireMentionInBotThreads: false,
          },
        },
      };
      setRuntimeConfigSnapshot(cfg);
      const { deps } = createMessageHandlerDeps(cfg);
      const handler = createMSTeamsMessageHandler(deps);
      await sendChannelMessage({ messageId: rootId });
      const lookup = sentMessages.wasMSTeamsMessageSentWithPersistence;
      vi.spyOn(sentMessages, "wasMSTeamsMessageSentWithPersistence").mockImplementationOnce(
        async (params) => {
          const owned = await lookup(params);
          setRuntimeConfigSnapshot({
            channels: { msteams: { ...cfg.channels?.msteams, ...change } },
          });
          return owned;
        },
      );

      await handler(incoming({ conversation: conversation(rootId) }));

      expect(dispatch).toHaveBeenCalledTimes(expected);
    },
  );

  it("does not combine another thread's text into an unmentioned bot-thread turn", async () => {
    const queued = createDeferred<void>();
    const queuedKeys = new Set<string>();
    let queuedCount = 0;
    let flushAndDrain = async () => {};
    const createDebouncer: typeof createInboundDebouncer = (options) => {
      const debouncer = createInboundDebouncer(options);
      flushAndDrain = async () => {
        await Promise.all([...queuedKeys].map((key) => debouncer.flushKey(key)));
        await debouncer.drain();
      };
      return {
        ...debouncer,
        enqueue: async (entry) => {
          await debouncer.enqueue(entry);
          const key = options.buildKey(entry);
          if (key) {
            queuedKeys.add(key);
          }
          if (++queuedCount === 2) {
            queued.resolve();
          }
        },
      };
    };
    const { deps } = createMessageHandlerDeps(
      {
        channels: {
          msteams: {
            groupPolicy: "open",
            requireMention: true,
            requireMentionInBotThreads: false,
          },
        },
      },
      { createInboundDebouncer: createDebouncer, resolveInboundDebounceMs: () => 100 },
    );
    const ownedRootId = `bot-thread-batch-${++sequence}`;
    await sendChannelMessage({ messageId: ownedRootId });
    const handler = createMSTeamsMessageHandler(deps);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const messages: Array<[string, string]> = [
      ["human-thread-root", "Unaddressed message in another thread"],
      [ownedRootId, "Follow-up in the bot's thread"],
    ];
    const handlers = messages.map(([rootId, text]) =>
      handler(incoming({ id: `batch-${rootId}`, text, conversation: conversation(rootId) })),
    );
    await queued.promise;
    await flushAndDrain();
    await Promise.all(handlers);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({ BodyForAgent: "Follow-up in the bot's thread" }),
      }),
    );
  });
});
