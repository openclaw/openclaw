/**
 * Message recall system callback
 *
 * 注册 Group/C2C.CallbackAfterMsgWithDraw 的处理逻辑：
 *   - 群聊：消息仍在 chatHistories → 直接删除（未被 AI 消费，无需通知）
 *          消息已不在 history   → enqueueSystemEvent 通知 AI
 *   - C2C：无 history，直接 enqueueSystemEvent 通知 AI
 */

import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createLog } from "../../../logger.js";
import type { YuanbaoInboundMessage } from "../../../types.js";
import { chatHistories } from "../chat-history.js";
import type { MessageHandlerContext } from "../context.js";

// ============ 事件注入 ============

function enqueueRecallSystemEvent(params: {
  core: PluginRuntime;
  sessionKey: string;
  conversationId: string;
  where: string;
  messageId: string;
}): void {
  const { core, sessionKey, conversationId, messageId } = params;
  const eventText = [
    `[yuanbao] One historical user message was recalled; only message_id="${messageId}" is void (not necessarily the latest turn).`,
    "Do not quote or ground on it; ignore stale transcript for that id. Keep past assistant replies; no tool rollback.",
  ].join("\n");
  core.system.enqueueSystemEvent(eventText, {
    sessionKey,
    contextKey: `yuanbao:recall:${conversationId}:${messageId}`,
  });
}

// ============ 处理器 ============

/**
 * 处理群聊Message recall system callback（Group.CallbackAfterRecallMsg）。
 *
 * 若被Recall消息仍在 `chatHistories` 中，说明尚未进入 AI 上下文，直接从本地历史删除即可；
 * 否则通过 `enqueueSystemEvent` 告知 AI 勿再引用该条内容。
 *
 * @param ctx - Message processing context（含 core、账号、Route resolution等）
 * @param msg - 入站Message body，需含 `group_code`、`recall_msg_seq_list` 等Recall字段
 * @returns 无
 */
export function handleGroupRecall(ctx: MessageHandlerContext, msg: YuanbaoInboundMessage): void {
  const { core, account } = ctx;
  const log = createLog("recall", ctx.log);
  const groupCode = msg.group_code?.trim() || "unknown";

  const seqList = msg.recall_msg_seq_list;
  if (!seqList || seqList.length === 0) {
    log.warn("[recall] group msg_seq_list empty, skipping");
    return;
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: ctx.config,
    channel: "yuanbao",
    accountId: account.accountId,
    peer: { kind: "group", id: groupCode },
  });
  const where = msg.group_name ? `group "${msg.group_name}" (${groupCode})` : `group ${groupCode}`;

  for (const seq of seqList) {
    const messageId = seq.msg_id || String(seq.msg_seq ?? "");
    if (!messageId) {
      continue;
    }

    const history = chatHistories.get(groupCode);
    const idx = history ? history.findIndex((e) => e.messageId === messageId) : -1;

    if (history && idx !== -1) {
      history.splice(idx, 1);
      log.info(`[recall] 群消息 ${messageId} 已从 history 删除（未被 AI 消费）`, { groupCode });
    } else {
      log.info(`[recall] group message ${messageId} not in history, injecting system event`, {
        groupCode,
      });
      enqueueRecallSystemEvent({
        core,
        sessionKey: route.sessionKey,
        conversationId: groupCode,
        where,
        messageId,
      });
    }
  }
}

/**
 * 处理单聊（C2C）Message recall system callback（C2C.CallbackAfterRecallMsg）。
 *
 * 私聊侧无与群聊同构的 `chatHistories`，统一注入系统事件，让会话层放弃对已Recall消息的依赖。
 *
 * @param ctx - Message processing context（含 core、账号、Route resolution等）
 * @param msg - 入站Message body，Recall目标 ID 来自 `msg_id` / `msg_seq` 等字段
 * @returns 无
 */
export function handleC2CRecall(ctx: MessageHandlerContext, msg: YuanbaoInboundMessage): void {
  const { core, account } = ctx;
  const log = createLog("recall", ctx.log);
  const fromAccount = msg.from_account?.trim() || "unknown";

  // 私聊的在msgId里
  const seqList = msg.msg_id ? [{ msg_id: msg.msg_id, msg_seq: msg.msg_seq }] : [];
  if (!seqList || seqList.length === 0) {
    log.warn("[recall] c2c msg_seq_list empty, skipping");
    return;
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: ctx.config,
    channel: "yuanbao",
    accountId: account.accountId,
    peer: { kind: "direct", id: fromAccount },
  });

  for (const seq of seqList) {
    const messageId = seq.msg_id || String(seq.msg_seq ?? "");
    if (!messageId) {
      continue;
    }

    log.info(`[recall] C2C message ${messageId} recalled, injecting system event`, {
      fromAccount,
    });
    enqueueRecallSystemEvent({
      core,
      sessionKey: route.sessionKey,
      conversationId: fromAccount,
      where: `direct chat with ${fromAccount}`,
      messageId,
    });
  }
}
