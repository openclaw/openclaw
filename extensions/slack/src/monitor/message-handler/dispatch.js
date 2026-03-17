import { resolveHumanDelayConfig } from "../../../../../src/agents/identity.js";
import { dispatchInboundMessage } from "../../../../../src/auto-reply/dispatch.js";
import { clearHistoryEntriesIfEnabled } from "../../../../../src/auto-reply/reply/history.js";
import { createReplyDispatcherWithTyping } from "../../../../../src/auto-reply/reply/reply-dispatcher.js";
import { removeAckReactionAfterReply } from "../../../../../src/channels/ack-reactions.js";
import { logAckFailure, logTypingFailure } from "../../../../../src/channels/logging.js";
import { createReplyPrefixOptions } from "../../../../../src/channels/reply-prefix.js";
import { createTypingCallbacks } from "../../../../../src/channels/typing.js";
import { resolveStorePath, updateLastRoute } from "../../../../../src/config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../../../../../src/globals.js";
import { resolveAgentOutboundIdentity } from "../../../../../src/infra/outbound/identity.js";
import { resolvePinnedMainDmOwnerFromAllowlist } from "../../../../../src/security/dm-policy-shared.js";
import { editSlackMessage, reactSlackMessage, removeSlackReaction } from "../../actions.js";
import { createSlackDraftStream } from "../../draft-stream.js";
import { normalizeSlackOutboundText } from "../../format.js";
import { recordSlackThreadParticipation } from "../../sent-thread-cache.js";
import {
  applyAppendOnlyStreamUpdate,
  buildStatusFinalPreviewText,
  resolveSlackStreamingConfig
} from "../../stream-mode.js";
import { appendSlackStream, startSlackStream, stopSlackStream } from "../../streaming.js";
import { resolveSlackThreadTargets } from "../../threading.js";
import { normalizeSlackAllowOwnerEntry } from "../allow-list.js";
import {
  createSlackReplyDeliveryPlan,
  deliverReplies,
  readSlackReplyBlocks,
  resolveSlackThreadTs
} from "../replies.js";
function hasMedia(payload) {
  return Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
}
function isSlackStreamingEnabled(params) {
  if (params.mode !== "partial") {
    return false;
  }
  return params.nativeStreaming;
}
function resolveSlackStreamingThreadHint(params) {
  return resolveSlackThreadTs({
    replyToMode: params.replyToMode,
    incomingThreadTs: params.incomingThreadTs,
    messageTs: params.messageTs,
    hasReplied: false,
    isThreadReply: params.isThreadReply
  });
}
function shouldUseStreaming(params) {
  if (!params.streamingEnabled) {
    return false;
  }
  if (!params.threadTs) {
    logVerbose("slack-stream: streaming disabled \u2014 no reply thread target available");
    return false;
  }
  return true;
}
async function dispatchPreparedSlackMessage(prepared) {
  const { ctx, account, message, route } = prepared;
  const cfg = ctx.cfg;
  const runtime = ctx.runtime;
  const outboundIdentity = resolveAgentOutboundIdentity(cfg, route.agentId);
  const slackIdentity = outboundIdentity ? {
    username: outboundIdentity.name,
    iconUrl: outboundIdentity.avatarUrl,
    iconEmoji: outboundIdentity.emoji
  } : void 0;
  if (prepared.isDirectMessage) {
    const sessionCfg = cfg.session;
    const storePath = resolveStorePath(sessionCfg?.store, {
      agentId: route.agentId
    });
    const pinnedMainDmOwner = resolvePinnedMainDmOwnerFromAllowlist({
      dmScope: cfg.session?.dmScope,
      allowFrom: ctx.allowFrom,
      normalizeEntry: normalizeSlackAllowOwnerEntry
    });
    const senderRecipient = message.user?.trim().toLowerCase();
    const skipMainUpdate = pinnedMainDmOwner && senderRecipient && pinnedMainDmOwner.trim().toLowerCase() !== senderRecipient;
    if (skipMainUpdate) {
      logVerbose(
        `slack: skip main-session last route for ${senderRecipient} (pinned owner ${pinnedMainDmOwner})`
      );
    } else {
      await updateLastRoute({
        storePath,
        sessionKey: route.mainSessionKey,
        deliveryContext: {
          channel: "slack",
          to: `user:${message.user}`,
          accountId: route.accountId,
          threadId: prepared.ctxPayload.MessageThreadId
        },
        ctx: prepared.ctxPayload
      });
    }
  }
  const { statusThreadTs, isThreadReply } = resolveSlackThreadTargets({
    message,
    replyToMode: prepared.replyToMode
  });
  const messageTs = message.ts ?? message.event_ts;
  const incomingThreadTs = message.thread_ts;
  let didSetStatus = false;
  const hasRepliedRef = { value: false };
  const replyPlan = createSlackReplyDeliveryPlan({
    replyToMode: prepared.replyToMode,
    incomingThreadTs,
    messageTs,
    hasRepliedRef,
    isThreadReply
  });
  const typingTarget = statusThreadTs ? `${message.channel}/${statusThreadTs}` : message.channel;
  const typingReaction = ctx.typingReaction;
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      didSetStatus = true;
      await ctx.setSlackThreadStatus({
        channelId: message.channel,
        threadTs: statusThreadTs,
        status: "is typing..."
      });
      if (typingReaction && message.ts) {
        await reactSlackMessage(message.channel, message.ts, typingReaction, {
          token: ctx.botToken,
          client: ctx.app.client
        }).catch(() => {
        });
      }
    },
    stop: async () => {
      if (!didSetStatus) {
        return;
      }
      didSetStatus = false;
      await ctx.setSlackThreadStatus({
        channelId: message.channel,
        threadTs: statusThreadTs,
        status: ""
      });
      if (typingReaction && message.ts) {
        await removeSlackReaction(message.channel, message.ts, typingReaction, {
          token: ctx.botToken,
          client: ctx.app.client
        }).catch(() => {
        });
      }
    },
    onStartError: (err) => {
      logTypingFailure({
        log: (message2) => runtime.error?.(danger(message2)),
        channel: "slack",
        action: "start",
        target: typingTarget,
        error: err
      });
    },
    onStopError: (err) => {
      logTypingFailure({
        log: (message2) => runtime.error?.(danger(message2)),
        channel: "slack",
        action: "stop",
        target: typingTarget,
        error: err
      });
    }
  });
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: "slack",
    accountId: route.accountId
  });
  const slackStreaming = resolveSlackStreamingConfig({
    streaming: account.config.streaming,
    streamMode: account.config.streamMode,
    nativeStreaming: account.config.nativeStreaming
  });
  const previewStreamingEnabled = slackStreaming.mode !== "off";
  const streamingEnabled = isSlackStreamingEnabled({
    mode: slackStreaming.mode,
    nativeStreaming: slackStreaming.nativeStreaming
  });
  const streamThreadHint = resolveSlackStreamingThreadHint({
    replyToMode: prepared.replyToMode,
    incomingThreadTs,
    messageTs,
    isThreadReply
  });
  const useStreaming = shouldUseStreaming({
    streamingEnabled,
    threadTs: streamThreadHint
  });
  let streamSession = null;
  let streamFailed = false;
  let usedReplyThreadTs;
  const deliverNormally = async (payload, forcedThreadTs) => {
    const replyThreadTs = forcedThreadTs ?? replyPlan.nextThreadTs();
    await deliverReplies({
      replies: [payload],
      target: prepared.replyTarget,
      token: ctx.botToken,
      accountId: account.accountId,
      runtime,
      textLimit: ctx.textLimit,
      replyThreadTs,
      replyToMode: prepared.replyToMode,
      ...slackIdentity ? { identity: slackIdentity } : {}
    });
    if (replyThreadTs) {
      usedReplyThreadTs ??= replyThreadTs;
    }
    replyPlan.markSent();
  };
  const deliverWithStreaming = async (payload) => {
    if (streamFailed || hasMedia(payload) || readSlackReplyBlocks(payload)?.length || !payload.text?.trim()) {
      await deliverNormally(payload, streamSession?.threadTs);
      return;
    }
    const text = payload.text.trim();
    let plannedThreadTs;
    try {
      if (!streamSession) {
        const streamThreadTs = replyPlan.nextThreadTs();
        plannedThreadTs = streamThreadTs;
        if (!streamThreadTs) {
          logVerbose(
            "slack-stream: no reply thread target for stream start, falling back to normal delivery"
          );
          streamFailed = true;
          await deliverNormally(payload);
          return;
        }
        streamSession = await startSlackStream({
          client: ctx.app.client,
          channel: message.channel,
          threadTs: streamThreadTs,
          text,
          teamId: ctx.teamId,
          userId: message.user
        });
        usedReplyThreadTs ??= streamThreadTs;
        replyPlan.markSent();
        return;
      }
      await appendSlackStream({
        session: streamSession,
        text: "\n" + text
      });
    } catch (err) {
      runtime.error?.(
        danger(`slack-stream: streaming API call failed: ${String(err)}, falling back`)
      );
      streamFailed = true;
      await deliverNormally(payload, streamSession?.threadTs ?? plannedThreadTs);
    }
  };
  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
    ...prefixOptions,
    humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
    typingCallbacks,
    deliver: async (payload) => {
      if (useStreaming) {
        await deliverWithStreaming(payload);
        return;
      }
      const mediaCount = payload.mediaUrls?.length ?? (payload.mediaUrl ? 1 : 0);
      const slackBlocks = readSlackReplyBlocks(payload);
      const draftMessageId = draftStream?.messageId();
      const draftChannelId = draftStream?.channelId();
      const finalText = payload.text ?? "";
      const trimmedFinalText = finalText.trim();
      const canFinalizeViaPreviewEdit = previewStreamingEnabled && streamMode !== "status_final" && mediaCount === 0 && !payload.isError && (trimmedFinalText.length > 0 || Boolean(slackBlocks?.length)) && typeof draftMessageId === "string" && typeof draftChannelId === "string";
      if (canFinalizeViaPreviewEdit) {
        draftStream?.stop();
        try {
          await editSlackMessage(
            draftChannelId,
            draftMessageId,
            normalizeSlackOutboundText(trimmedFinalText),
            {
              token: ctx.botToken,
              accountId: account.accountId,
              client: ctx.app.client,
              ...slackBlocks?.length ? { blocks: slackBlocks } : {}
            }
          );
          return;
        } catch (err) {
          logVerbose(
            `slack: preview final edit failed; falling back to standard send (${String(err)})`
          );
        }
      } else if (previewStreamingEnabled && streamMode === "status_final" && hasStreamedMessage) {
        try {
          const statusChannelId = draftStream?.channelId();
          const statusMessageId = draftStream?.messageId();
          if (statusChannelId && statusMessageId) {
            await ctx.app.client.chat.update({
              token: ctx.botToken,
              channel: statusChannelId,
              ts: statusMessageId,
              text: "Status: complete. Final answer posted below."
            });
          }
        } catch (err) {
          logVerbose(`slack: status_final completion update failed (${String(err)})`);
        }
      } else if (mediaCount > 0) {
        await draftStream?.clear();
        hasStreamedMessage = false;
      }
      await deliverNormally(payload);
    },
    onError: (err, info) => {
      runtime.error?.(danger(`slack ${info.kind} reply failed: ${String(err)}`));
      typingCallbacks.onIdle?.();
    }
  });
  const draftStream = createSlackDraftStream({
    target: prepared.replyTarget,
    token: ctx.botToken,
    accountId: account.accountId,
    maxChars: Math.min(ctx.textLimit, 4e3),
    resolveThreadTs: () => {
      const ts = replyPlan.nextThreadTs();
      if (ts) {
        usedReplyThreadTs ??= ts;
      }
      return ts;
    },
    onMessageSent: () => replyPlan.markSent(),
    log: logVerbose,
    warn: logVerbose
  });
  let hasStreamedMessage = false;
  const streamMode = slackStreaming.draftMode;
  let appendRenderedText = "";
  let appendSourceText = "";
  let statusUpdateCount = 0;
  const updateDraftFromPartial = (text) => {
    const trimmed = text?.trimEnd();
    if (!trimmed) {
      return;
    }
    if (streamMode === "append") {
      const next = applyAppendOnlyStreamUpdate({
        incoming: trimmed,
        rendered: appendRenderedText,
        source: appendSourceText
      });
      appendRenderedText = next.rendered;
      appendSourceText = next.source;
      if (!next.changed) {
        return;
      }
      draftStream.update(next.rendered);
      hasStreamedMessage = true;
      return;
    }
    if (streamMode === "status_final") {
      statusUpdateCount += 1;
      if (statusUpdateCount > 1 && statusUpdateCount % 4 !== 0) {
        return;
      }
      draftStream.update(buildStatusFinalPreviewText(statusUpdateCount));
      hasStreamedMessage = true;
      return;
    }
    draftStream.update(trimmed);
    hasStreamedMessage = true;
  };
  const onDraftBoundary = useStreaming || !previewStreamingEnabled ? void 0 : async () => {
    if (hasStreamedMessage) {
      draftStream.forceNewMessage();
      hasStreamedMessage = false;
      appendRenderedText = "";
      appendSourceText = "";
      statusUpdateCount = 0;
    }
  };
  const { queuedFinal, counts } = await dispatchInboundMessage({
    ctx: prepared.ctxPayload,
    cfg,
    dispatcher,
    replyOptions: {
      ...replyOptions,
      skillFilter: prepared.channelConfig?.skills,
      hasRepliedRef,
      disableBlockStreaming: useStreaming ? true : typeof account.config.blockStreaming === "boolean" ? !account.config.blockStreaming : void 0,
      onModelSelected,
      onPartialReply: useStreaming ? void 0 : !previewStreamingEnabled ? void 0 : async (payload) => {
        updateDraftFromPartial(payload.text);
      },
      onAssistantMessageStart: onDraftBoundary,
      onReasoningEnd: onDraftBoundary
    }
  });
  await draftStream.flush();
  draftStream.stop();
  markDispatchIdle();
  const finalStream = streamSession;
  if (finalStream && !finalStream.stopped) {
    try {
      await stopSlackStream({ session: finalStream });
    } catch (err) {
      runtime.error?.(danger(`slack-stream: failed to stop stream: ${String(err)}`));
    }
  }
  const anyReplyDelivered = queuedFinal || (counts.block ?? 0) > 0 || (counts.final ?? 0) > 0;
  const participationThreadTs = usedReplyThreadTs ?? statusThreadTs;
  if (anyReplyDelivered && participationThreadTs) {
    recordSlackThreadParticipation(account.accountId, message.channel, participationThreadTs);
  }
  if (!anyReplyDelivered) {
    await draftStream.clear();
    if (prepared.isRoomish) {
      clearHistoryEntriesIfEnabled({
        historyMap: ctx.channelHistories,
        historyKey: prepared.historyKey,
        limit: ctx.historyLimit
      });
    }
    return;
  }
  if (shouldLogVerbose()) {
    const finalCount = counts.final;
    logVerbose(
      `slack: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${prepared.replyTarget}`
    );
  }
  removeAckReactionAfterReply({
    removeAfterReply: ctx.removeAckAfterReply,
    ackReactionPromise: prepared.ackReactionPromise,
    ackReactionValue: prepared.ackReactionValue,
    remove: () => removeSlackReaction(
      message.channel,
      prepared.ackReactionMessageTs ?? "",
      prepared.ackReactionValue,
      {
        token: ctx.botToken,
        client: ctx.app.client
      }
    ),
    onError: (err) => {
      logAckFailure({
        log: logVerbose,
        channel: "slack",
        target: `${message.channel}/${message.ts}`,
        error: err
      });
    }
  });
  if (prepared.isRoomish) {
    clearHistoryEntriesIfEnabled({
      historyMap: ctx.channelHistories,
      historyKey: prepared.historyKey,
      limit: ctx.historyLimit
    });
  }
}
export {
  dispatchPreparedSlackMessage,
  isSlackStreamingEnabled,
  resolveSlackStreamingThreadHint
};
