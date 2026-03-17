import { resolveAgentDir } from "../../../src/agents/agent-scope.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision
} from "../../../src/agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../../../src/agents/model-selection.js";
import { resolveChunkMode } from "../../../src/auto-reply/chunk.js";
import { clearHistoryEntriesIfEnabled } from "../../../src/auto-reply/reply/history.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../../../src/auto-reply/reply/provider-dispatcher.js";
import { removeAckReactionAfterReply } from "../../../src/channels/ack-reactions.js";
import { logAckFailure, logTypingFailure } from "../../../src/channels/logging.js";
import { createReplyPrefixOptions } from "../../../src/channels/reply-prefix.js";
import { createTypingCallbacks } from "../../../src/channels/typing.js";
import { resolveMarkdownTableMode } from "../../../src/config/markdown-tables.js";
import {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath
} from "../../../src/config/sessions.js";
import { danger, logVerbose } from "../../../src/globals.js";
import { getAgentScopedMediaLocalRoots } from "../../../src/media/local-roots.js";
import { deliverReplies } from "./bot/delivery.js";
import { createTelegramDraftStream } from "./draft-stream.js";
import { shouldSuppressLocalTelegramExecApprovalPrompt } from "./exec-approvals.js";
import { renderTelegramHtmlText } from "./format.js";
import {
  createLaneDeliveryStateTracker,
  createLaneTextDeliverer
} from "./lane-delivery.js";
import {
  createTelegramReasoningStepState,
  splitTelegramReasoningText
} from "./reasoning-lane-coordinator.js";
import { editMessageTelegram } from "./send.js";
import { cacheSticker, describeStickerImage } from "./sticker-cache.js";
const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";
const DRAFT_MIN_INITIAL_CHARS = 30;
async function resolveStickerVisionSupport(cfg, agentId) {
  try {
    const catalog = await loadModelCatalog({ config: cfg });
    const defaultModel = resolveDefaultModelForAgent({ cfg, agentId });
    const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
    if (!entry) {
      return false;
    }
    return modelSupportsVision(entry);
  } catch {
    return false;
  }
}
function pruneStickerMediaFromContext(ctxPayload, opts) {
  if (opts?.stickerMediaIncluded === false) {
    return;
  }
  const nextMediaPaths = Array.isArray(ctxPayload.MediaPaths) ? ctxPayload.MediaPaths.slice(1) : void 0;
  const nextMediaUrls = Array.isArray(ctxPayload.MediaUrls) ? ctxPayload.MediaUrls.slice(1) : void 0;
  const nextMediaTypes = Array.isArray(ctxPayload.MediaTypes) ? ctxPayload.MediaTypes.slice(1) : void 0;
  ctxPayload.MediaPaths = nextMediaPaths && nextMediaPaths.length > 0 ? nextMediaPaths : void 0;
  ctxPayload.MediaUrls = nextMediaUrls && nextMediaUrls.length > 0 ? nextMediaUrls : void 0;
  ctxPayload.MediaTypes = nextMediaTypes && nextMediaTypes.length > 0 ? nextMediaTypes : void 0;
  ctxPayload.MediaPath = ctxPayload.MediaPaths?.[0];
  ctxPayload.MediaUrl = ctxPayload.MediaUrls?.[0] ?? ctxPayload.MediaPath;
  ctxPayload.MediaType = ctxPayload.MediaTypes?.[0];
}
function resolveTelegramReasoningLevel(params) {
  const { cfg, sessionKey, agentId } = params;
  if (!sessionKey) {
    return "off";
  }
  try {
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    const store = loadSessionStore(storePath, { skipCache: true });
    const entry = resolveSessionStoreEntry({ store, sessionKey }).existing;
    const level = entry?.reasoningLevel;
    if (level === "on" || level === "stream") {
      return level;
    }
  } catch {
  }
  return "off";
}
const dispatchTelegramMessage = async ({
  context,
  bot,
  cfg,
  runtime,
  replyToMode,
  streamMode,
  textLimit,
  telegramCfg,
  opts
}) => {
  const {
    ctxPayload,
    msg,
    chatId,
    isGroup,
    threadSpec,
    historyKey,
    historyLimit,
    groupHistories,
    route,
    skillFilter,
    sendTyping,
    sendRecordVoice,
    ackReactionPromise,
    reactionApi,
    removeAckAfterReply,
    statusReactionController
  } = context;
  const draftMaxChars = Math.min(textLimit, 4096);
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "telegram",
    accountId: route.accountId
  });
  const renderDraftPreview = (text) => ({
    text: renderTelegramHtmlText(text, { tableMode }),
    parseMode: "HTML"
  });
  const accountBlockStreamingEnabled = typeof telegramCfg.blockStreaming === "boolean" ? telegramCfg.blockStreaming : cfg.agents?.defaults?.blockStreamingDefault === "on";
  const resolvedReasoningLevel = resolveTelegramReasoningLevel({
    cfg,
    sessionKey: ctxPayload.SessionKey,
    agentId: route.agentId
  });
  const forceBlockStreamingForReasoning = resolvedReasoningLevel === "on";
  const streamReasoningDraft = resolvedReasoningLevel === "stream";
  const previewStreamingEnabled = streamMode !== "off";
  const canStreamAnswerDraft = previewStreamingEnabled && !accountBlockStreamingEnabled && !forceBlockStreamingForReasoning;
  const canStreamReasoningDraft = canStreamAnswerDraft || streamReasoningDraft;
  const draftReplyToMessageId = replyToMode !== "off" && typeof msg.message_id === "number" ? msg.message_id : void 0;
  const draftMinInitialChars = DRAFT_MIN_INITIAL_CHARS;
  const useMessagePreviewTransportForDm = threadSpec?.scope === "dm" && canStreamAnswerDraft;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
  const archivedAnswerPreviews = [];
  const archivedReasoningPreviewIds = [];
  const createDraftLane = (laneName, enabled) => {
    const stream = enabled ? createTelegramDraftStream({
      api: bot.api,
      chatId,
      maxChars: draftMaxChars,
      thread: threadSpec,
      previewTransport: useMessagePreviewTransportForDm ? "message" : "auto",
      replyToMessageId: draftReplyToMessageId,
      minInitialChars: draftMinInitialChars,
      renderText: renderDraftPreview,
      onSupersededPreview: laneName === "answer" || laneName === "reasoning" ? (preview) => {
        if (laneName === "reasoning") {
          if (!archivedReasoningPreviewIds.includes(preview.messageId)) {
            archivedReasoningPreviewIds.push(preview.messageId);
          }
          return;
        }
        archivedAnswerPreviews.push({
          messageId: preview.messageId,
          textSnapshot: preview.textSnapshot,
          deleteIfUnused: true
        });
      } : void 0,
      log: logVerbose,
      warn: logVerbose
    }) : void 0;
    return {
      stream,
      lastPartialText: "",
      hasStreamedMessage: false
    };
  };
  const lanes = {
    answer: createDraftLane("answer", canStreamAnswerDraft),
    reasoning: createDraftLane("reasoning", canStreamReasoningDraft)
  };
  const activePreviewLifecycleByLane = {
    answer: "transient",
    reasoning: "transient"
  };
  const retainPreviewOnCleanupByLane = {
    answer: false,
    reasoning: false
  };
  const answerLane = lanes.answer;
  const reasoningLane = lanes.reasoning;
  let splitReasoningOnNextStream = false;
  let skipNextAnswerMessageStartRotation = false;
  let draftLaneEventQueue = Promise.resolve();
  const reasoningStepState = createTelegramReasoningStepState();
  const enqueueDraftLaneEvent = (task) => {
    const next = draftLaneEventQueue.then(task);
    draftLaneEventQueue = next.catch((err) => {
      logVerbose(`telegram: draft lane callback failed: ${String(err)}`);
    });
    return draftLaneEventQueue;
  };
  const splitTextIntoLaneSegments = (text) => {
    const split = splitTelegramReasoningText(text);
    const segments = [];
    const suppressReasoning = resolvedReasoningLevel === "off";
    if (split.reasoningText && !suppressReasoning) {
      segments.push({ lane: "reasoning", text: split.reasoningText });
    }
    if (split.answerText) {
      segments.push({ lane: "answer", text: split.answerText });
    }
    return {
      segments,
      suppressedReasoningOnly: Boolean(split.reasoningText) && suppressReasoning && !split.answerText
    };
  };
  const resetDraftLaneState = (lane) => {
    lane.lastPartialText = "";
    lane.hasStreamedMessage = false;
  };
  const rotateAnswerLaneForNewAssistantMessage = async () => {
    let didForceNewMessage = false;
    if (answerLane.hasStreamedMessage) {
      const materializedId = await answerLane.stream?.materialize?.();
      const previewMessageId = materializedId ?? answerLane.stream?.messageId();
      if (typeof previewMessageId === "number" && activePreviewLifecycleByLane.answer === "transient") {
        archivedAnswerPreviews.push({
          messageId: previewMessageId,
          textSnapshot: answerLane.lastPartialText,
          deleteIfUnused: false
        });
      }
      answerLane.stream?.forceNewMessage();
      didForceNewMessage = true;
    }
    resetDraftLaneState(answerLane);
    if (didForceNewMessage) {
      activePreviewLifecycleByLane.answer = "transient";
      retainPreviewOnCleanupByLane.answer = false;
    }
    return didForceNewMessage;
  };
  const updateDraftFromPartial = (lane, text) => {
    const laneStream = lane.stream;
    if (!laneStream || !text) {
      return;
    }
    if (text === lane.lastPartialText) {
      return;
    }
    lane.hasStreamedMessage = true;
    if (lane.lastPartialText && lane.lastPartialText.startsWith(text) && text.length < lane.lastPartialText.length) {
      return;
    }
    lane.lastPartialText = text;
    laneStream.update(text);
  };
  const ingestDraftLaneSegments = async (text) => {
    const split = splitTextIntoLaneSegments(text);
    const hasAnswerSegment = split.segments.some((segment) => segment.lane === "answer");
    if (hasAnswerSegment && activePreviewLifecycleByLane.answer !== "transient") {
      skipNextAnswerMessageStartRotation = await rotateAnswerLaneForNewAssistantMessage();
    }
    for (const segment of split.segments) {
      if (segment.lane === "reasoning") {
        reasoningStepState.noteReasoningHint();
        reasoningStepState.noteReasoningDelivered();
      }
      updateDraftFromPartial(lanes[segment.lane], segment.text);
    }
  };
  const flushDraftLane = async (lane) => {
    if (!lane.stream) {
      return;
    }
    await lane.stream.flush();
  };
  const disableBlockStreaming = !previewStreamingEnabled ? true : forceBlockStreamingForReasoning ? false : typeof telegramCfg.blockStreaming === "boolean" ? !telegramCfg.blockStreaming : canStreamAnswerDraft ? true : void 0;
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: "telegram",
    accountId: route.accountId
  });
  const chunkMode = resolveChunkMode(cfg, "telegram", route.accountId);
  const sticker = ctxPayload.Sticker;
  if (sticker?.fileId && sticker.fileUniqueId && ctxPayload.MediaPath) {
    const agentDir = resolveAgentDir(cfg, route.agentId);
    const stickerSupportsVision = await resolveStickerVisionSupport(cfg, route.agentId);
    let description = sticker.cachedDescription ?? null;
    if (!description) {
      description = await describeStickerImage({
        imagePath: ctxPayload.MediaPath,
        cfg,
        agentDir,
        agentId: route.agentId
      });
    }
    if (description) {
      const stickerContext = [sticker.emoji, sticker.setName ? `from "${sticker.setName}"` : null].filter(Boolean).join(" ");
      const formattedDesc = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${description}`;
      sticker.cachedDescription = description;
      if (!stickerSupportsVision) {
        ctxPayload.Body = formattedDesc;
        ctxPayload.BodyForAgent = formattedDesc;
        pruneStickerMediaFromContext(ctxPayload, {
          stickerMediaIncluded: ctxPayload.StickerMediaIncluded
        });
      }
      if (sticker.fileId) {
        cacheSticker({
          fileId: sticker.fileId,
          fileUniqueId: sticker.fileUniqueId,
          emoji: sticker.emoji,
          setName: sticker.setName,
          description,
          cachedAt: (/* @__PURE__ */ new Date()).toISOString(),
          receivedFrom: ctxPayload.From
        });
        logVerbose(`telegram: cached sticker description for ${sticker.fileUniqueId}`);
      } else {
        logVerbose(`telegram: skipped sticker cache (missing fileId)`);
      }
    }
  }
  const replyQuoteText = ctxPayload.ReplyToIsQuote && ctxPayload.ReplyToBody ? ctxPayload.ReplyToBody.trim() || void 0 : void 0;
  const deliveryState = createLaneDeliveryStateTracker();
  const clearGroupHistory = () => {
    if (isGroup && historyKey) {
      clearHistoryEntriesIfEnabled({ historyMap: groupHistories, historyKey, limit: historyLimit });
    }
  };
  const deliveryBaseOptions = {
    chatId: String(chatId),
    accountId: route.accountId,
    sessionKeyForInternalHooks: ctxPayload.SessionKey,
    mirrorIsGroup: isGroup,
    mirrorGroupId: isGroup ? String(chatId) : void 0,
    token: opts.token,
    runtime,
    bot,
    mediaLocalRoots,
    replyToMode,
    textLimit,
    thread: threadSpec,
    tableMode,
    chunkMode,
    linkPreview: telegramCfg.linkPreview,
    replyQuoteText
  };
  const applyTextToPayload = (payload, text) => {
    if (payload.text === text) {
      return payload;
    }
    return { ...payload, text };
  };
  const sendPayload = async (payload) => {
    const result = await deliverReplies({
      ...deliveryBaseOptions,
      replies: [payload],
      onVoiceRecording: sendRecordVoice
    });
    if (result.delivered) {
      deliveryState.markDelivered();
    }
    return result.delivered;
  };
  const deliverLaneText = createLaneTextDeliverer({
    lanes,
    archivedAnswerPreviews,
    activePreviewLifecycleByLane,
    retainPreviewOnCleanupByLane,
    draftMaxChars,
    applyTextToPayload,
    sendPayload,
    flushDraftLane,
    stopDraftLane: async (lane) => {
      await lane.stream?.stop();
    },
    editPreview: async ({ messageId, text, previewButtons }) => {
      await editMessageTelegram(chatId, messageId, text, {
        api: bot.api,
        cfg,
        accountId: route.accountId,
        linkPreview: telegramCfg.linkPreview,
        buttons: previewButtons
      });
    },
    deletePreviewMessage: async (messageId) => {
      await bot.api.deleteMessage(chatId, messageId);
    },
    log: logVerbose,
    markDelivered: () => {
      deliveryState.markDelivered();
    }
  });
  let queuedFinal = false;
  if (statusReactionController) {
    void statusReactionController.setThinking();
  }
  const typingCallbacks = createTypingCallbacks({
    start: sendTyping,
    onStartError: (err) => {
      logTypingFailure({
        log: logVerbose,
        channel: "telegram",
        target: String(chatId),
        error: err
      });
    }
  });
  let dispatchError;
  try {
    ({ queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        ...prefixOptions,
        typingCallbacks,
        deliver: async (payload, info) => {
          if (info.kind === "final") {
            await enqueueDraftLaneEvent(async () => {
            });
          }
          if (shouldSuppressLocalTelegramExecApprovalPrompt({
            cfg,
            accountId: route.accountId,
            payload
          })) {
            queuedFinal = true;
            return;
          }
          const previewButtons = payload.channelData?.telegram?.buttons;
          const split = splitTextIntoLaneSegments(payload.text);
          const segments = split.segments;
          const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
          const flushBufferedFinalAnswer = async () => {
            const buffered = reasoningStepState.takeBufferedFinalAnswer();
            if (!buffered) {
              return;
            }
            const bufferedButtons = buffered.payload.channelData?.telegram?.buttons;
            await deliverLaneText({
              laneName: "answer",
              text: buffered.text,
              payload: buffered.payload,
              infoKind: "final",
              previewButtons: bufferedButtons
            });
            reasoningStepState.resetForNextStep();
          };
          for (const segment of segments) {
            if (segment.lane === "answer" && info.kind === "final" && reasoningStepState.shouldBufferFinalAnswer()) {
              reasoningStepState.bufferFinalAnswer({
                payload,
                text: segment.text
              });
              continue;
            }
            if (segment.lane === "reasoning") {
              reasoningStepState.noteReasoningHint();
            }
            const result = await deliverLaneText({
              laneName: segment.lane,
              text: segment.text,
              payload,
              infoKind: info.kind,
              previewButtons,
              allowPreviewUpdateForNonFinal: segment.lane === "reasoning"
            });
            if (segment.lane === "reasoning") {
              if (result !== "skipped") {
                reasoningStepState.noteReasoningDelivered();
                await flushBufferedFinalAnswer();
              }
              continue;
            }
            if (info.kind === "final") {
              if (reasoningLane.hasStreamedMessage) {
                activePreviewLifecycleByLane.reasoning = "complete";
                retainPreviewOnCleanupByLane.reasoning = true;
              }
              reasoningStepState.resetForNextStep();
            }
          }
          if (segments.length > 0) {
            return;
          }
          if (split.suppressedReasoningOnly) {
            if (hasMedia) {
              const payloadWithoutSuppressedReasoning = typeof payload.text === "string" ? { ...payload, text: "" } : payload;
              await sendPayload(payloadWithoutSuppressedReasoning);
            }
            if (info.kind === "final") {
              await flushBufferedFinalAnswer();
            }
            return;
          }
          if (info.kind === "final") {
            await answerLane.stream?.stop();
            await reasoningLane.stream?.stop();
            reasoningStepState.resetForNextStep();
          }
          const canSendAsIs = hasMedia || typeof payload.text === "string" && payload.text.length > 0;
          if (!canSendAsIs) {
            if (info.kind === "final") {
              await flushBufferedFinalAnswer();
            }
            return;
          }
          await sendPayload(payload);
          if (info.kind === "final") {
            await flushBufferedFinalAnswer();
          }
        },
        onSkip: (_payload, info) => {
          if (info.reason !== "silent") {
            deliveryState.markNonSilentSkip();
          }
        },
        onError: (err, info) => {
          deliveryState.markNonSilentFailure();
          runtime.error?.(danger(`telegram ${info.kind} reply failed: ${String(err)}`));
        }
      },
      replyOptions: {
        skillFilter,
        disableBlockStreaming,
        onPartialReply: answerLane.stream || reasoningLane.stream ? (payload) => enqueueDraftLaneEvent(async () => {
          await ingestDraftLaneSegments(payload.text);
        }) : void 0,
        onReasoningStream: reasoningLane.stream ? (payload) => enqueueDraftLaneEvent(async () => {
          if (splitReasoningOnNextStream) {
            reasoningLane.stream?.forceNewMessage();
            resetDraftLaneState(reasoningLane);
            splitReasoningOnNextStream = false;
          }
          await ingestDraftLaneSegments(payload.text);
        }) : void 0,
        onAssistantMessageStart: answerLane.stream ? () => enqueueDraftLaneEvent(async () => {
          reasoningStepState.resetForNextStep();
          if (skipNextAnswerMessageStartRotation) {
            skipNextAnswerMessageStartRotation = false;
            activePreviewLifecycleByLane.answer = "transient";
            retainPreviewOnCleanupByLane.answer = false;
            return;
          }
          await rotateAnswerLaneForNewAssistantMessage();
          activePreviewLifecycleByLane.answer = "transient";
          retainPreviewOnCleanupByLane.answer = false;
        }) : void 0,
        onReasoningEnd: reasoningLane.stream ? () => enqueueDraftLaneEvent(async () => {
          splitReasoningOnNextStream = reasoningLane.hasStreamedMessage;
        }) : void 0,
        onToolStart: statusReactionController ? async (payload) => {
          await statusReactionController.setTool(payload.name);
        } : void 0,
        onCompactionStart: statusReactionController ? () => statusReactionController.setCompacting() : void 0,
        onCompactionEnd: statusReactionController ? async () => {
          statusReactionController.cancelPending();
          await statusReactionController.setThinking();
        } : void 0,
        onModelSelected
      }
    }));
  } catch (err) {
    dispatchError = err;
    runtime.error?.(danger(`telegram dispatch failed: ${String(err)}`));
  } finally {
    await draftLaneEventQueue;
    const streamCleanupStates = /* @__PURE__ */ new Map();
    const lanesToCleanup = [
      { laneName: "answer", lane: answerLane },
      { laneName: "reasoning", lane: reasoningLane }
    ];
    for (const laneState of lanesToCleanup) {
      const stream = laneState.lane.stream;
      if (!stream) {
        continue;
      }
      const activePreviewMessageId = stream.messageId();
      const hasBoundaryFinalizedActivePreview = laneState.laneName === "answer" && typeof activePreviewMessageId === "number" && archivedAnswerPreviews.some(
        (p) => p.deleteIfUnused === false && p.messageId === activePreviewMessageId
      );
      const shouldClear = !retainPreviewOnCleanupByLane[laneState.laneName] && !hasBoundaryFinalizedActivePreview;
      const existing = streamCleanupStates.get(stream);
      if (!existing) {
        streamCleanupStates.set(stream, { shouldClear });
        continue;
      }
      existing.shouldClear = existing.shouldClear && shouldClear;
    }
    for (const [stream, cleanupState] of streamCleanupStates) {
      await stream.stop();
      if (cleanupState.shouldClear) {
        await stream.clear();
      }
    }
    for (const archivedPreview of archivedAnswerPreviews) {
      if (archivedPreview.deleteIfUnused === false) {
        continue;
      }
      try {
        await bot.api.deleteMessage(chatId, archivedPreview.messageId);
      } catch (err) {
        logVerbose(
          `telegram: archived answer preview cleanup failed (${archivedPreview.messageId}): ${String(err)}`
        );
      }
    }
    for (const messageId of archivedReasoningPreviewIds) {
      try {
        await bot.api.deleteMessage(chatId, messageId);
      } catch (err) {
        logVerbose(
          `telegram: archived reasoning preview cleanup failed (${messageId}): ${String(err)}`
        );
      }
    }
  }
  let sentFallback = false;
  const deliverySummary = deliveryState.snapshot();
  if (dispatchError || !deliverySummary.delivered && (deliverySummary.skippedNonSilent > 0 || deliverySummary.failedNonSilent > 0)) {
    const fallbackText = dispatchError ? "Something went wrong while processing your request. Please try again." : EMPTY_RESPONSE_FALLBACK;
    const result = await deliverReplies({
      replies: [{ text: fallbackText }],
      ...deliveryBaseOptions
    });
    sentFallback = result.delivered;
  }
  const hasFinalResponse = queuedFinal || sentFallback;
  if (statusReactionController && !hasFinalResponse) {
    void statusReactionController.setError().catch((err) => {
      logVerbose(`telegram: status reaction error finalize failed: ${String(err)}`);
    });
  }
  if (!hasFinalResponse) {
    clearGroupHistory();
    return;
  }
  if (statusReactionController) {
    void statusReactionController.setDone().catch((err) => {
      logVerbose(`telegram: status reaction finalize failed: ${String(err)}`);
    });
  } else {
    removeAckReactionAfterReply({
      removeAfterReply: removeAckAfterReply,
      ackReactionPromise,
      ackReactionValue: ackReactionPromise ? "ack" : null,
      remove: () => reactionApi?.(chatId, msg.message_id ?? 0, []) ?? Promise.resolve(),
      onError: (err) => {
        if (!msg.message_id) {
          return;
        }
        logAckFailure({
          log: logVerbose,
          channel: "telegram",
          target: `${chatId}/${msg.message_id}`,
          error: err
        });
      }
    });
  }
  clearGroupHistory();
};
export {
  dispatchTelegramMessage,
  pruneStickerMediaFromContext
};
