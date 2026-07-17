// Qqbot plugin module implements gateway behavior.
import path from "node:path";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  classifyCoreCommandForGroup,
  PRIVATE_CHAT_ONLY_TEXT,
} from "../commands/command-visibility.js";
import { initCommands } from "../commands/slash-commands-impl.js";
import { resolveGroupCommandLevelFromAccountConfig } from "../config/group.js";
import type { HistoryEntry } from "../group/history.js";
import { claimMessageReply } from "../messaging/outbound-reply.js";
import { setOutboundAudioPort } from "../messaging/outbound.js";
import {
  clearTokenCache,
  initApiConfig,
  onMessageSent,
  sendInputNotify as senderSendInputNotify,
  accountToCreds,
  buildDeliveryTarget,
  sendText as senderSendText,
} from "../messaging/sender.js";
import { setRefIndex } from "../ref/store.js";
import { runDiagnostics } from "../utils/diagnostics.js";
import { runWithRequestContext } from "../utils/request-context.js";
import { createActiveCfgProvider } from "./active-cfg.js";
import { GatewayConnection } from "./gateway-connection.js";
import { buildInboundContext, clearGroupPendingHistory } from "./inbound-pipeline.js";
import { createInteractionHandler } from "./interaction-handler.js";
import type { QueuedMessage } from "./message-queue.js";
import { dispatchOutbound } from "./outbound-dispatch.js";
import type {
  CoreGatewayContext,
  GatewayAccount,
  EngineLogger,
  RefAttachmentSummary,
} from "./types.js";
import { TYPING_INPUT_SECOND } from "./typing-callbacks.js";

export type { CoreGatewayContext } from "./types.js";

export async function startGateway(ctx: CoreGatewayContext): Promise<void> {
  const { account, log, runtime, adapters } = ctx;

  setOutboundAudioPort(adapters.outboundAudio);
  initCommands(adapters.commands);

  if (!account.appId || !account.clientSecret) {
    throw new Error("QQBot not configured (missing appId or clientSecret)");
  }

  const diag = await runDiagnostics();
  if (diag.warnings.length > 0) {
    for (const w of diag.warnings) {
      log?.info(w);
    }
  }

  initApiConfig(account.appId, { markdownSupport: account.markdownSupport });
  log?.debug?.(`API config: markdownSupport=${account.markdownSupport}`);

  onMessageSent(account.appId, (refIdx, meta) => {
    log?.info(
      `onMessageSent called: refIdx=${refIdx}, mediaType=${meta.mediaType}, ttsText=${meta.ttsText === undefined ? undefined : truncateUtf16Safe(meta.ttsText, 30)}`,
    );
    const attachments: RefAttachmentSummary[] = [];
    if (meta.mediaType) {
      const localPath = meta.mediaLocalPath;
      const filename = localPath ? path.basename(localPath) : undefined;
      const attachment: RefAttachmentSummary = {
        type: meta.mediaType,
        ...(localPath ? { localPath } : {}),
        ...(filename ? { filename } : {}),
        ...(meta.mediaUrl ? { url: meta.mediaUrl } : {}),
      };
      if (meta.mediaType === "voice" && meta.ttsText) {
        attachment.transcript = meta.ttsText;
        attachment.transcriptSource = "tts";
      }
      attachments.push(attachment);
    }
    setRefIndex(refIdx, {
      content: meta.text ?? "",
      senderId: account.accountId,
      senderName: account.accountId,
      timestamp: Date.now(),
      isBot: true,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
  });

  const groupOpts = {
    enabled: ctx.group?.enabled ?? true,
    allowTextCommands: ctx.group?.allowTextCommands,
    isControlCommand: ctx.group?.isControlCommand,
    resolveIntroHint: ctx.group?.resolveIntroHint,
  };
  const groupChatEnabled = groupOpts.enabled;
  const groupHistories: Map<string, HistoryEntry[]> | undefined = groupChatEnabled
    ? new Map()
    : undefined;
  // Live config provider: per-inbound lookup so binding edits applied
  // through the CLI take effect without a gateway restart (#69546).
  const activeCfgProvider = createActiveCfgProvider({ fallback: ctx.cfg });

  // ---- 7. Message handler ----
  const handleMessage = async (event: QueuedMessage): Promise<void> => {
    log?.info(`Processing message from ${event.senderId}: ${event.content}`, {
      accountId: account.accountId,
      messageId: event.messageId,
      senderId: event.senderId,
      type: event.type,
      groupOpenid: event.groupOpenid,
    });

    runtime.channel.activity.record({
      channel: "qqbot",
      accountId: account.accountId,
      direction: "inbound",
    });

    const activeCfg = activeCfgProvider.getActiveCfg();

    const inbound = await buildInboundContext(event, {
      account,
      cfg: activeCfg,
      log,
      runtime,
      startTyping: (ev) => startTypingForEvent(ev, account, log),
      groupHistories,
      allowTextCommands: groupOpts.allowTextCommands,
      isControlCommand: groupOpts.isControlCommand,
      resolveGroupIntroHint: groupOpts.resolveIntroHint,
      adapters,
    });

    if (inbound.blocked) {
      log?.info(`Dropped inbound qqbot message: ${inbound.blockReason ?? "blocked by allowFrom"}`, {
        accountId: account.accountId,
        messageId: event.messageId,
        blockReason: inbound.blockReason,
      });
      return;
    }

    if (inbound.skipped) {
      if (inbound.skipReason === "private_command_only") {
        log?.info("Rejected private-only command in qqbot group before mention gate", {
          accountId: account.accountId,
          messageId: event.messageId,
          senderId: event.senderId,
          type: event.type,
          groupOpenid: event.groupOpenid,
        });
        await senderSendText(
          buildDeliveryTarget(event),
          PRIVATE_CHAT_ONLY_TEXT,
          accountToCreds(account),
          {
            msgId: event.messageId,
          },
        );
        return;
      }
      log?.info(
        `Skipped group inbound: reason=${inbound.skipReason ?? "unknown"} group=${event.groupOpenid ?? ""}`,
        {
          accountId: account.accountId,
          messageId: event.messageId,
          skipReason: inbound.skipReason,
          groupOpenid: event.groupOpenid,
        },
      );
      return;
    }

    // Keep this after buildInboundContext() so ingress access policy can silently drop
    // unauthorized group senders before we emit any command-specific reply.
    const groupCommandLevel =
      event.type === "group" || event.type === "guild"
        ? (inbound.group?.commandLevel ??
          resolveGroupCommandLevelFromAccountConfig(
            account.config,
            event.groupOpenid ?? event.channelId ?? null,
          ))
        : undefined;
    const groupCommandVisibility =
      event.type === "group" || event.type === "guild"
        ? classifyCoreCommandForGroup(inbound.agentBody, groupCommandLevel)
        : { visibility: "unknown" as const };
    if (groupCommandVisibility.visibility === "private") {
      log?.info(
        `Rejected private-only command in qqbot group: /${groupCommandVisibility.commandName}`,
        {
          accountId: account.accountId,
          messageId: event.messageId,
          senderId: event.senderId,
          type: event.type,
          groupOpenid: event.groupOpenid,
        },
      );
      await senderSendText(
        buildDeliveryTarget(event),
        PRIVATE_CHAT_ONLY_TEXT,
        accountToCreds(account),
        {
          msgId: event.messageId,
        },
      );
      return;
    }

    try {
      await runWithRequestContext(
        {
          accountId: account.accountId,
          target: inbound.qualifiedTarget,
          targetId: inbound.peerId,
          chatType: event.type,
        },
        () => dispatchOutbound(inbound, { runtime, cfg: activeCfg, account, log }),
      );
    } catch (err) {
      log?.error(`Message processing failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (event.type === "group" && event.groupOpenid && inbound.group) {
        clearGroupPendingHistory({
          historyMap: groupHistories,
          groupOpenid: event.groupOpenid,
          historyLimit: inbound.group.historyLimit,
          historyPort: adapters.history,
        });
      }
    }
  };

  const handleInteraction = createInteractionHandler(account, ctx.runtime, log, {
    getActiveCfg: () => activeCfgProvider.getActiveCfg(),
    resolveCommandAuthorized: (params) => adapters.access.resolveSlashCommandAuthorization(params),
  });

  const connection = new GatewayConnection({
    account,
    abortSignal: ctx.abortSignal,
    cfg: ctx.cfg,
    log,
    runtime,
    adapters,
    onReady: ctx.onReady,
    onResumed: ctx.onResumed,
    onError: ctx.onError,
    onDisconnected: ctx.onDisconnected,
    onInteraction: handleInteraction,
    handleMessage,
  });

  await connection.start();
}

// ============ Typing helper ============

/**
 * Send the early C2C typing cue and return its refIdx for quote resolution.
 *
 * This is a single input_notify fired right after intake accepts the message
 * (mirroring Telegram's early typing cue). The recurring typing refresh is
 * owned by the core TypingController wired in outbound-dispatch, so this helper
 * starts no keepalive loop.
 */
async function startTypingForEvent(
  event: QueuedMessage,
  account: GatewayAccount,
  log?: EngineLogger,
): Promise<{ refIdx?: string }> {
  const isC2C = event.type === "c2c" || event.type === "dm";
  if (!isC2C) {
    return {};
  }
  try {
    const creds = accountToCreds(account);
    const sendEarlyCue = async () => {
      // Typing and text share QQ's five passive calls. Keep one slot for the
      // final reply. The claim stays inside this retried closure so each wire
      // attempt consumes its own slot. When the reserved slot is all that
      // remains, skip the cue; the core typing tick will send a proactive
      // (no msg_id) input_notify instead.
      const passive = claimMessageReply(event.messageId, 1);
      if (!passive.allowed) {
        return {};
      }
      const resp = await senderSendInputNotify({
        openid: event.senderId,
        creds,
        msgId: event.messageId,
        inputSecond: TYPING_INPUT_SECOND,
      });
      return { refIdx: resp.refIdx };
    };
    try {
      return await sendEarlyCue();
    } catch (notifyErr) {
      const errMsg = String(notifyErr);
      if (errMsg.includes("token") || errMsg.includes("401") || errMsg.includes("11244")) {
        clearTokenCache(account.appId);
        return await sendEarlyCue();
      }
      throw notifyErr;
    }
  } catch (err) {
    log?.error(`sendInputNotify error: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}
