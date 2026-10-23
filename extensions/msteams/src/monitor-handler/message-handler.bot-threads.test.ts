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
  createDebounceControl,
  createMessageHandlerDeps,
  createTurnContext,
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
  const serviceUrl = "https://smba.trafficmanager.net/amer";
  const app = { api: { serviceUrl, conversations: { activities } } };
  await sendMSTeamsActivityWithReference(
    app as unknown as MSTeamsApp,
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

function conversation(root: string) {
  return { id: `${channelConversationId};messageid=${root}`, conversationType: "channel" };
}
function setup(
  config: MSTeamsConfig = {},
  options: Parameters<typeof createMessageHandlerDeps>[1] = {},
) {
  const msteams: MSTeamsConfig = {
    groupPolicy: "open",
    requireMention: true,
    requireMentionInBotThreads: false,
    ...config,
  };
  const cfg: OpenClawConfig = { channels: { msteams } };
  const { deps } = createMessageHandlerDeps(cfg, options);
  const handler = createMSTeamsMessageHandler(deps);
  const handle = (input: Partial<MSTeamsTurnContext["activity"]>) =>
    handler(
      createTurnContext(buildChannelActivity({ id: `reply-${sequence}`, entities: [], ...input })),
    );
  return { cfg, deps, handle };
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
    ["proactive reply is not a root", true, "bot-id", channelConversationId],
    ["another bot's root", false, "other-bot", channelConversationId],
    ["another channel's root", false, "bot-id", "19:other@thread.tacv2"],
  ] as const)("%s", async (_name, threaded, botId, conversationId) => {
    const rootId = `bot-thread-root-${++sequence}`;
    const config: MSTeamsConfig = {
      requireMentionInBotThreads: true,
      teams: {
        "team-1": {
          requireMentionInBotThreads: false,
          channels: { [channelConversationId]: {} },
        },
      },
    };
    const { cfg, handle } = setup(config);
    MSTeamsConfigSchema.parse(cfg.channels?.msteams);
    const destination = await sendChannelMessage({
      messageId: rootId,
      botId,
      conversationId: `${conversationId};messageid=stale-source-thread`,
      threadActivityId: threaded ? "human-thread-root" : undefined,
    });
    expect(destination).toBe(
      threaded ? `${conversationId};messageid=human-thread-root` : conversationId,
    );
    await handle({ conversation: conversation(rootId), replyToId: "human-nested-reply" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("live thread replies retain reply-to-bot activation", async () => {
    const botReplyId = `bot-reply-in-human-thread-${++sequence}`;
    const { deps, handle } = setup();
    const sendActivity = vi.fn(async () => ({ id: botReplyId }));
    const sentIds = await sendMSTeamsMessages({
      replyStyle: "thread",
      app: deps.app,
      conversationRef: {
        agent: { id: "bot-id" },
        conversation: conversation("human-thread-root"),
        threadId: "human-thread-root",
      },
      context: { sendActivity },
      messages: [{ text: "Bot reply inside a human thread" }],
      onMessageSent: (messageId) => recordMSTeamsSentMessage(channelConversationId, messageId),
    });
    expect(sentIds).toEqual([botReplyId]);
    expect(sendActivity).toHaveBeenCalledTimes(1);
    await handle({ replyToId: botReplyId });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "sender revoked", change: { groupAllowFrom: ["other-user-aad"] } },
    { name: "group disabled", change: { groupPolicy: "disabled" as const } },
    { name: "mention required", change: { requireMentionInBotThreads: true } },
  ])("uses current admission policy after ownership lookup: $name", async ({ change }) => {
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
    await handler(
      createTurnContext(
        buildChannelActivity({
          id: `reply-${sequence}`,
          entities: [],
          conversation: conversation(rootId),
        }),
      ),
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not combine another thread's text into an unmentioned bot-thread turn", async () => {
    const clock = createDebounceControl();
    const { handle } = setup(
      {},
      { createInboundDebouncer: clock.createDebouncer, resolveInboundDebounceMs: () => 100 },
    );
    const ownedRootId = `bot-thread-batch-${++sequence}`;
    await sendChannelMessage({ messageId: ownedRootId });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const messages: Array<[string, string]> = [
      ["human-thread-root", "Unaddressed message in another thread"],
      [ownedRootId, "Follow-up in the bot's thread"],
    ];
    await Promise.all(
      messages.map(([rootId, text]) =>
        handle({ id: `batch-${rootId}`, text, conversation: conversation(rootId) }),
      ),
    );
    await clock.flush(100);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0].ctx.BodyForAgent).toBe("Follow-up in the bot's thread");
  });
});
