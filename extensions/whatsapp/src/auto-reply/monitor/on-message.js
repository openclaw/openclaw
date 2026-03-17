import { loadConfig } from "../../../../../src/config/config.js";
import { logVerbose } from "../../../../../src/globals.js";
import { resolveAgentRoute } from "../../../../../src/routing/resolve-route.js";
import { buildGroupHistoryKey } from "../../../../../src/routing/session-key.js";
import { normalizeE164 } from "../../../../../src/utils.js";
import { maybeBroadcastMessage } from "./broadcast.js";
import { applyGroupGating } from "./group-gating.js";
import { updateLastRouteInBackground } from "./last-route.js";
import { resolvePeerId } from "./peer.js";
import { processMessage } from "./process-message.js";
function createWebOnMessageHandler(params) {
  const processForRoute = async (msg, route, groupHistoryKey, opts) => processMessage({
    cfg: params.cfg,
    msg,
    route,
    groupHistoryKey,
    groupHistories: params.groupHistories,
    groupMemberNames: params.groupMemberNames,
    connectionId: params.connectionId,
    verbose: params.verbose,
    maxMediaBytes: params.maxMediaBytes,
    replyResolver: params.replyResolver,
    replyLogger: params.replyLogger,
    backgroundTasks: params.backgroundTasks,
    rememberSentText: params.echoTracker.rememberText,
    echoHas: params.echoTracker.has,
    echoForget: params.echoTracker.forget,
    buildCombinedEchoKey: params.echoTracker.buildCombinedKey,
    groupHistory: opts?.groupHistory,
    suppressGroupHistoryClear: opts?.suppressGroupHistoryClear
  });
  return async (msg) => {
    const conversationId = msg.conversationId ?? msg.from;
    const peerId = resolvePeerId(msg);
    const route = resolveAgentRoute({
      cfg: loadConfig(),
      channel: "whatsapp",
      accountId: msg.accountId,
      peer: {
        kind: msg.chatType === "group" ? "group" : "direct",
        id: peerId
      }
    });
    const groupHistoryKey = msg.chatType === "group" ? buildGroupHistoryKey({
      channel: "whatsapp",
      accountId: route.accountId,
      peerKind: "group",
      peerId
    }) : route.sessionKey;
    if (msg.from === msg.to) {
      logVerbose(`\u{1F4F1} Same-phone mode detected (from === to: ${msg.from})`);
    }
    if (params.echoTracker.has(msg.body)) {
      logVerbose("Skipping auto-reply: detected echo (message matches recently sent text)");
      params.echoTracker.forget(msg.body);
      return;
    }
    if (msg.chatType === "group") {
      const metaCtx = {
        From: msg.from,
        To: msg.to,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: msg.chatType,
        ConversationLabel: conversationId,
        GroupSubject: msg.groupSubject,
        SenderName: msg.senderName,
        SenderId: msg.senderJid?.trim() || msg.senderE164,
        SenderE164: msg.senderE164,
        Provider: "whatsapp",
        Surface: "whatsapp",
        OriginatingChannel: "whatsapp",
        OriginatingTo: conversationId
      };
      updateLastRouteInBackground({
        cfg: params.cfg,
        backgroundTasks: params.backgroundTasks,
        storeAgentId: route.agentId,
        sessionKey: route.sessionKey,
        channel: "whatsapp",
        to: conversationId,
        accountId: route.accountId,
        ctx: metaCtx,
        warn: params.replyLogger.warn.bind(params.replyLogger)
      });
      const gating = applyGroupGating({
        cfg: params.cfg,
        msg,
        conversationId,
        groupHistoryKey,
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        baseMentionConfig: params.baseMentionConfig,
        authDir: params.account.authDir,
        groupHistories: params.groupHistories,
        groupHistoryLimit: params.groupHistoryLimit,
        groupMemberNames: params.groupMemberNames,
        logVerbose,
        replyLogger: params.replyLogger
      });
      if (!gating.shouldProcess) {
        return;
      }
    } else {
      if (!msg.senderE164 && peerId && peerId.startsWith("+")) {
        msg.senderE164 = normalizeE164(peerId) ?? msg.senderE164;
      }
    }
    if (await maybeBroadcastMessage({
      cfg: params.cfg,
      msg,
      peerId,
      route,
      groupHistoryKey,
      groupHistories: params.groupHistories,
      processMessage: processForRoute
    })) {
      return;
    }
    await processForRoute(msg, route, groupHistoryKey);
  };
}
export {
  createWebOnMessageHandler
};
