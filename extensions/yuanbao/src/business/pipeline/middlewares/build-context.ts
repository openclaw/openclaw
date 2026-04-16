/**
 * 中间件：构建 FinalizedMsgContext
 *
 * 使用 SDK 官方 finalizeInboundContext 构建完整的入站上下文。
 * In group chat scenarios, historical context is also built.
 */

import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
} from "openclaw/plugin-sdk/reply-history";
import { chatHistories } from "../../messaging/chat-history.js";
import { YUANBAO_MARKDOWN_HINT } from "../../messaging/context.js";
import type { MiddlewareDescriptor } from "../types.js";

export const buildContext: MiddlewareDescriptor = {
  name: "build-context",
  handler: async (ctx, next) => {
    const {
      core,
      account,
      isGroup,
      fromAccount,
      senderNickname,
      groupCode,
      rewrittenBody,
      mediaPaths,
      mediaTypes,
      commandAuthorized,
      route,
      storePath,
      envelopeOptions,
      previousTimestamp,
      raw,
    } = ctx;

    if (!route || !storePath || !envelopeOptions) {
      ctx.log.error("[build-context] prerequisite middleware not ready");
      return;
    }
    const label = isGroup ? `group:${groupCode}` : `direct:${fromAccount}`;

    // 格式化信封
    const body = core.channel.reply.formatAgentEnvelope({
      channel: "YUANBAO",
      from: label,
      ...(isGroup ? { timestamp: new Date() } : {}),
      previousTimestamp,
      envelope: envelopeOptions,
      body: rewrittenBody,
    });

    // 群聊：构建历史上下文
    let combinedBody = body;
    let inboundHistory:
      | Array<{ sender: string | undefined; body: string; timestamp: number | undefined }>
      | undefined;

    if (isGroup && groupCode) {
      const { historyLimit } = account;

      combinedBody = buildPendingHistoryContextFromMap({
        historyMap: chatHistories,
        historyKey: groupCode,
        limit: historyLimit,
        currentMessage: body,
        formatEntry: (entry) =>
          core.channel.reply.formatAgentEnvelope({
            channel: "YUANBAO",
            from: `group:${groupCode}:${entry.sender}`,
            timestamp: entry.timestamp,
            body: entry.body,
            envelope: envelopeOptions,
          }),
      });

      inboundHistory =
        historyLimit > 0
          ? (chatHistories.get(groupCode) ?? []).map((entry) => ({
              sender: entry.sender,
              body: entry.body,
              timestamp: entry.timestamp,
            }))
          : undefined;
    }

    // 使用 SDK 官方 finalizeInboundContext
    ctx.ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: combinedBody,
      BodyForAgent: rewrittenBody,
      ...(isGroup ? { InboundHistory: inboundHistory } : {}),
      RawBody: rewrittenBody,
      CommandBody: rewrittenBody,
      From: `yuanbao:${label}`,
      To: `yuanbao:${label}`,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isGroup ? "group" : "direct",
      ConversationLabel: label,
      ...(isGroup && raw.group_name ? { GroupSubject: raw.group_name } : {}),
      SenderName: senderNickname || fromAccount,
      SenderId: fromAccount,
      Provider: "yuanbao",
      Surface: "yuanbao",
      MessageSid: raw.msg_id ?? String(raw.msg_seq ?? ""),
      TraceId: ctx.traceContext?.traceId,
      Traceparent: ctx.traceContext?.traceparent,
      SeqId: ctx.traceContext?.seqId,
      OriginatingChannel: "yuanbao",
      OriginatingTo: `yuanbao:${label}`,
      CommandAuthorized: commandAuthorized,
      ...(account.markdownHintEnabled && { GroupSystemPrompt: YUANBAO_MARKDOWN_HINT }),
      ...(mediaPaths.length > 0 && { MediaPaths: mediaPaths, MediaPath: mediaPaths[0] }),
      ...(mediaTypes.length > 0 && { MediaTypes: mediaTypes, MediaType: mediaTypes[0] }),
      ...(ctx.linkUrls.length > 0 && { LinkUnderstanding: [...new Set(ctx.linkUrls)] }),
    });

    await next();

    // 群聊：AI 回复完成后清空已消费的群聊历史
    if (isGroup && groupCode) {
      clearHistoryEntriesIfEnabled({
        historyMap: chatHistories,
        historyKey: groupCode,
        limit: account.historyLimit,
      });
    }
  },
};
