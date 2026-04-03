import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  createStatusReactionController,
  DEFAULT_TIMING,
  logAckFailure,
  logTypingFailure,
  removeAckReactionAfterReply,
  type StatusReactionAdapter,
} from "openclaw/plugin-sdk/channel-feedback";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { resolveAgentOutboundIdentity } from "openclaw/plugin-sdk/outbound-runtime";
import { clearHistoryEntriesIfEnabled } from "openclaw/plugin-sdk/reply-history";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { danger, logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import { reactSlackMessage, removeSlackReaction } from "../../actions.js";
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
import { resolveStorePath, updateLastRoute } from "../config.runtime.js";
import {
  createSlackReplyDeliveryPlan,
  deliverReplies,
  readSlackReplyBlocks,
  resolveSlackThreadTs,
} from "../replies.js";
import { createReplyDispatcherWithTyping, dispatchInboundMessage } from "../reply.runtime.js";
import { finalizeSlackPreviewEdit } from "./preview-finalize.js";
import type { PreparedSlackMessage } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Slack reactions.add/remove expect shortcode names, not raw unicode emoji.
const UNICODE_TO_SLACK: Record<string, string> = {
  "👀": "eyes",
  "🤔": "thinking_face",
  "🔥": "fire",
  "👨‍💻": "male-technologist",
  "👨💻": "male-technologist",
  "👩‍💻": "female-technologist",
  "⚡": "zap",
  "🌐": "globe_with_meridians",
  "✅": "white_check_mark",
  "👍": "thumbsup",
  "❌": "x",
  "😱": "scream",
  "🥱": "yawning_face",
  "😨": "fearful",
  "⏳": "hourglass_flowing_sand",
  "⚠️": "warning",
  "✍": "writing_hand",
  "🧠": "brain",
  "🛠️": "hammer_and_wrench",
  "💻": "computer",
};

function toSlackEmojiName(emoji: string): string {
  const trimmed = emoji.trim().replace(/^:+|:+$/g, "");
  return UNICODE_TO_SLACK[trimmed] ?? trimmed;
}

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

export function shouldEnableSlackPreviewStreaming(params: {
  mode: "off" | "partial" | "block" | "progress";
  isDirectMessage: boolean;
  threadTs?: string;
}): boolean {
  if (params.mode === "off") {
    return false;
  }
  if (!params.isDirectMessage) {
    return true;
  }
  return Boolean(params.threadTs);
}

export function shouldInitializeSlackDraftStream(params: {
  previewStreamingEnabled: boolean;
  useStreaming: boolean;
}): boolean {
  return params.previewStreamingEnabled && !params.useStreaming;
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

  const reactionMessageTs = prepared.ackReactionMessageTs;
  const messageTs = message.ts ?? message.event_ts;
  const incomingThreadTs = message.thread_ts;
  let didSetStatus = false;
  const statusReactionsEnabled =
    Boolean(prepared.ackReactionPromise) &&
    Boolean(reactionMessageTs) &&
    cfg.messages?.statusReactions?.enabled !== false;
  const slackStatusAdapter: StatusReactionAdapter = {
    setReaction: async (emoji) => {
      await reactSlackMessage(message.channel, reactionMessageTs ?? "", toSlackEmojiName(emoji), {
        token: ctx.botToken,
        client: ctx.app.client,
      }).catch((err) => {
        if (String(err).includes("already_reacted")) {
          return;
        }
        throw err;
      });
    },
    removeReaction: async (emoji) => {
      await removeSlackReaction(message.channel, reactionMessageTs ?? "", toSlackEmojiName(emoji), {
        token: ctx.botToken,
        client: ctx.app.client,
      }).catch((err) => {
        if (String(err).includes("no_reaction")) {
          return;
        }
        throw err;
      });
    },
  };
  const statusReactionTiming = {
    ...DEFAULT_TIMING,
    ...cfg.messages?.statusReactions?.timing,
  };
  const statusReactions = createStatusReactionController({
    enabled: statusReactionsEnabled,
    adapter: slackStatusAdapter,
    initialEmoji: prepared.ackReactionValue || "eyes",
    emojis: cfg.messages?.statusReactions?.emojis,
    timing: cfg.messages?.statusReactions?.timing,
    onError: (err) => {
      logAckFailure({
        log: logVerbose,
        channel: "slack",
        target: `${message.channel}/${message.ts}`,
        error: err,
      });
    },
  });

  if (statusReactionsEnabled) {
    void statusReactions.setQueued();
  }

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
    nativeStreaming: account.config.nativeStreaming,
  });
  const streamThreadHint = resolveSlackStreamingThreadHint({
    replyToMode: prepared.replyToMode,
    incomingThreadTs,
    messageTs,
    isThreadReply,
  });
  const previewStreamingEnabled = shouldEnableSlackPreviewStreaming({
    mode: slackStreaming.mode,
    isDirectMessage: prepared.isDirectMessage,
    threadTs: streamThreadHint,
  });
  const streamingEnabled = isSlackStreamingEnabled({
    mode: slackStreaming.mode,
    nativeStreaming: slackStreaming.nativeStreaming,
  });
  const useStreaming = shouldUseStreaming({
    streamingEnabled,
    threadTs: streamThreadHint,
  });
  const shouldUseDraftStream = shouldInitializeSlackDraftStream({
    previewStreamingEnabled,
    useStreaming,
  });
  let streamSession: SlackStreamSession | null = null;
  let streamFailed = false;
  let usedReplyThreadTs: string | undefined;
  let observedReplyDelivery = false;

  const deliverNormally = async (payload: ReplyPayload, forcedThreadTs?: string): Promise<void> => {
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
      ...(slackIdentity ? { identity: slackIdentity } : {}),
    });
    observedReplyDelivery = true;
    // Record the thread ts only after confirmed delivery success.
    if (replyThreadTs) {
      usedReplyThreadTs ??= replyThreadTs;
    }
    replyPlan.markSent();
  };

  const deliverWithStreaming = async (payload: ReplyPayload): Promise<void> => {
    const reply = resolveSendableOutboundReplyParts(payload);
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
        observedReplyDelivery = true;
        usedReplyThreadTs ??= streamThreadTs;
        replyPlan.markSent();
        return;
      }

      await appendSlackStream({
        session: streamSession,
        text: "\n" + text,
      });
    } catch (err) {
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
          await finalizeSlackPreviewEdit({
            client: ctx.app.client,
            token: ctx.botToken,
            accountId: account.accountId,
            channelId: draftChannelId,
            messageId: draftMessageId,
            text: normalizeSlackOutboundText(trimmedFinalText),
            ...(slackBlocks?.length ? { blocks: slackBlocks } : {}),
            threadTs: usedReplyThreadTs ?? statusThreadTs,
          });
          observedReplyDelivery = true;
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
      runtime.error?.(danger(`slack ${info.kind} reply failed: ${String(err)}`));
      replyPipeline.typingCallbacks?.onIdle?.();
    },
  });

  const draftStream = shouldUseDraftStream
    ? createSlackDraftStream({
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
      })
    : undefined;
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
      draftStream?.update(next.rendered);
      hasStreamedMessage = true;
      return;
    }

    if (streamMode === "status_final") {
      statusUpdateCount += 1;
      if (statusUpdateCount > 1 && statusUpdateCount % 4 !== 0) {
        return;
      }
      draftStream?.update(buildStatusFinalPreviewText(statusUpdateCount));
      hasStreamedMessage = true;
      return;
    }

    draftStream?.update(trimmed);
    hasStreamedMessage = true;
  };
  const onDraftBoundary = !shouldUseDraftStream
    ? undefined
    : async () => {
        if (hasStreamedMessage) {
          draftStream?.forceNewMessage();
          hasStreamedMessage = false;
          appendRenderedText = "";
          appendSourceText = "";
          statusUpdateCount = 0;
        }
      };

  let dispatchError: unknown;
  let queuedFinal = false;
  let counts: { final?: number; block?: number } = {};
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
                updateDraftFromPartial(payload.text);
              },
        onAssistantMessageStart: onDraftBoundary,
        onReasoningEnd: onDraftBoundary,
        onReasoningStream: statusReactionsEnabled
          ? async () => {
              await statusReactions.setThinking();
            }
          : undefined,
        onToolStart: statusReactionsEnabled
          ? async (payload) => {
              await statusReactions.setTool(payload.name);
            }
          : undefined,
      },
    });
    queuedFinal = result.queuedFinal;
    counts = result.counts;
  } catch (err) {
    dispatchError = err;
  } finally {
    await draftStream?.flush();
    draftStream?.stop();
    markDispatchIdle();
  }

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

  const anyReplyDelivered =
    observedReplyDelivery || queuedFinal || (counts.block ?? 0) > 0 || (counts.final ?? 0) > 0;

  if (statusReactionsEnabled) {
    if (dispatchError) {
      await statusReactions.setError();
      if (ctx.removeAckAfterReply) {
        void (async () => {
          await sleep(statusReactionTiming.errorHoldMs);
          if (anyReplyDelivered) {
            await statusReactions.clear();
            return;
          }
          await statusReactions.restoreInitial();
        })();
      } else {
        void statusReactions.restoreInitial();
      }
    } else if (anyReplyDelivered) {
      await statusReactions.setDone();
      if (ctx.removeAckAfterReply) {
        void (async () => {
          await sleep(statusReactionTiming.doneHoldMs);
          await statusReactions.clear();
        })();
      } else {
        void statusReactions.restoreInitial();
      }
    } else {
      // Silent success should preserve queued state and clear any stall timers
      // instead of transitioning to terminal/stall reactions after return.
      await statusReactions.restoreInitial();
    }
  }

  if (dispatchError) {
    throw dispatchError;
  }

  // Record thread participation only when we actually delivered a reply and
  // know the thread ts that was used (set by deliverNormally, streaming start,
  // or draft stream). Falls back to statusThreadTs for edge cases.
  const participationThreadTs = usedReplyThreadTs ?? statusThreadTs;
  if (anyReplyDelivered && participationThreadTs) {
    recordSlackThreadParticipation(account.accountId, message.channel, participationThreadTs);
  }

  if (!anyReplyDelivered) {
    await draftStream?.clear();
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

  if (!statusReactionsEnabled) {
    removeAckReactionAfterReply({
      removeAfterReply: ctx.removeAckAfterReply && anyReplyDelivered,
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
  }

  if (prepared.isRoomish) {
    clearHistoryEntriesIfEnabled({
      historyMap: ctx.channelHistories,
      historyKey: prepared.historyKey,
      limit: ctx.historyLimit,
    });
  }
}
