import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuMediaList } from "./bot-content.js";
import { createFeishuClient } from "./client.js";
import type { FeishuMessageEvent } from "./event-types.js";
import {
  buildFeishuFetchedContextPolicy,
  shouldIncludeFetchedGroupContextMessage,
} from "./policy.js";
import type { FeishuMediaInfo, FeishuMessageContext, ResolvedFeishuAccount } from "./types.js";

/** Max images attached by one lookback, matching the cap enforced before download. */
const MAX_LOOKBACK_IMAGES = 5;

/**
 * Resolve media for the current message, and when @-mentioned in a group
 * but the @ message itself carries no image, attach image messages among
 * the most recent group messages so the model can see screenshots the user
 * sent before @-mentioning the bot (image-first-@-later), however much
 * later. Returns at most 5 lookback images; failures only log.
 *
 * The lookback reuses the same fetched-context visibility rule as quoted
 * and thread context (#58237): a candidate is only attached when
 * shouldIncludeFetchedGroupContextMessage(kind="history") allows its
 * sender, using the policy built by buildFeishuFetchedContextPolicy.
 * In topic groups it stays inside the triggering topic, and it
 * never attaches messages created after the triggering @.
 */
export async function resolveFeishuMediaListWithLookback(params: {
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
  ctx: Pick<
    FeishuMessageContext,
    "chatId" | "messageId" | "mentionedBot" | "chatType" | "threadId" | "rootId"
  >;
  event: FeishuMessageEvent;
  mediaMaxBytes: number;
  log: (msg: string) => void;
  isGroup: boolean;
}): Promise<FeishuMediaInfo[]> {
  const { cfg, account, ctx, event, mediaMaxBytes, log, isGroup } = params;
  const mediaList = await resolveFeishuMediaList({
    cfg,
    messageId: ctx.messageId,
    messageType: event.message.message_type,
    content: event.message.content,
    maxBytes: mediaMaxBytes,
    log,
    accountId: account.accountId,
  });
  if (!isGroup || !ctx.mentionedBot || mediaList.length > 0) {
    return mediaList;
  }
  // Topic groups scope sessions to one topic; without the triggering topic
  // id there is no safe scope, so skip the lookback rather than leak
  // another topic's images.
  const topicScopeId = ctx.chatType === "topic_group" ? (ctx.threadId ?? ctx.rootId) : undefined;
  if (ctx.chatType === "topic_group" && !topicScopeId) {
    log(`feishu[${account.accountId}]: skipping recent group image lookback: topic scope unknown`);
    return mediaList;
  }
  // Upper bound: only messages created at or before the triggering @.
  // The trigger always carries create_time in production; without it the
  // bound cannot be established, so fall back to the previous behavior.
  const triggerCreateTime = parseStrictNonNegativeInteger(event.message.create_time);
  const fetchedContextPolicy = buildFeishuFetchedContextPolicy({
    cfg,
    accountId: account.accountId,
    chatId: ctx.chatId,
    isGroup,
    feishuCfg: account.config,
  });
  try {
    const listResponse = await createFeishuClient(account).im.message.list({
      params: {
        container_id_type: "chat",
        container_id: ctx.chatId,
        sort_type: "ByCreateTimeDesc",
        page_size: 20,
      },
    });
    if (listResponse?.code === 0) {
      for (const item of listResponse.data?.items ?? []) {
        if (mediaList.length >= MAX_LOOKBACK_IMAGES) {
          break;
        }
        if (item.message_id === ctx.messageId) {
          continue;
        }
        if (item.msg_type !== "image" && item.msg_type !== "post") {
          continue;
        }
        if (triggerCreateTime !== undefined) {
          const itemCreateTime = parseStrictNonNegativeInteger(item.create_time);
          if (itemCreateTime === undefined || itemCreateTime > triggerCreateTime) {
            continue;
          }
        }
        if (topicScopeId && item.thread_id !== topicScopeId && item.root_id !== topicScopeId) {
          continue;
        }
        if (
          !(await shouldIncludeFetchedGroupContextMessage({
            ...fetchedContextPolicy,
            kind: "history",
            senderId: item.sender?.id,
            senderType: item.sender?.sender_type,
          }))
        ) {
          log(
            `feishu[${account.accountId}]: skipped recent image from sender ${item.sender?.id ?? "unknown"} (mode=${fetchedContextPolicy.mode})`,
          );
          continue;
        }
        const remaining = MAX_LOOKBACK_IMAGES - mediaList.length;
        const extra = await resolveFeishuMediaList({
          cfg,
          messageId: item.message_id ?? "",
          messageType: item.msg_type,
          content: item.body?.content ?? "",
          maxBytes: mediaMaxBytes,
          log,
          accountId: account.accountId,
          ...(item.msg_type === "post"
            ? { allowedKinds: ["image" as const], maxItems: remaining }
            : {}),
        });
        mediaList.push(...extra);
      }
      if (mediaList.length > 0) {
        log(
          `feishu[${account.accountId}]: attached ${mediaList.length} recent group image(s) to @-mention`,
        );
      }
    }
  } catch (err) {
    log(`feishu[${account.accountId}]: recent group image lookback failed: ${String(err)}`);
  }
  return mediaList;
}
