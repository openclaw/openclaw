import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  logAckFailure,
  logTypingFailure,
  removeAckReactionAfterReply,
} from "openclaw/plugin-sdk/channel-feedback";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { resolveStorePath, updateLastRoute } from "openclaw/plugin-sdk/config-runtime";
import { triggerInternalHook, createInternalHookEvent } from "openclaw/plugin-sdk/hook-runtime";
import { resolveAgentOutboundIdentity } from "openclaw/plugin-sdk/outbound-runtime";
import { clearHistoryEntriesIfEnabled } from "openclaw/plugin-sdk/reply-history";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { dispatchInboundMessage } from "openclaw/plugin-sdk/reply-runtime";
import { createReplyDispatcherWithTyping } from "openclaw/plugin-sdk/reply-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { danger, logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import { editSlackMessage, reactSlackMessage, removeSlackReaction } from "../../actions.js";
import { createSlackDraftStream } from "../../draft-stream.js";
import { normalizeSlackOutboundText } from "../../format.js";
import { SLACK_TEXT_LIMIT } from "../../limits.js";
import { recordSlackThreadParticipation } from "../../sent-thread-cache.js";
import {
  applyAppendOnlyStreamUpdate,
  buildStatusFinalPreviewText,
  resolveSlackStreamingConfig,
} from "../../stream-mode.js";
import type { SlackStreamSession } from "../../streaming.js";
import { appendSlackStream, startSlackStream, stopSlackStream } from "../../streaming.js";
import { resolveSlackThreadTargets } from "../../threading.js";
import { normalizeSlackAllowOwnerEntry } from "../allow-list.js";
import {
  createSlackReplyDeliveryPlan,
  deliverReplies,
  readSlackReplyBlocks,
  resolveSlackThreadTs,
} from "../replies.js";
import type { PreparedSlackMessage } from "./types.js";

function hasMedia(payload: ReplyPayload): boolean {
  return resolveSendableOutboundReplyParts(payload).hasMedia;
}

export function isSlackStreamingEnabled(params: {
  mode: "off" | "partial" | "block" | "progress";
  nativeStreaming: boolean;
}): boolean {
  if (params.mode !== "partial") {
    return false;
  }
  return params.nativeStreaming;
}

export function resolveSlackStreamingThreadHint(params: {
  replyToMode: "off" | "first" | "all";
  incomingThreadTs: string | undefined;
  messageTs: string | undefined;
  isThreadReply?: boolean;
}): string | undefined {
  return resolveSlackThreadTs({
    replyToMode: params.replyToMode,
    incomingThreadTs: params.incomingThreadTs,
    messageTs: params.messageTs,
    hasReplied: false,
    isThreadReply: params.isThreadReply,
  });
}

function shouldUseStreaming(params: {
  streamingEnabled: boolean;
  threadTs: string | undefined;
}): boolean {
  if (!params.streamingEnabled) {
    return false;
  }
  if (!params.threadTs) {
    logVerbose("slack-stream: streaming disabled — no reply thread target available");
    return false;
  }
  return true;
}

export async function dispatchPreparedSlackMessage(prepared: PreparedSlackMessage) {
  const { ctx, account, message, route } = prepared;
  const cfg = ctx.cfg;
  const runtime = ctx.runtime;
  console.error(
    `[slack-trace] dispatch start channel=${message.channel} ts=${message.ts ?? "-"} replyTarget=${prepared.replyTarget} isDirect=${prepared.isDirectMessage} isRoomish=${prepared.isRoomish} replyToMode=${prepared.replyToMode} routeAgent=${route.agentId ?? "-"} sessionKey=${prepared.ctxPayload.SessionKey ?? "-"}`,
  );

  // Resolve agent identity for Slack chat:write.customize overrides.
  const outboundIdentity = resolveAgentOutboundIdentity(cfg, route.agentId);
  const slackIdentity = outboundIdentity
    ? {
        username: outboundIdentity.name,
        iconUrl: outboundIdentity.avatarUrl,
        iconEmoji: outboundIdentity.emoji,
      }
    : undefined;

  if (prepared.isDirectMessage) {
    const sessionCfg = cfg.session;
    const storePath = resolveStorePath(sessionCfg?.store, {
      agentId: route.agentId,
    });
    const pinnedMainDmOwner = resolvePinnedMainDmOwnerFromAllowlist({
      dmScope: cfg.session?.dmScope,
      allowFrom: ctx.allowFrom,
      normalizeEntry: normalizeSlackAllowOwnerEntry,
    });
    const senderRecipient = message.user?.trim().toLowerCase();
    const skipMainUpdate =
      pinnedMainDmOwner &&
      senderRecipient &&
      pinnedMainDmOwner.trim().toLowerCase() !== senderRecipient;
    if (skipMainUpdate) {
      logVerbose(
        `slack: skip main-session last route for ${senderRecipient} (pinned owner ${pinnedMainDmOwner})`,
      );
    } else {
      await updateLastRoute({
        storePath,
        sessionKey: route.mainSessionKey,
        deliveryContext: {
          channel: "slack",
          to: `user:${message.user}`,
          accountId: route.accountId,
          threadId: prepared.ctxPayload.MessageThreadId,
        },
        ctx: prepared.ctxPayload,
      });
    }
  }

  const { statusThreadTs, isThreadReply } = resolveSlackThreadTargets({
    message,
    replyToMode: prepared.replyToMode,
  });

  const messageTs = message.ts ?? message.event_ts;
  const incomingThreadTs = message.thread_ts;
  let didSetStatus = false;

  // Shared mutable ref for "replyToMode=first". Both tool + auto-reply flows
  // mark this to ensure only the first reply is threaded.
  const hasRepliedRef = { value: false };
  const replyPlan = createSlackReplyDeliveryPlan({
    replyToMode: prepared.replyToMode,
    incomingThreadTs,
    messageTs,
    hasRepliedRef,
    isThreadReply,
  });

  const typingTarget = statusThreadTs ? `${message.channel}/${statusThreadTs}` : message.channel;
  const typingReaction = ctx.typingReaction;
  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg,
    agentId: route.agentId,
    channel: "slack",
    accountId: route.accountId,
    typing: {
      start: async () => {
        didSetStatus = true;
        await ctx.setSlackThreadStatus({
          channelId: message.channel,
          threadTs: statusThreadTs,
          status: "is typing...",
        });
        if (typingReaction && message.ts) {
          await reactSlackMessage(message.channel, message.ts, typingReaction, {
            token: ctx.botToken,
            client: ctx.app.client,
          }).catch(() => {});
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
          status: "",
        });
        if (typingReaction && message.ts) {
          await removeSlackReaction(message.channel, message.ts, typingReaction, {
            token: ctx.botToken,
            client: ctx.app.client,
          }).catch(() => {});
        }
      },
      onStartError: (err) => {
        logTypingFailure({
          log: (message) => runtime.error?.(danger(message)),
          channel: "slack",
          action: "start",
          target: typingTarget,
          error: err,
        });
      },
      onStopError: (err) => {
        logTypingFailure({
          log: (message) => runtime.error?.(danger(message)),
          channel: "slack",
          action: "stop",
          target: typingTarget,
          error: err,
        });
      },
    },
  });

  const slackStreaming = resolveSlackStreamingConfig({
    streaming: account.config.streaming,
    streamMode: account.config.streamMode,
    nativeStreaming: account.config.nativeStreaming,
  });
  const previewStreamingEnabled = slackStreaming.mode !== "off";
  const streamingEnabled = isSlackStreamingEnabled({
    mode: slackStreaming.mode,
    nativeStreaming: slackStreaming.nativeStreaming,
  });
  const streamThreadHint = resolveSlackStreamingThreadHint({
    replyToMode: prepared.replyToMode,
    incomingThreadTs,
    messageTs,
    isThreadReply,
  });
  const useStreaming = shouldUseStreaming({
    streamingEnabled,
    threadTs: streamThreadHint,
  });
  let streamSession: SlackStreamSession | null = null;
  let streamFailed = false;
  let usedReplyThreadTs: string | undefined;

  const deliverNormally = async (payload: ReplyPayload, forcedThreadTs?: string): Promise<void> => {
    const replyThreadTs = forcedThreadTs ?? replyPlan.nextThreadTs();
    console.error(
      `[slack-trace] dispatch deliverNormally channel=${message.channel} ts=${message.ts ?? "-"} replyThreadTs=${replyThreadTs ?? "-"} payloadHasMedia=${hasMedia(payload)}`,
    );
    await deliverReplies({
      replies: [payload],
      target: prepared.replyTarget,
      token: ctx.botToken,
      accountId: account.accountId,
      runtime,
      textLimit: ctx.textLimit,
      replyThreadTs,
      replyToMode: prepared.replyToMode,
      ...(slackIdentity ? { identity: slackIdentity } : {}),
    });
    // Record the thread ts only after confirmed delivery success.
    if (replyThreadTs) {
      usedReplyThreadTs ??= replyThreadTs;
    }
    replyPlan.markSent();
    console.error(
      `[slack-trace] dispatch deliverNormally success channel=${message.channel} ts=${message.ts ?? "-"} replyThreadTs=${replyThreadTs ?? "-"}`,
    );
  };

  const deliverWithStreaming = async (payload: ReplyPayload): Promise<void> => {
    const reply = resolveSendableOutboundReplyParts(payload);
    console.error(
      `[slack-trace] deliverWithStreaming enter channel=${message.channel} ts=${message.ts ?? "-"} streamFailed=${streamFailed} hasMedia=${reply.hasMedia} hasText=${reply.hasText} streamSession=${streamSession ? "active" : "null"}`,
    );
    if (streamFailed || reply.hasMedia || readSlackReplyBlocks(payload)?.length || !reply.hasText) {
      await deliverNormally(payload, streamSession?.threadTs);
      return;
    }

    const text = reply.trimmedText;
    let plannedThreadTs: string | undefined;
    try {
      if (!streamSession) {
        const streamThreadTs = replyPlan.nextThreadTs();
        plannedThreadTs = streamThreadTs;
        if (!streamThreadTs) {
          logVerbose(
            "slack-stream: no reply thread target for stream start, falling back to normal delivery",
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
          userId: message.user,
        });
        usedReplyThreadTs ??= streamThreadTs;
        replyPlan.markSent();
        return;
      }

      await appendSlackStream({
        session: streamSession,
        text: "\n" + text,
      });
    } catch (err) {
      console.error(
        `[slack-trace] deliverWithStreaming error channel=${message.channel} ts=${message.ts ?? "-"}: ${String(err)}`,
      );
      runtime.error?.(
        danger(`slack-stream: streaming API call failed: ${String(err)}, falling back`),
      );
      streamFailed = true;
      await deliverNormally(payload, streamSession?.threadTs ?? plannedThreadTs);
    }
  };

  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
    ...replyPipeline,
    humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
    deliver: async (payload) => {
      console.error(
        `[slack-trace] dispatch deliver channel=${message.channel} ts=${message.ts ?? "-"} useStreaming=${useStreaming} previewStreaming=${previewStreamingEnabled} text_len=${payload.text?.length ?? 0}`,
      );
      if (useStreaming) {
        await deliverWithStreaming(payload);
        return;
      }

      const reply = resolveSendableOutboundReplyParts(payload);
      const slackBlocks = readSlackReplyBlocks(payload);
      const draftMessageId = draftStream?.messageId();
      const draftChannelId = draftStream?.channelId();
      const finalText = reply.text;
      const trimmedFinalText = reply.trimmedText;
      const canFinalizeViaPreviewEdit =
        previewStreamingEnabled &&
        streamMode !== "status_final" &&
        !reply.hasMedia &&
        !payload.isError &&
        (trimmedFinalText.length > 0 || Boolean(slackBlocks?.length)) &&
        typeof draftMessageId === "string" &&
        typeof draftChannelId === "string";

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
              ...(slackBlocks?.length ? { blocks: slackBlocks } : {}),
            },
          );
          return;
        } catch (err) {
          logVerbose(
            `slack: preview final edit failed; falling back to standard send (${String(err)})`,
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
              text: "Status: complete. Final answer posted below.",
            });
          }
        } catch (err) {
          logVerbose(`slack: status_final completion update failed (${String(err)})`);
        }
      } else if (reply.hasMedia) {
        await draftStream?.clear();
        hasStreamedMessage = false;
      }

      await deliverNormally(payload);
    },
    onError: (err, info) => {
      console.error(
        `[slack-trace] dispatch onError channel=${message.channel} ts=${message.ts ?? "-"} kind=${info.kind}: ${String(err)}`,
      );
      runtime.error?.(danger(`slack ${info.kind} reply failed: ${String(err)}`));
      replyPipeline.typingCallbacks?.onIdle?.();
    },
  });

  const draftStream = createSlackDraftStream({
    target: prepared.replyTarget,
    token: ctx.botToken,
    accountId: account.accountId,
    maxChars: Math.min(ctx.textLimit, SLACK_TEXT_LIMIT),
    resolveThreadTs: () => {
      const ts = replyPlan.nextThreadTs();
      if (ts) {
        usedReplyThreadTs ??= ts;
      }
      return ts;
    },
    onMessageSent: () => replyPlan.markSent(),
    log: logVerbose,
    warn: logVerbose,
  });
  let hasStreamedMessage = false;
  const streamMode = slackStreaming.draftMode;
  let appendRenderedText = "";
  let appendSourceText = "";
  let statusUpdateCount = 0;
  const updateDraftFromPartial = (text?: string) => {
    const trimmed = text?.trimEnd();
    if (!trimmed) {
      return;
    }

    if (streamMode === "append") {
      const next = applyAppendOnlyStreamUpdate({
        incoming: trimmed,
        rendered: appendRenderedText,
        source: appendSourceText,
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
  const onDraftBoundary =
    useStreaming || !previewStreamingEnabled
      ? undefined
      : async () => {
          if (hasStreamedMessage) {
            draftStream.forceNewMessage();
            hasStreamedMessage = false;
            appendRenderedText = "";
            appendSourceText = "";
            statusUpdateCount = 0;
          }
        };

  const dispatchStartedAt = Date.now();
  console.error(
    `[slack-trace] dispatchInboundMessage enter channel=${message.channel} ts=${message.ts ?? "-"} sessionKey=${prepared.ctxPayload.SessionKey ?? "-"}`,
  );
  let queuedFinal: boolean;
  let counts: { final?: number; block?: number };
  try {
    const result = await dispatchInboundMessage({
      ctx: prepared.ctxPayload,
      cfg,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        skillFilter: prepared.channelConfig?.skills,
        hasRepliedRef,
        disableBlockStreaming: useStreaming
          ? true
          : typeof account.config.blockStreaming === "boolean"
            ? !account.config.blockStreaming
            : undefined,
        onModelSelected,
        onPartialReply: useStreaming
          ? undefined
          : !previewStreamingEnabled
            ? undefined
            : async (payload) => {
                console.error(
                  `[slack-trace] dispatchInboundMessage partial channel=${message.channel} ts=${message.ts ?? "-"} text_len=${payload.text?.length ?? 0}`,
                );
                updateDraftFromPartial(payload.text);
              },
        onAssistantMessageStart: async () => {
          console.error(
            `[slack-trace] dispatchInboundMessage assistant-start channel=${message.channel} ts=${message.ts ?? "-"}`,
          );
          await onDraftBoundary?.();
        },
        onReasoningEnd: async () => {
          console.error(
            `[slack-trace] dispatchInboundMessage reasoning-end channel=${message.channel} ts=${message.ts ?? "-"}`,
          );
          await onDraftBoundary?.();
        },
      },
    });
    queuedFinal = result.queuedFinal;
    counts = result.counts;
    console.error(
      `[slack-trace] dispatchInboundMessage exit channel=${message.channel} ts=${message.ts ?? "-"} queuedFinal=${queuedFinal} finalCount=${counts.final ?? 0} blockCount=${counts.block ?? 0} elapsedMs=${Date.now() - dispatchStartedAt}`,
    );
  } catch (err) {
    console.error(
      `[slack-trace] dispatchInboundMessage error channel=${message.channel} ts=${message.ts ?? "-"} elapsedMs=${Date.now() - dispatchStartedAt}: ${String(err)}`,
    );
    throw err;
  }
  await draftStream.flush();
  draftStream.stop();
  markDispatchIdle();

  // -----------------------------------------------------------------------
  // Finalize the stream if one was started
  // -----------------------------------------------------------------------
  const finalStream = streamSession as SlackStreamSession | null;
  if (finalStream && !finalStream.stopped) {
    try {
      await stopSlackStream({ session: finalStream });
    } catch (err) {
      runtime.error?.(danger(`slack-stream: failed to stop stream: ${String(err)}`));
    }
  }

  // Also check usedReplyThreadTs: when the model produces multiple turns and the
  // last turn is empty, dispatchInboundMessage counts show 0 despite a reply having
  // been delivered in an earlier turn. usedReplyThreadTs is set in deliverNormally
  // only after deliverReplies completes, so it's a reliable "something was sent" signal.
  // When the inner dispatcher (inside dispatchReplyFromConfig) delivers directly to
  // Slack without routing through the outer dispatcher's deliver callback, counts stay
  // at 0 and usedReplyThreadTs is never set. Use elapsed time as a proxy: any dispatch
  // that actually ran the model takes multiple seconds; filtered/empty exits are <100ms.
  const dispatchElapsedMs = Date.now() - dispatchStartedAt;
  const likelyDelivered = dispatchElapsedMs > 2000 && !!statusThreadTs;
  console.error(
    `[slack-trace] pre-hook-check queuedFinal=${queuedFinal} blockCount=${counts?.block ?? 0} finalCount=${counts?.final ?? 0} usedReplyThreadTs=${usedReplyThreadTs ?? "undefined"} statusThreadTs=${statusThreadTs ?? "undefined"} elapsedMs=${dispatchElapsedMs} likelyDelivered=${likelyDelivered}`,
  );
  const anyReplyDelivered =
    queuedFinal ||
    (counts.block ?? 0) > 0 ||
    (counts.final ?? 0) > 0 ||
    !!usedReplyThreadTs ||
    likelyDelivered;

  // Record thread participation only when we actually delivered a reply and
  // know the thread ts that was used (set by deliverNormally, streaming start,
  // or draft stream). Falls back to statusThreadTs for edge cases.
  const participationThreadTs = usedReplyThreadTs ?? statusThreadTs;
  if (anyReplyDelivered && participationThreadTs) {
    recordSlackThreadParticipation(account.accountId, message.channel, participationThreadTs);

    // Fire internal message:sent hook so workspace hooks (e.g., steerer/reviewer)
    // can react to completed deliveries. The Slack extension uses a custom send path
    // that bypasses the generic outbound delivery module, so we fire the hook here.
    console.error(
      `[slack-trace] firing internal message:sent hook session=${prepared.ctxPayload.SessionKey ?? "-"} channel=${message.channel} thread=${participationThreadTs}`,
    );
    void triggerInternalHook(
      createInternalHookEvent("message", "sent", prepared.ctxPayload.SessionKey ?? "", {
        channelId: message.channel,
        conversationId: participationThreadTs,
        to: prepared.replyTarget,
        success: true,
        accountId: account.accountId,
        botUserId: ctx.botUserId,
        cfg,
      }),
    ).catch((err) => {
      console.error(`[slack-trace] internal message:sent hook failed: ${String(err)}`);
    });
  }

  if (!anyReplyDelivered) {
    await draftStream.clear();
    if (prepared.isRoomish) {
      clearHistoryEntriesIfEnabled({
        historyMap: ctx.channelHistories,
        historyKey: prepared.historyKey,
        limit: ctx.historyLimit,
      });
    }
    return;
  }

  if (shouldLogVerbose()) {
    const finalCount = counts.final;
    logVerbose(
      `slack: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${prepared.replyTarget}`,
    );
  }

  removeAckReactionAfterReply({
    removeAfterReply: ctx.removeAckAfterReply,
    ackReactionPromise: prepared.ackReactionPromise,
    ackReactionValue: prepared.ackReactionValue,
    remove: () =>
      removeSlackReaction(
        message.channel,
        prepared.ackReactionMessageTs ?? "",
        prepared.ackReactionValue,
        {
          token: ctx.botToken,
          client: ctx.app.client,
        },
      ),
    onError: (err) => {
      logAckFailure({
        log: logVerbose,
        channel: "slack",
        target: `${message.channel}/${message.ts}`,
        error: err,
      });
    },
  });

  if (prepared.isRoomish) {
    clearHistoryEntriesIfEnabled({
      historyMap: ctx.channelHistories,
      historyKey: prepared.historyKey,
      limit: ctx.historyLimit,
    });
  }
}
