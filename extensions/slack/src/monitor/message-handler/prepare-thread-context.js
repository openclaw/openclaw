import { formatInboundEnvelope } from "../../../../../src/auto-reply/envelope.js";
import { readSessionUpdatedAt } from "../../../../../src/config/sessions.js";
import { logVerbose } from "../../../../../src/globals.js";
import {
  resolveSlackMedia,
  resolveSlackThreadHistory
} from "../media.js";
async function resolveSlackThreadContextData(params) {
  let threadStarterBody;
  let threadHistoryBody;
  let threadSessionPreviousTimestamp;
  let threadLabel;
  let threadStarterMedia = null;
  if (!params.isThreadReply || !params.threadTs) {
    return {
      threadStarterBody,
      threadHistoryBody,
      threadSessionPreviousTimestamp,
      threadLabel,
      threadStarterMedia
    };
  }
  const starter = params.threadStarter;
  if (starter?.text) {
    threadStarterBody = starter.text;
    const snippet = starter.text.replace(/\s+/g, " ").slice(0, 80);
    threadLabel = `Slack thread ${params.roomLabel}${snippet ? `: ${snippet}` : ""}`;
    if (!params.effectiveDirectMedia && starter.files && starter.files.length > 0) {
      threadStarterMedia = await resolveSlackMedia({
        files: starter.files,
        token: params.ctx.botToken,
        maxBytes: params.ctx.mediaMaxBytes
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
    sessionKey: params.sessionKey
  });
  if (threadInitialHistoryLimit > 0 && !threadSessionPreviousTimestamp) {
    const threadHistory = await resolveSlackThreadHistory({
      channelId: params.message.channel,
      threadTs: params.threadTs,
      client: params.ctx.app.client,
      currentMessageTs: params.message.ts,
      limit: threadInitialHistoryLimit
    });
    if (threadHistory.length > 0) {
      const uniqueUserIds = [
        ...new Set(
          threadHistory.map((item) => item.userId).filter((id) => Boolean(id))
        )
      ];
      const userMap = /* @__PURE__ */ new Map();
      await Promise.all(
        uniqueUserIds.map(async (id) => {
          const user = await params.ctx.resolveUserName(id);
          if (user) {
            userMap.set(id, user);
          }
        })
      );
      const historyParts = [];
      for (const historyMsg of threadHistory) {
        const msgUser = historyMsg.userId ? userMap.get(historyMsg.userId) : null;
        const msgSenderName = msgUser?.name ?? (historyMsg.botId ? `Bot (${historyMsg.botId})` : "Unknown");
        const isBot = Boolean(historyMsg.botId);
        const role = isBot ? "assistant" : "user";
        const msgWithId = `${historyMsg.text}
[slack message id: ${historyMsg.ts ?? "unknown"} channel: ${params.message.channel}]`;
        historyParts.push(
          formatInboundEnvelope({
            channel: "Slack",
            from: `${msgSenderName} (${role})`,
            timestamp: historyMsg.ts ? Math.round(Number(historyMsg.ts) * 1e3) : void 0,
            body: msgWithId,
            chatType: "channel",
            envelope: params.envelopeOptions
          })
        );
      }
      threadHistoryBody = historyParts.join("\n\n");
      logVerbose(
        `slack: populated thread history with ${threadHistory.length} messages for new session`
      );
    }
  }
  return {
    threadStarterBody,
    threadHistoryBody,
    threadSessionPreviousTimestamp,
    threadLabel,
    threadStarterMedia
  };
}
export {
  resolveSlackThreadContextData
};
