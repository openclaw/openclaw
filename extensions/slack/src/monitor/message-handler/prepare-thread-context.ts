import { formatInboundEnvelope } from "openclaw/plugin-sdk/channel-inbound";
import { readSessionUpdatedAt } from "openclaw/plugin-sdk/config-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import { resolveSlackUserAllowed } from "../allow-list.js";
import type { SlackMonitorContext } from "../context.js";
import {
  resolveSlackMedia,
  resolveSlackThreadHistory,
  type SlackMediaResult,
  type SlackThreadStarter,
} from "../media.js";

export type SlackThreadContextData = {
  threadStarterBody: string | undefined;
  threadHistoryBody: string | undefined;
  threadSessionPreviousTimestamp: number | undefined;
  threadLabel: string | undefined;
  threadStarterMedia: SlackMediaResult[] | null;
};

type SlackThreadContextSender = {
  userId?: string;
  botId?: string;
};

function isSlackThreadContextSenderAllowed(params: {
  sender: SlackThreadContextSender;
  senderName?: string;
  allowFromLower: string[];
  channelUsers?: Array<string | number>;
  allowNameMatching: boolean;
}): boolean {
  const hasSenderAllowlist =
    params.allowFromLower.length > 0 || (params.channelUsers?.length ?? 0) > 0;
  if (!hasSenderAllowlist) {
    return true;
  }
  if (params.sender.botId) {
    return true;
  }
  if (!params.sender.userId) {
    return false;
  }
  const allowedByOwnerAllowlist = resolveSlackUserAllowed({
    allowList: params.allowFromLower,
    userId: params.sender.userId,
    userName: params.senderName,
    allowNameMatching: params.allowNameMatching,
  });
  if (!allowedByOwnerAllowlist) {
    return false;
  }
  return resolveSlackUserAllowed({
    allowList: params.channelUsers,
    userId: params.sender.userId,
    userName: params.senderName,
    allowNameMatching: params.allowNameMatching,
  });
}

export async function resolveSlackThreadContextData(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  allowFromLower: string[];
  allowNameMatching: boolean;
  channelUsers?: Array<string | number>;
  isThreadReply: boolean;
  threadTs: string | undefined;
  threadStarter: SlackThreadStarter | null;
  roomLabel: string;
  storePath: string;
  sessionKey: string;
  envelopeOptions: ReturnType<
    typeof import("openclaw/plugin-sdk/channel-inbound").resolveEnvelopeFormatOptions
  >;
  effectiveDirectMedia: SlackMediaResult[] | null;
}): Promise<SlackThreadContextData> {
  let threadStarterBody: string | undefined;
  let threadHistoryBody: string | undefined;
  let threadSessionPreviousTimestamp: number | undefined;
  let threadLabel: string | undefined;
  let threadStarterMedia: SlackMediaResult[] | null = null;

  if (!params.isThreadReply || !params.threadTs) {
    return {
      threadStarterBody,
      threadHistoryBody,
      threadSessionPreviousTimestamp,
      threadLabel,
      threadStarterMedia,
    };
  }

  const userMap = new Map<string, { name?: string }>();
  const resolveCachedUserName = async (id: string): Promise<{ name?: string }> => {
    const cached = userMap.get(id);
    if (cached) {
      return cached;
    }
    const user = await params.ctx.resolveUserName(id);
    const normalized = user ?? {};
    userMap.set(id, normalized);
    return normalized;
  };

  const starter = params.threadStarter;
  const hasSenderAllowlist =
    params.allowFromLower.length > 0 || (params.channelUsers?.length ?? 0) > 0;
  const starterSenderName =
    starter?.userId && params.allowNameMatching && hasSenderAllowlist
      ? (await resolveCachedUserName(starter.userId)).name
      : undefined;
  const starterAllowed = starter
    ? isSlackThreadContextSenderAllowed({
        sender: { userId: starter.userId, botId: starter.botId },
        senderName: starterSenderName,
        allowFromLower: params.allowFromLower,
        channelUsers: params.channelUsers,
        allowNameMatching: params.allowNameMatching,
      })
    : false;
  if (starter?.text && starterAllowed) {
    threadStarterBody = starter.text;
    const snippet = starter.text.replace(/\s+/g, " ").slice(0, 80);
    threadLabel = `Slack thread ${params.roomLabel}${snippet ? `: ${snippet}` : ""}`;
    if (!params.effectiveDirectMedia && starter.files && starter.files.length > 0) {
      threadStarterMedia = await resolveSlackMedia({
        files: starter.files,
        token: params.ctx.botToken,
        maxBytes: params.ctx.mediaMaxBytes,
      });
      if (threadStarterMedia) {
        const starterPlaceholders = threadStarterMedia.map((item) => item.placeholder).join(", ");
        logVerbose(`slack: hydrated thread starter file ${starterPlaceholders} from root message`);
      }
    }
  } else {
    threadLabel = `Slack thread ${params.roomLabel}`;
  }

  const threadInitialHistoryLimit = params.account.config?.thread?.initialHistoryLimit ?? 20;
  threadSessionPreviousTimestamp = readSessionUpdatedAt({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
  });

  if (threadInitialHistoryLimit > 0 && !threadSessionPreviousTimestamp) {
    const threadHistory = await resolveSlackThreadHistory({
      channelId: params.message.channel,
      threadTs: params.threadTs,
      client: params.ctx.app.client,
      currentMessageTs: params.message.ts,
      limit: threadInitialHistoryLimit,
    });

    if (threadHistory.length > 0) {
      const uniqueUserIds = [
        ...new Set(
          threadHistory.map((item) => item.userId).filter((id): id is string => Boolean(id)),
        ),
      ];
      await Promise.all(
        uniqueUserIds.map(async (id) => {
          await resolveCachedUserName(id);
        }),
      );

      const filteredHistory = threadHistory.filter((historyMsg) =>
        isSlackThreadContextSenderAllowed({
          sender: historyMsg,
          senderName: historyMsg.userId ? userMap.get(historyMsg.userId)?.name : undefined,
          allowFromLower: params.allowFromLower,
          channelUsers: params.channelUsers,
          allowNameMatching: params.allowNameMatching,
        }),
      );

      const historyParts: string[] = [];
      for (const historyMsg of filteredHistory) {
        const msgUser = historyMsg.userId ? userMap.get(historyMsg.userId) : null;
        const msgSenderName =
          msgUser?.name ?? (historyMsg.botId ? `Bot (${historyMsg.botId})` : "Unknown");
        const isBot = Boolean(historyMsg.botId);
        const role = isBot ? "assistant" : "user";
        const msgWithId = `${historyMsg.text}\n[slack message id: ${historyMsg.ts ?? "unknown"} channel: ${params.message.channel}]`;
        historyParts.push(
          formatInboundEnvelope({
            channel: "Slack",
            from: `${msgSenderName} (${role})`,
            timestamp: historyMsg.ts ? Math.round(Number(historyMsg.ts) * 1000) : undefined,
            body: msgWithId,
            chatType: "channel",
            envelope: params.envelopeOptions,
          }),
        );
      }
      if (historyParts.length > 0) {
        threadHistoryBody = historyParts.join("\n\n");
      }
      const dropped = threadHistory.length - filteredHistory.length;
      if (dropped > 0) {
        logVerbose(`slack: dropped ${dropped} thread history messages due to sender allowlists`);
      }
      if (filteredHistory.length > 0) {
        logVerbose(
          `slack: populated thread history with ${filteredHistory.length} messages for new session`,
        );
      }
    }
  }

  return {
    threadStarterBody,
    threadHistoryBody,
    threadSessionPreviousTimestamp,
    threadLabel,
    threadStarterMedia,
  };
}
