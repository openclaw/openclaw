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

const runtimeApiMockState = getRuntimeApiMockState();
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

describe("Teams mention policy in bot-created channel threads", () => {
  beforeEach(() => {
    runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mockClear();
  });
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    { name: "global opt-out", global: false, expected: 1 },
    { name: "classic thread root", global: false, explicitRoot: true, expected: 1 },
    { name: "nested reply under owned root", global: false, nestedReply: true, expected: 1 },
    {
      name: "proactive reply is not a root",
      global: false,
      explicitRoot: true,
      threadedSend: true,
      expected: 0,
    },
    {
      name: "prefilled source sent inside thread",
      global: false,
      explicitRoot: true,
      threadedSend: true,
      prefilledSource: true,
      expected: 0,
    },
    {
      name: "prefilled source sent as new top-level post",
      global: false,
      prefilledSource: true,
      expected: 1,
    },
    { name: "omitted option", expected: 0 },
    { name: "explicit opt-in", global: true, legacyReply: true, expected: 0 },
    { name: "explicit mention", global: true, mentioned: true, expected: 1 },
    { name: "team override", global: true, team: false, expected: 1 },
    { name: "channel override", global: false, team: false, channel: true, expected: 0 },
    { name: "channel opt-out", global: true, team: true, channel: false, expected: 1 },
    { name: "unknown root", global: false, untracked: true, expected: 0 },
    { name: "other bot's root", global: false, botId: "other-bot", expected: 0 },
    { name: "other channel's root", global: false, otherChannel: true, expected: 0 },
    { name: "parent-channel message", global: false, topLevel: true, expected: 0 },
    { name: "group-chat quote", global: false, groupChat: true, expected: 0 },
    { name: "blocked sender", global: false, blockedSender: true, expected: 0 },
    { name: "disabled group policy", global: false, disabled: true, expected: 0 },
    { name: "expired ownership", global: false, expired: true, expected: 0 },
  ])("$name", async (testCase) => {
    const rootId = `bot-thread-root-${++sequence}`;
    const config: MSTeamsConfig = {
      groupPolicy: testCase.disabled ? "disabled" : testCase.blockedSender ? "allowlist" : "open",
      ...(testCase.blockedSender ? { groupAllowFrom: ["other-user-aad"] } : {}),
      requireMention: true,
      ...(testCase.global === undefined ? {} : { requireMentionInBotThreads: testCase.global }),
      teams: {
        "team-1": {
          ...(testCase.team === undefined ? {} : { requireMentionInBotThreads: testCase.team }),
          channels: {
            [channelConversationId]:
              testCase.channel === undefined
                ? {}
                : { requireMentionInBotThreads: testCase.channel },
          },
        },
      },
    };
    MSTeamsConfigSchema.parse(config);
    const { deps } = createMessageHandlerDeps({ channels: { msteams: config } });
    if (!testCase.untracked) {
      const clock = testCase.expired
        ? vi.spyOn(Date, "now").mockReturnValue(Date.now() - 25 * 60 * 60 * 1000)
        : undefined;
      try {
        const sentConversationId = await sendChannelMessage({
          messageId: rootId,
          botId: testCase.botId,
          conversationId: testCase.otherChannel
            ? "19:other@thread.tacv2"
            : testCase.prefilledSource
              ? `${channelConversationId};messageid=stale-source-thread`
              : undefined,
          threadActivityId: testCase.threadedSend ? "human-thread-root" : undefined,
        });
        if (testCase.prefilledSource || testCase.threadedSend) {
          expect(sentConversationId).toBe(
            testCase.threadedSend
              ? `${channelConversationId};messageid=human-thread-root`
              : channelConversationId,
          );
        }
      } finally {
        clock?.mockRestore();
      }
    }
    if (testCase.legacyReply) {
      recordMSTeamsSentMessage(channelConversationId, rootId);
    }
    const handler = createMSTeamsMessageHandler(deps);
    await handler({
      activity: buildChannelActivity({
        id: `thread-reply-${sequence}`,
        conversation: {
          id:
            testCase.topLevel || testCase.explicitRoot
              ? channelConversationId
              : `${channelConversationId};messageid=${rootId}`,
          conversationType: testCase.groupChat ? "groupChat" : "channel",
        },
        ...(testCase.legacyReply || testCase.explicitRoot
          ? { replyToId: rootId }
          : testCase.nestedReply
            ? { replyToId: "human-nested-reply" }
            : {}),
        entities: testCase.mentioned ? [{ type: "mention", mentioned: { id: "bot-id" } }] : [],
      }),
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    expect(runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(
      testCase.expected,
    );
  });

  it.each([
    { legacyReply: false, expected: 0 },
    { legacyReply: true, expected: 1 },
  ])(
    "live thread replies retain only existing reply-to-bot activation: $legacyReply",
    async ({ legacyReply, expected }) => {
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
        appId: deps.appId,
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
        onMessageSent: legacyReply
          ? (messageId) => recordMSTeamsSentMessage(channelConversationId, messageId)
          : undefined,
      });
      expect(sentIds).toEqual([botReplyId]);
      expect(sendActivity).toHaveBeenCalledTimes(1);

      const handler = createMSTeamsMessageHandler(deps);
      await handler({
        activity: buildChannelActivity({
          id: `followup-${sequence}`,
          replyToId: botReplyId,
          entities: [],
        }),
        sendActivity: vi.fn(async () => undefined),
      } as unknown as Parameters<typeof handler>[0]);

      expect(runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(
        expected,
      );
    },
  );

  it.each([
    { name: "sender revoked", change: { groupAllowFrom: ["other-user-aad"] }, expected: 0 },
    { name: "group disabled", change: { groupPolicy: "disabled" as const }, expected: 0 },
    { name: "mention required", change: { requireMentionInBotThreads: true }, expected: 0 },
    { name: "unrelated setting", change: { historyLimit: 1 }, expected: 1 },
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

      await handler({
        activity: buildChannelActivity({
          id: `reread-reply-${sequence}`,
          conversation: {
            id: `${channelConversationId};messageid=${rootId}`,
            conversationType: "channel",
          },
          entities: [],
        }),
        sendActivity: vi.fn(async () => undefined),
      } as unknown as Parameters<typeof handler>[0]);

      expect(runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(
        expected,
      );
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
    const handlers = [
      ["human-thread-root", "Unaddressed message in another thread"],
      [ownedRootId, "Follow-up in the bot's thread"],
    ].map(([rootId, text]) =>
      handler({
        activity: buildChannelActivity({
          id: `batch-${rootId}`,
          text,
          conversation: {
            id: `${channelConversationId};messageid=${rootId}`,
            conversationType: "channel",
          },
          entities: [],
        }),
        sendActivity: vi.fn(async () => undefined),
      } as unknown as Parameters<typeof handler>[0]),
    );
    await queued.promise;
    await flushAndDrain();
    await Promise.all(handlers);
    const dispatch = runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher;
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({ BodyForAgent: "Follow-up in the bot's thread" }),
      }),
    );
  });
});
