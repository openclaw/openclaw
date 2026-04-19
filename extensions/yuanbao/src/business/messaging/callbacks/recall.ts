/**
 * Message recall system callback.
 *
 * Group: if message is still in chatHistories, delete directly (not consumed by AI);
 *        otherwise enqueueSystemEvent to notify AI.
 * C2C: no history, directly enqueueSystemEvent.
 */

import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createLog } from "../../../logger.js";
import type { YuanbaoInboundMessage } from "../../../types.js";
import { chatHistories } from "../chat-history.js";
import type { MessageHandlerContext } from "../context.js";

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

/**
 * Handle group message recall callback (Group.CallbackAfterRecallMsg).
 *
 * If the recalled message is still in chatHistories, it hasn't entered AI context yet —
 * delete it locally. Otherwise inject a system event to inform AI.
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
      log.info(`[recall] group message ${messageId} removed from history (not consumed by AI)`, { groupCode });
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
 * Handle C2C message recall callback (C2C.CallbackAfterRecallMsg).
 *
 * C2C has no chatHistories like group chat; always inject a system event.
 */
export function handleC2CRecall(ctx: MessageHandlerContext, msg: YuanbaoInboundMessage): void {
  const { core, account } = ctx;
  const log = createLog("recall", ctx.log);
  const fromAccount = msg.from_account?.trim() || "unknown";

  // C2C recall target is in msgId
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
