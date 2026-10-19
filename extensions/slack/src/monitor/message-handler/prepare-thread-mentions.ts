import {
  implicitMentionKindWhen,
  resolveBotThreadMentionPolicy,
} from "openclaw/plugin-sdk/channel-mention-gating";
import type { FinalizedMsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedSlackAccount } from "../../accounts.js";
import { hasSlackThreadParticipationWithPersistence } from "../../sent-thread-cache.js";
import type { SlackMessageEvent } from "../../types.js";
import type { SlackChannelConfigResolved } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackThreadStarter } from "../thread.js";
import { isSlackThreadAuthorCurrentBot } from "./prepare-thread-context-root.js";

export async function resolveSlackThreadMentionPolicy(params: {
  ctx: Pick<SlackMonitorContext, "botUserId" | "botId" | "defaultRequireMention">;
  account: Pick<ResolvedSlackAccount, "accountId" | "config">;
  message: SlackMessageEvent;
  conversation: {
    isRoom: boolean;
    isDirectMessage: boolean;
    channelConfig: SlackChannelConfigResolved | null;
  };
  thread: { isThreadReply: boolean; threadTs?: string };
  wasMentioned: boolean;
  teamId?: string;
  getThreadStarter: () => Promise<SlackThreadStarter | null>;
}): Promise<ReturnType<typeof resolveBotThreadMentionPolicy>> {
  const { ctx, account, message, conversation, thread } = params;
  const { isRoom, isDirectMessage, channelConfig } = conversation;
  let implicitMentionKinds: ReturnType<typeof implicitMentionKindWhen> = [];
  if (!isDirectMessage && message.thread_ts && !params.wasMentioned) {
    const replyToBotKinds = implicitMentionKindWhen(
      "reply_to_bot",
      Boolean(ctx.botUserId && message.parent_user_id === ctx.botUserId),
    );
    implicitMentionKinds =
      replyToBotKinds.length > 0
        ? replyToBotKinds
        : implicitMentionKindWhen(
            "bot_thread_participant",
            await hasSlackThreadParticipationWithPersistence({
              accountId: account.accountId,
              channelId: message.channel,
              threadTs: message.thread_ts,
              teamId: params.teamId,
            }),
          );
  }

  const requireMentionInBotThreads =
    channelConfig?.requireMentionInBotThreads ?? account.config.requireMentionInBotThreads;
  let isBotOwnedThread = false;
  if (isRoom && thread.isThreadReply && requireMentionInBotThreads !== undefined) {
    const parentUserId = normalizeOptionalString(message.parent_user_id);
    if (parentUserId) {
      isBotOwnedThread = Boolean(ctx.botUserId && parentUserId === ctx.botUserId);
    } else {
      const starter = await params.getThreadStarter();
      isBotOwnedThread = Boolean(
        starter &&
        starter.ts === thread.threadTs &&
        isSlackThreadAuthorCurrentBot({ identity: ctx, author: starter }),
      );
    }
  }
  return resolveBotThreadMentionPolicy({
    isBotOwnedThread,
    requireMentionInBotThreads,
    requireMention: isRoom ? (channelConfig?.requireMention ?? ctx.defaultRequireMention) : false,
    implicitMentionKinds,
  });
}

export function resolveSlackMentionSource(params: {
  explicitBotMention: boolean;
  explicitSubteamMention: boolean;
  matchedImplicitMentionKinds: readonly string[];
  shouldBypassMention: boolean;
  wasMentioned: boolean;
}): NonNullable<FinalizedMsgContext["MentionSource"]> {
  if (params.explicitBotMention) {
    return "explicit_bot";
  }
  if (params.explicitSubteamMention) {
    return "subteam";
  }
  if (params.shouldBypassMention) {
    return "command_bypass";
  }
  if (params.wasMentioned) {
    return "mention_pattern";
  }
  if (params.matchedImplicitMentionKinds.length > 0) {
    return "implicit_thread";
  }
  return "none";
}
