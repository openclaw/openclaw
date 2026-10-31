import { AllowedMentionsTypes, type APIAllowedMentions } from "discord-api-types/v10";
import { resolveAgentConfig, resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  dispatchChannelInboundTurn,
  getGroupThreadDeliverySession,
  readAgentRunTerminalOutcome,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  bindIngressLifecycleToReplyOptions,
  type LivePreviewDeliveryResult,
  resolveChannelMessageSourceReplyDeliveryMode,
  resolveTranscriptBackedChannelFinalText,
} from "openclaw/plugin-sdk/channel-outbound";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import {
  getReplyPayloadTtsSupplement,
  isReplyPayloadNonTerminalToolErrorWarning,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type {
  GetReplyOptions,
  ReplyDispatchRuntimeInfo,
  ReplyPayload,
} from "openclaw/plugin-sdk/reply-runtime";
import { danger, logVerbose, sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { getSessionEntryAsync, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { createDiscordActiveTurnThreadRouteHolder } from "../active-turn-thread-route.js";
import { chunkDiscordTextWithMode } from "../chunk.js";
import { discordTextHasBroadcastMention } from "../mentions.js";
import { buildDiscordMessageProcessContext } from "./message-handler.context.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.types.js";
import { createDiscordMessageReactionRuntime } from "./message-handler.process-reactions.js";
import {
  createDiscordBeforePayloadDelivery,
  createDiscordMessageReplyRuntime,
  formatDiscordReasoningQuote,
  formatDiscordGroupThreadReply,
} from "./message-handler.process-reply-runtime.js";
import { completeDiscordSessionConflict } from "./message-handler.retry.js";
import {
  deliverDiscordReply,
  formatDiscordReplyDeliveryFailure,
  formatDiscordReplySkip,
} from "./reply-delivery.js";
import { sanitizeDiscordFrontChannelReplyPayloads } from "./reply-safety.js";
import { resolveDiscordWebhookId } from "./sender-identity.js";

const TARGETED_ONLY_ALLOWED_MENTIONS: APIAllowedMentions = {
  parse: [AllowedMentionsTypes.User, AllowedMentionsTypes.Role],
};

function isFallbackOnlyToolWarningFinal(payload: ReplyPayload): boolean {
  if (payload.isError !== true || !isReplyPayloadNonTerminalToolErrorWarning(payload)) {
    return false;
  }
  return !resolveSendableOutboundReplyParts(payload).hasMedia;
}

type DiscordProviderDeliveryInfo = ReplyDispatchRuntimeInfo & {
  onPlatformSendDispatch: () => Promise<void>;
  assertPlatformSendAuthorized: () => void;
};

export async function processDiscordMessage(ctx: DiscordMessagePreflightContext) {
  const dispatchStartedAt = Date.now();
  const {
    cfg,
    accountId,
    token,
    runtime,
    textLimit,
    replyToMode,
    message,
    messageChannelId,
    isGuildMessage,
    isDirectMessage,
    isGroupDm,
    messageText: text,
    threadBindings,
    route,
    abortSignal,
    isPolicyCurrent,
    turnAdoptionLifecycle,
    preparedMedia: mediaList,
  } = ctx;
  if (abortSignal?.aborted || isPolicyCurrent?.() === false) {
    return;
  }
  if (!text && mediaList.length === 0) {
    logVerbose("discord: drop message " + message.id + " (empty content)");
    return;
  }

  const boundThreadId = ctx.threadBinding?.conversation?.conversationId?.trim();
  if (boundThreadId && typeof threadBindings.touchThread === "function") {
    try {
      await threadBindings.touchThread({ threadId: boundThreadId });
    } catch (error) {
      // Activity persistence must not suppress an otherwise authorized inbound turn.
      runtime.error(
        danger(
          `discord: failed to refresh thread binding activity (${boundThreadId}): ${String(error)}`,
        ),
      );
    }
    if (abortSignal?.aborted || isPolicyCurrent?.() === false) {
      return;
    }
  }
  const sourceReplyDeliveryMode = resolveChannelMessageSourceReplyDeliveryMode({
    cfg,
    ctx: {
      ChatType: isDirectMessage
        ? "direct"
        : isGroupDm
          ? "group"
          : isGuildMessage
            ? "channel"
            : undefined,
      InboundEventKind: ctx.inboundEventKind,
    },
  });
  const sourceRepliesAreToolOnly = sourceReplyDeliveryMode === "message_tool_only";
  const routedAgentConfig = resolveAgentConfig(cfg, route.agentId);
  const configuredTypingMode = routedAgentConfig?.typingMode ?? cfg.agents?.defaults?.typingMode;
  const configuredTypingInterval = cfg.agents?.defaults?.typingIntervalSeconds;
  const shouldDisableCoreTypingKeepalive =
    sourceRepliesAreToolOnly &&
    configuredTypingMode === undefined &&
    configuredTypingInterval === undefined;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
  const isRoomEvent = ctx.inboundEventKind === "room_event";
  const reactions = createDiscordMessageReactionRuntime({
    ctx,
    sourceRepliesAreToolOnly,
    isRoomEvent,
  });
  const processContext = await buildDiscordMessageProcessContext({
    ctx,
    text,
    mediaList,
  });
  if (!processContext) {
    return;
  }
  const { ctxPayload, persistedSessionKey, record, replyPlan } = processContext;
  let deliverTarget = replyPlan.deliverTarget;
  const sourceMessageId = ctx.canonicalMessageId ?? message.id;
  const sourceReplyReference = replyPlan.replyReference;
  let adoptedThreadId: string | undefined;
  // Delivery is dispatch-scoped: the model may continue after the message tool
  // returns, but that continuation cannot undo the visible thread reply.
  let threadReplyDelivered = false;
  let onThreadAdopted: ((threadId: string) => Promise<void>) | undefined = undefined;
  const activeThreadRoute = createDiscordActiveTurnThreadRouteHolder(ctxPayload.SessionKey, {
    accountId,
    sourceChannelId: messageChannelId,
    sourceMessageId,
    onThreadAdopted: async (threadId) => {
      // Route identity must change before migration so a successful thread
      // reply remains current-source even when moving the draft later fails.
      adoptedThreadId = threadId;
      await onThreadAdopted?.(threadId);
    },
    onThreadReplyDelivered: () => {
      threadReplyDelivered = true;
    },
    onThreadAdoptionError: (error) => {
      logVerbose(`discord: failed to move active progress into adopted thread (${String(error)})`);
    },
  });
  const replyReference = {
    peek: () => (adoptedThreadId ? undefined : sourceReplyReference.peek()),
    use: () => (adoptedThreadId ? undefined : sourceReplyReference.use()),
    markSent: () => sourceReplyReference.markSent(),
  };
  const {
    replyPipeline,
    onModelSelected,
    tableMode,
    maxLinesPerMessage,
    chunkMode,
    beginQueuedDeliveryCorrelation,
    endDeliveryCorrelation,
    resolveCurrentTurnTranscriptFinalText,
    draftPreview,
    resolvedBlockStreamingEnabled,
  } = createDiscordMessageReplyRuntime({
    ctx,
    processContext,
    replyReference,
    sourceRepliesAreToolOnly,
    shouldDisableCoreTypingKeepalive,
    isRoomEvent,
    dispatchStartedAt,
    feedbackRest: reactions.feedbackRest,
    deliveryRest: reactions.deliveryRest,
  });
  onThreadAdopted = async (threadId) => {
    deliverTarget = `channel:${threadId}`;
    await draftPreview.retarget(threadId);
  };
  const { lifecycle } = draftPreview;
  const hasCompletedFinalReply = () => lifecycle.finalSucceeded || lifecycle.previewFinalized;
  const observeFinalDelivery = async () => {
    if (lifecycle.finalSucceeded) {
      return;
    }
    draftPreview.freezeProgress();
    const retainedProgress =
      threadReplyDelivered && !lifecycle.previewFinalized
        ? draftPreview.finalizeProgressDraft().catch((error: unknown) => {
            logVerbose(`discord: failed to finalize adopted thread progress (${String(error)})`);
          })
        : undefined;
    // This callback records a confirmed source send, not the draft's message ID.
    await lifecycle.observeDelivery({ visibleReplySent: true });
    await retainedProgress;
  };
  let pendingToolWarningFinal:
    | {
        payload: ReplyPayload;
        info: DiscordProviderDeliveryInfo;
        deliverySession: ReturnType<typeof getGroupThreadDeliverySession>;
      }
    | undefined;
  const progressSessionKey = ctxPayload.SessionKey;
  // Reasoning delivery follows the session /reasoning level, not streaming config.
  const reasoningLevel = await (async (): Promise<"on" | "stream" | "off"> => {
    const agentEntryDefault = resolveAgentConfig(cfg, route.agentId ?? "main")?.reasoningDefault;
    const cfgDefault = agentEntryDefault ?? cfg.agents?.defaults?.reasoningDefault;
    const configDefault: "on" | "stream" | "off" =
      cfgDefault === "on" || cfgDefault === "stream" ? cfgDefault : "off";
    if (!progressSessionKey) {
      return configDefault;
    }
    try {
      const storePath = resolveStorePath(cfg.session?.store, { agentId: route.agentId });
      const level = (
        await getSessionEntryAsync({
          agentId: route.agentId,
          sessionKey: progressSessionKey,
          storePath,
        })
      )?.reasoningLevel;
      if (level === "on" || level === "stream" || level === "off") {
        return level;
      }
    } catch {
      return "off";
    }
    return configDefault;
  })();
  const reasoningDurableEnabled = reasoningLevel === "on";
  const reasoningWindowEnabled = reasoningLevel === "stream";
  // The durable verbose lane mirrors commentary, not tool lifecycle rows.
  // Yield only the draft content that has a durable counterpart.
  let shouldYieldDraftCommentary = async () => false;
  let turnCommentaryVisible = false;
  const progressReplyOptions: Partial<Omit<GetReplyOptions, "onBlockReply">> = {
    progressRequiresReply: draftPreview.isProgressMode ? true : undefined,
    onAssistantMessageStart: draftPreview.draftStream
      ? () => {
          if (draftPreview.handleAssistantMessageBoundary()) {
            pendingToolWarningFinal = undefined;
          }
          return false;
        }
      : undefined,
    onReasoningEnd: draftPreview.draftStream
      ? () => {
          draftPreview.resetReasoningProgress();
          return false;
        }
      : undefined,
    onQueuedFollowupAdmitted: () => {
      activeThreadRoute.holdQueued();
      if (draftPreview.draftStream && draftPreview.handleQueuedFollowupAdmitted()) {
        pendingToolWarningFinal = undefined;
      }
    },
    // Queued turns can finish after dispatch closeout has already cleaned up.
    onQueuedFollowupSettled: () => {
      activeThreadRoute.releaseQueued();
      return draftPreview.draftStream ? draftPreview.cleanup() : undefined;
    },
    suppressDefaultToolProgressMessages:
      (sourceRepliesAreToolOnly && reactions.statusReactionsExplicitlyEnabled) ||
      draftPreview.suppressDefaultToolProgressMessages
        ? true
        : undefined,
    allowToolLifecycleWhenProgressHidden: reactions.statusReactionsEnabled ? true : undefined,
    commentaryProgressEnabled: draftPreview.isProgressMode
      ? draftPreview.commentaryProgressEnabled
      : undefined,
    progressPreambleEnabled:
      draftPreview.draftStream && draftPreview.isProgressMode ? true : undefined,
    commentaryPayloadsEnabled: draftPreview.isProgressMode
      ? draftPreview.commentaryProgressEnabled
      : undefined,
    shouldDeliverCommentaryPayloads:
      draftPreview.isProgressMode && draftPreview.commentaryProgressEnabled
        ? () => turnCommentaryVisible
        : undefined,
    reasoningPayloadsEnabled: reasoningDurableEnabled,
    onVerboseProgressVisibilityAsync: async (isActive) => {
      shouldYieldDraftCommentary = isActive;
      turnCommentaryVisible = await isActive();
    },
    onNarrationUpdate: draftPreview.narrationProgressEnabled
      ? async (payload) => {
          if ((await shouldYieldDraftCommentary()) || abortSignal?.aborted) {
            return;
          }
          await draftPreview.pushNarrationProgress(payload.text);
        }
      : undefined,
    onProgressNarratorLifecycle: draftPreview.narrationProgressEnabled
      ? (progressLifecycle) => draftPreview.setProgressNarratorLifecycle(progressLifecycle)
      : undefined,
    isProgressDraftVisible: draftPreview.narrationProgressEnabled
      ? () => draftPreview.isProgressDraftVisible
      : undefined,
    narrationHideCommandText: draftPreview.narrationHideCommandText ? true : undefined,
    onReasoningStream: async (payload) => {
      if (payload?.requiresReasoningProgressOptIn === true && !reasoningWindowEnabled) {
        return false;
      }
      await reactions.controller.setThinking();
      return await draftPreview.pushReasoningProgress(payload?.text, {
        snapshot: payload?.isReasoningSnapshot === true,
      });
    },
    streamReasoningInNonStreamModes: reasoningWindowEnabled,
    onToolStart: async (payload) => {
      if (abortSignal?.aborted) {
        return false;
      }
      await reactions.maybeBindToToolReaction(payload);
      await reactions.controller.setTool(payload.name);
      return await draftPreview.pushToolEvent(payload);
    },
    onItemEvent: async (payload) => {
      if (
        abortSignal?.aborted ||
        (payload.kind === "preamble" && (await shouldYieldDraftCommentary()))
      ) {
        return undefined;
      }
      return await draftPreview.pushItemEvent(payload);
    },
    onPlanUpdate: async (payload) => {
      if (payload.phase === "update") {
        return await draftPreview.pushPlanProgress(payload.steps, {
          explanation: payload.explanation,
          explanationFormat: payload.explanationFormat,
        });
      }
      return false;
    },
    onApprovalEvent: async (payload) => {
      return await draftPreview.pushApprovalEvent(payload);
    },
    onCompactionStart: async () => {
      if (!abortSignal?.aborted) {
        await reactions.controller.setCompacting();
      }
      return false;
    },
    onCompactionEnd: async () => {
      if (!abortSignal?.aborted) {
        reactions.controller.cancelPending();
        await reactions.controller.setThinking();
      }
      return false;
    },
  };
  let replyLifecycleStarted = false;
  const onDiscordReplyStart = async () => {
    if (abortSignal?.aborted) {
      return;
    }
    replyLifecycleStarted = true;
    await replyPipeline.typingCallbacks?.onReplyStart();
    await reactions.controller.setThinking();
  };
  const beforeDiscordPayloadDelivery = createDiscordBeforePayloadDelivery({
    abortSignal,
    getDeliverTarget: () => deliverTarget,
    sessionKey: ctxPayload.SessionKey,
    draftPreview,
    isFallbackOnlyToolWarningFinal,
  });

  const deliverDiscordPayload = async (
    incomingPayload: ReplyPayload,
    info: DiscordProviderDeliveryInfo,
    options?: {
      allowFallbackOnlyToolWarning?: boolean;
      deliverySession?: ReturnType<typeof getGroupThreadDeliverySession>;
    },
  ) => {
    const logSkippedDelivery = (reason: Parameters<typeof formatDiscordReplySkip>[0]["reason"]) =>
      logVerbose(
        formatDiscordReplySkip({
          kind: info.kind,
          reason,
          target: deliverTarget,
          sessionKey: ctxPayload.SessionKey,
        }),
      );
    if (abortSignal?.aborted) {
      // Surface so operators don't chase missing replies when an abort
      // drops a model-produced text payload.
      logSkippedDelivery("aborted before delivery");
      return { visibleReplySent: false };
    }
    const deliverySession = options?.deliverySession ?? getGroupThreadDeliverySession();
    const deliveryOptions = {
      cfg,
      token,
      accountId,
      rest: reactions.deliveryRest,
      replyToMode,
      textLimit,
      maxLinesPerMessage,
      tableMode,
      chunkMode,
      sessionKey: deliverySession?.sessionKey ?? ctxPayload.SessionKey,
      threadBindings,
      mediaLocalRoots: deliverySession
        ? getAgentScopedMediaLocalRoots(cfg, deliverySession.agentId)
        : mediaLocalRoots,
      bindPendingFinalDelivery: info.bindPendingFinalDelivery,
      onPlatformSendDispatch: info.onPlatformSendDispatch,
      assertPlatformSendAuthorized: info.assertPlatformSendAuthorized,
    };
    let payload = incomingPayload;
    if (info.participant && (payload.text || payload.mediaUrl || payload.mediaUrls?.length)) {
      payload = {
        ...payload,
        text: formatDiscordGroupThreadReply(payload.text ?? "", info.participant),
      };
    }
    const isFinal = info.kind === "final";
    if (payload.isReasoning) {
      const raw = (payload.text ?? "").trim();
      const body = raw.startsWith("Reasoning:\n") ? raw.slice("Reasoning:\n".length).trim() : raw;
      if (!body) {
        return { visibleReplySent: false };
      }
      const chunkLimit = Math.max(256, Math.min(textLimit, 2000) - 8);
      const chunks = chunkDiscordTextWithMode(body, {
        maxChars: chunkLimit,
        maxLines: maxLinesPerMessage,
        chunkMode,
      });
      const replies = (chunks.length ? chunks : [body])
        .map((chunk) => formatDiscordReasoningQuote(chunk))
        .filter((quote): quote is string => Boolean(quote))
        .map((quote) => Object.assign({}, payload, { text: quote, isReasoning: undefined }));
      if (!replies.length) {
        return { visibleReplySent: false };
      }
      const result = await deliverDiscordReply({
        ...deliveryOptions,
        replies,
        target: deliverTarget,
        replyToId: replyReference.use(),
        kind: "block",
      });
      if (result.visibleReplySent) {
        replyReference.markSent();
      }
      return result;
    }
    if (
      isFinal &&
      !options?.allowFallbackOnlyToolWarning &&
      isFallbackOnlyToolWarningFinal(payload)
    ) {
      if (!hasCompletedFinalReply() && (!lifecycle.finalStarted || lifecycle.finalFailed)) {
        // Root settlement can outlive this participant's dispatch scope.
        pendingToolWarningFinal = { payload, info, deliverySession };
      }
      return { visibleReplySent: false };
    }
    if (isFinal) {
      draftPreview.freezeProgress();
    }
    const finalText =
      isFinal && !ctxPayload.GroupThread && typeof payload.text === "string"
        ? await resolveTranscriptBackedChannelFinalText({
            payload,
            finalText: payload.text,
            resolveCandidateText: resolveCurrentTurnTranscriptFinalText,
          })
        : payload.text;
    const effectivePayload = finalText !== payload.text ? { ...payload, text: finalText } : payload;
    const [deliverablePayload] = sanitizeDiscordFrontChannelReplyPayloads([effectivePayload], {
      kind: info.kind,
    });
    if (!deliverablePayload) {
      logSkippedDelivery("internal-only payload");
      return { visibleReplySent: false };
    }
    if (await draftPreview.adoptProgressDraft(deliverablePayload, info)) {
      replyReference.markSent();
      return { visibleReplySent: true };
    }
    if (isFinal && !replyLifecycleStarted && !isRoomEvent && configuredTypingMode !== "never") {
      // Fast replies can bypass the normal resolver lifecycle. Start feedback
      // only after a deliverable final survives every suppression boundary.
      await onDiscordReplyStart();
    }
    const draftStream = draftPreview.draftStream;
    if (
      draftStream &&
      draftPreview.isProgressMode &&
      info.kind === "block" &&
      !deliverablePayload.isCommentary
    ) {
      const reply = resolveSendableOutboundReplyParts(deliverablePayload);
      if (!reply.hasMedia && !deliverablePayload.isError) {
        return { visibleReplySent: false };
      }
    }
    let deliveryResult: LivePreviewDeliveryResult = { visibleReplySent: false };
    await lifecycle.deliver({
      kind: info.kind,
      payload: deliverablePayload,
      isError: deliverablePayload.isError === true,
      deliverNormally: async () => {
        if (abortSignal?.aborted) {
          logSkippedDelivery("aborted before delivery");
          return deliveryResult;
        }
        // Final replies need MESSAGE_CREATE so Discord advances unread state.
        const freshPreviewFinal =
          draftStream && isFinal && !draftPreview.isProgressMode && !deliverablePayload.isError;
        const ttsSupplement = freshPreviewFinal
          ? getReplyPayloadTtsSupplement(deliverablePayload)
          : undefined;
        const finalPayload =
          ttsSupplement &&
          ttsSupplement.visibleTextAlreadyDelivered !== true &&
          !deliverablePayload.text?.trim()
            ? { ...deliverablePayload, text: ttsSupplement.spokenText }
            : deliverablePayload;
        // Preserve intended user/role pings without escalating broadcast mentions.
        const allowedMentions =
          freshPreviewFinal && discordTextHasBroadcastMention(finalPayload.text ?? "")
            ? TARGETED_ONLY_ALLOWED_MENTIONS
            : undefined;
        deliveryResult = await deliverDiscordReply({
          ...deliveryOptions,
          replies: [finalPayload],
          target: deliverTarget,
          replyToId: replyReference.use(),
          allowedMentions,
          kind: info.kind,
        });
        return deliveryResult;
      },
      onNormalDelivered: () => replyReference.markSent(),
    });
    return deliveryResult;
  };
  const onDiscordDeliveryError = (err: unknown, info: { kind: string }) => {
    if (info.kind === "final") {
      lifecycle.observeFailure();
    }
    runtime.error(
      danger(
        formatDiscordReplyDeliveryFailure({
          kind: info.kind,
          err,
          target: deliverTarget,
          sessionKey: ctxPayload.SessionKey,
        }),
      ),
    );
  };
  type DispatchResult = Extract<
    Awaited<ReturnType<typeof dispatchChannelInboundTurn>>,
    { dispatched: true }
  >["dispatchResult"];
  let dispatchResult: DispatchResult | null = null;
  let dispatchError = false;
  let dispatchAborted = false;
  const deliverPendingToolWarningFinalIfNeeded = async () => {
    if (!pendingToolWarningFinal || hasCompletedFinalReply() || abortSignal?.aborted) {
      return undefined;
    }
    const pending = pendingToolWarningFinal;
    pendingToolWarningFinal = undefined;
    try {
      return await deliverDiscordPayload(pending.payload, pending.info, {
        allowFallbackOnlyToolWarning: true,
        deliverySession: pending.deliverySession,
      });
    } catch (err) {
      dispatchError = true;
      onDiscordDeliveryError(err, pending.info);
      return { visibleReplySent: false };
    }
  };
  try {
    if (abortSignal?.aborted || isPolicyCurrent?.() === false) {
      dispatchAborted = true;
      return;
    }
    const preparedResult = await dispatchChannelInboundTurn({
      cfg,
      channel: "discord",
      accountId: route.accountId,
      outboundEchoSourceId: resolveDiscordWebhookId(message) ?? undefined,
      route: { agentId: route.agentId, sessionKey: persistedSessionKey },
      ctxPayload,
      afterRecord: reactions.queueInitialAckReactionAfterRecord,
      sessionInitRetry: {
        delaysMs: [250, 1_000, 2_500],
        signal: abortSignal,
        sleep: sleepWithAbort,
      },
      dispatcherOptions: {
        ...replyPipeline,
        humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
        beforeDeliver: beforeDiscordPayloadDelivery,
        onReplyStart: onDiscordReplyStart,
        onFreshSettledDelivery: deliverPendingToolWarningFinalIfNeeded,
      },
      delivery: {
        deliverWithProviderMessageSending: deliverDiscordPayload,
        onError: onDiscordDeliveryError,
      },
      record,
      history: isRoomEvent
        ? undefined
        : {
            isGroup: isGuildMessage,
            historyKey: messageChannelId,
            historyMap: ctx.guildHistories,
            limit: ctx.historyLimit,
          },
      replyOptions: {
        groupThreadReplyFormatter: formatDiscordGroupThreadReply,
        ...(turnAdoptionLifecycle ? bindIngressLifecycleToReplyOptions(turnAdoptionLifecycle) : {}),
        abortSignal,
        skillFilter: ctx.channelConfig?.skills,
        sourceReplyDeliveryMode,
        typingKeepalive: shouldDisableCoreTypingKeepalive ? false : undefined,
        // The primary turn already owns one correlation; each queued followup
        // needs a fresh owner so its eventual delivery clears room history.
        queuedDeliveryCorrelations: isRoomEvent
          ? [{ begin: beginQueuedDeliveryCorrelation }]
          : undefined,
        suppressTyping: isRoomEvent ? true : undefined,
        allowProgressCallbacksWhenSourceDeliverySuppressed:
          sourceRepliesAreToolOnly && draftPreview.draftStream && draftPreview.isProgressMode
            ? true
            : undefined,
        disableBlockStreaming: sourceRepliesAreToolOnly
          ? true
          : (draftPreview.disableBlockStreamingForDraft ??
            (typeof resolvedBlockStreamingEnabled === "boolean"
              ? !resolvedBlockStreamingEnabled
              : undefined)),
        onPartialReply:
          draftPreview.draftStream && !draftPreview.isProgressMode
            ? (payload) => draftPreview.updateFromPartial(payload.text)
            : undefined,
        ...progressReplyOptions,
        onObservedReplyDelivery: observeFinalDelivery,
        onModelSelected,
      },
    });
    if (!preparedResult.dispatched) {
      return;
    }
    dispatchResult = preparedResult.dispatchResult;
    if (abortSignal?.aborted) {
      dispatchAborted = true;
      return;
    }
    if (threadReplyDelivered) {
      await observeFinalDelivery();
    }
  } catch (err) {
    if (abortSignal?.aborted) {
      dispatchAborted = true;
      return;
    }
    dispatchError = true;
    const conflictOutcome = await completeDiscordSessionConflict(
      err,
      sourceReplyDeliveryMode,
      (payload, info) =>
        deliverDiscordPayload(payload, {
          ...info,
          onPlatformSendDispatch: () => Promise.resolve(),
          assertPlatformSendAuthorized: () => undefined,
        }),
      onDiscordDeliveryError,
    );
    if (conflictOutcome) {
      runtime.error(
        `discord: reply session init conflict exhausted; terminal notice ${conflictOutcome} ` +
          `(sourceReplyDeliveryMode=${sourceReplyDeliveryMode}, message=${message.id}, session=${persistedSessionKey})`,
      );
      // Both a delivered notice and recorded policy suppression consume the event.
      return;
    }
    throw err;
  } finally {
    activeThreadRoute.end();
    endDeliveryCorrelation();
    dispatchError ||= readAgentRunTerminalOutcome(dispatchResult) === "failed";
    const finalReceipt = dispatchResult?.settledReceipt?.counts.final;
    const finalDeliveryFailed =
      (finalReceipt?.failedBeforeSend ?? 0) + (finalReceipt?.failedAfterSend ?? 0) > 0;
    await draftPreview.cleanup({ failed: finalDeliveryFailed || dispatchError });
    await reactions.finish({ dispatchAborted, dispatchError, finalDeliveryFailed });
  }
}
