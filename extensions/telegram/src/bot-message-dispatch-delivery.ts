import type { Message } from "grammy/types";
import {
  getGroupThreadDeliverySession,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createStructuredOutboundPayloadPlan,
  deriveDurableFinalDeliveryRequirements,
  preserveReplyPayloadMediaSelection,
  resolveTranscriptBackedChannelFinalText,
  selectLongerFinalText,
  type LivePreviewDeliveryResult,
} from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import { copyReplyPayloadMetadata, type ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  resetLaneState,
  rotateAnswerLaneAfterQueuedBlocksSettle,
} from "./bot-message-dispatch-draft.js";
import {
  applyQuoteReplyTarget,
  applyTextToPayload,
  projectPayloadForDelivery,
  usesNativeTelegramQuote,
} from "./bot-message-dispatch-payload.js";
import {
  createCurrentTurnTranscriptFinalResolver,
  createTelegramTranscriptMirror,
} from "./bot-message-dispatch-session.js";
import { deduplicateBlockSentMedia } from "./bot-message-dispatch.media-dedup.js";
import type {
  TelegramDispatchTurn as Turn,
  TelegramDispatchTurnConfig as TurnConfig,
  CurrentTurnTranscriptFinal,
  TelegramDeliveryStateSlice,
} from "./bot-message-dispatch.types.js";
import {
  deliverReplies,
  deliverStructuredReplies,
  emitTelegramMessageSentHooks,
} from "./bot/delivery.js";
import { resolveTelegramReplyId } from "./bot/helpers.js";
import type { TelegramInlineButtons } from "./button-types.js";
import { failPromptContextSequence, mergeTelegramPartialDeliveryError } from "./chunk-delivery.js";
import {
  copyTelegramDroppedControlFallback,
  resolveFinalTelegramPresentationText,
} from "./interactive-fallback.js";
import { createLaneDeliveryStateTracker } from "./lane-delivery-state.js";
import {
  createLaneTextDeliverer,
  type DraftLaneState,
  type LaneDeliveryResult,
  type LaneName,
} from "./lane-delivery-text-deliverer.js";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import {
  createTelegramPromptContextProjectionSequence,
  resolveTelegramPromptContextDeliverySignature,
  withTelegramPromptContextSource,
  type TelegramPromptContextProjection,
  type TelegramPromptContextProjectionSequence,
  type TelegramPromptContextSource,
} from "./prompt-context-projection.js";
import { registerTelegramQuestionDelivery } from "./question-finalization.js";
import { editMessageReplyMarkupTelegram, editMessageTelegram } from "./send.js";
import { resolveTelegramTargetChatType } from "./targets.js";

type TelegramDeliveryConfig = TurnConfig & {
  lanes: Record<LaneName, DraftLaneState>;
};

type TelegramSendPayloadOptions = {
  afterAcceptedDraft?: boolean;
  durable?: boolean;
  silent?: boolean;
  mirrorTranscript?: boolean;
  promptContextSequence?: TelegramPromptContextProjectionSequence;
  textMode?: "html";
  onPlatformSendDispatch?: () => Promise<void>;
  assertPlatformSendAuthorized?: () => void;
  bindPendingFinalDelivery?: <T extends ReplyPayload>(payload: T) => T;
  onMediaAccepted?: (mediaUrls: readonly string[]) => void;
};

const promptContextDeliverySignature = (payload: ReplyPayload): string | undefined => {
  const projected = createStructuredOutboundPayloadPlan([payload])[0]?.payload;
  return projected ? resolveTelegramPromptContextDeliverySignature(projected) : undefined;
};

function resolvePromptContextSource(
  turn: Turn,
  final: CurrentTurnTranscriptFinal | undefined,
  ...payloads: ReplyPayload[]
): TelegramPromptContextSource | undefined {
  const finalPayload = final
    ? projectPayloadForDelivery(turn, { text: final.text }, final.openclawDelivery)
    : undefined;
  const finalSignature = finalPayload ? promptContextDeliverySignature(finalPayload) : undefined;
  if (!final?.messageId || !finalSignature) {
    return undefined;
  }
  return payloads.some((payload) => promptContextDeliverySignature(payload) === finalSignature)
    ? { transcriptMessageId: final.messageId }
    : undefined;
}

async function recordPromptContextMessage(
  turn: Turn,
  record: {
    messageId: number;
    message?: Message;
    text?: string;
    projection?: TelegramPromptContextProjection;
  },
): Promise<boolean> {
  const { context } = turn;
  return await (
    turn.telegramDeps.recordOutboundMessageForPromptContext ?? recordOutboundMessageForPromptContext
  )({
    cfg: turn.cfg,
    ownerAgentId: turn.opts.ownerAgentId,
    account: {
      accountId: context.route.accountId,
      ...(turn.telegramCfg.name !== undefined ? { name: turn.telegramCfg.name } : {}),
      ...(context.primaryCtx.me ? { bot: context.primaryCtx.me } : {}),
    },
    ...(context.primaryCtx.me?.id !== undefined ? { botUserId: context.primaryCtx.me.id } : {}),
    chatId: String(context.chatId),
    message: record.message ?? { message_id: record.messageId },
    messageId: record.messageId,
    ...(record.text ? { text: record.text } : {}),
    ...(record.projection ? { promptContextProjection: record.projection } : {}),
    ...(turn.context.threadSpec.id !== undefined
      ? { messageThreadId: turn.context.threadSpec.id }
      : {}),
    successfulSendThread: turn.context.threadSpec,
  });
}

const createPromptContextSequence = (
  turn: Turn,
  source?: TelegramPromptContextSource,
): TelegramPromptContextProjectionSequence =>
  createTelegramPromptContextProjectionSequence({
    ...(source ? { source } : {}),
    record: async (record) => await recordPromptContextMessage(turn, record),
  });

function createDeliveryBaseOptions(turn: Turn) {
  const { context } = turn;
  return {
    cfg: turn.cfg,
    ownerAgentId: turn.opts.ownerAgentId,
    chatId: String(context.chatId),
    accountId: context.route.accountId,
    sessionKeyForInternalHooks: context.ctxPayload.SessionKey,
    mirrorIsGroup: context.isGroup,
    mirrorGroupId: context.isGroup ? String(context.chatId) : undefined,
    token: turn.opts.token,
    runtime: turn.runtime,
    bot: turn.bot,
    mediaLocalRoots: turn.mediaLocalRoots,
    mediaMaxBytes: (turn.opts.mediaMaxMb ?? turn.telegramCfg.mediaMaxMb ?? 100) * 1024 * 1024,
    replyToMode: turn.replyToMode,
    textLimit: turn.textLimit,
    thread: turn.context.threadSpec,
    tableMode: turn.tableMode,
    chunkMode: turn.chunkMode,
    richMessages: turn.telegramCfg.richMessages,
    linkPreview: turn.telegramCfg.linkPreview,
    replyQuoteMessageId: turn.replyQuoteMessageId,
    replyQuoteText: turn.replyQuoteText,
    replyQuotePosition: turn.replyQuotePosition,
    replyQuoteEntities: turn.replyQuoteEntities,
    replyQuoteByMessageId: turn.replyQuoteByMessageId,
    transcriptMirror: createTelegramTranscriptMirror(turn),
  };
}

export async function sendPayload(
  sourceTurn: Turn,
  payload: ReplyPayload,
  options?: TelegramSendPayloadOptions,
): Promise<LivePreviewDeliveryResult> {
  if (sourceTurn.isSuperseded()) {
    await options?.promptContextSequence?.fail();
    return { visibleReplySent: false, suppression: { reason: "channel_transform" } };
  }
  const deliverySession = getGroupThreadDeliverySession();
  // Keep parallel participants' media policy and transcript identity off the shared turn.
  const turn = deliverySession
    ? {
        ...sourceTurn,
        context: {
          ...sourceTurn.context,
          route: { ...sourceTurn.context.route, ...deliverySession },
          ctxPayload: {
            ...sourceTurn.context.ctxPayload,
            AgentId: deliverySession.agentId,
            SessionKey: deliverySession.sessionKey,
            RuntimePolicySessionKey: deliverySession.sessionKey,
          },
        },
        mediaLocalRoots: getAgentScopedMediaLocalRoots(sourceTurn.cfg, deliverySession.agentId),
      }
    : sourceTurn;
  const targetedPayload = applyQuoteReplyTarget(turn, payload);
  const finalReplyTargetId = resolveTelegramReplyId(targetedPayload.replyToId);
  const targetsDifferentMessage =
    finalReplyTargetId != null && finalReplyTargetId !== turn.draftReplyToMessageId;
  const consumedSingleUseReply =
    options?.afterAcceptedDraft === true &&
    isSingleUseReplyToMode(turn.replyToMode) &&
    !targetsDifferentMessage;
  const deliverablePayload = consumedSingleUseReply
    ? copyReplyPayloadMetadata(
        targetedPayload,
        (({ replyToId: _replyToId, replyToTag: _tag, replyToCurrent: _current, ...rest }) => rest)(
          targetedPayload,
        ),
      )
    : targetedPayload;
  const effectiveReplyToMode = consumedSingleUseReply ? "off" : turn.replyToMode;
  const projectionSequence =
    options?.promptContextSequence ??
    createPromptContextSequence(
      turn,
      options?.durable
        ? resolvePromptContextSource(
            turn,
            await turn.resolveCurrentTurnTranscriptFinal(),
            deliverablePayload,
          )
        : undefined,
    );
  const projectedPayload = withTelegramPromptContextSource(
    deliverablePayload,
    projectionSequence.source,
  );
  const effectivePayload = options?.bindPendingFinalDelivery
    ? options.bindPendingFinalDelivery(projectedPayload)
    : projectedPayload;
  const silent =
    options?.silent ?? (turn.telegramCfg.silentErrorReplies === true && payload.isError === true);
  const durableDelivery = turn.telegramDeps.deliverStructuredInboundReplyWithMessageSendContext;
  if (options?.durable && durableDelivery && projectionSequence.isFresh()) {
    const plan = createStructuredOutboundPayloadPlan([effectivePayload])[0];
    if (!plan) {
      await projectionSequence.fail();
      return { visibleReplySent: false, suppression: { reason: "no_visible_payload" } };
    }
    const durable = await durableDelivery({
      cfg: turn.cfg,
      channel: "telegram",
      to:
        turn.context.ctxPayload.OriginatingTo ??
        turn.context.ctxPayload.To ??
        `telegram:${turn.context.chatId}`,
      accountId: turn.context.route.accountId,
      agentId: turn.context.route.agentId,
      ctxPayload: turn.context.ctxPayload,
      plan,
      info: { kind: "final" },
      replyToMode: effectiveReplyToMode,
      threadId: turn.context.threadSpec.id,
      formatting: {
        textLimit: turn.textLimit,
        tableMode: turn.tableMode,
        chunkMode: turn.chunkMode,
        ...(options?.textMode === "html" ? { parseMode: "HTML" as const } : {}),
      },
      silent,
      requiredCapabilities: deriveDurableFinalDeliveryRequirements({
        payload: effectivePayload,
        replyToId: effectivePayload.replyToId,
        threadId: turn.context.threadSpec.id,
        silent,
        payloadTransport: true,
        extraCapabilities: {
          nativeQuote: !consumedSingleUseReply && usesNativeTelegramQuote(turn, effectivePayload),
        },
      }),
    });
    if (durable.status === "failed") {
      return await failPromptContextSequence(projectionSequence, durable.error);
    }
    if (durable.status === "handled_visible") {
      turn.deliveryState.markDelivered();
      return { ...durable.delivery, visibleReplySent: true };
    }
    if (durable.status === "handled_no_send") {
      await projectionSequence.fail();
      return { ...durable.delivery, visibleReplySent: false };
    }
  }
  try {
    const transcriptMirror = createTelegramTranscriptMirror(turn, sourceTurn);
    const result = await (turn.telegramDeps.deliverStructuredReplies ?? deliverStructuredReplies)({
      ...createDeliveryBaseOptions(turn),
      replyToMode: effectiveReplyToMode,
      transcriptMirror:
        options?.durable && options?.mirrorTranscript !== false ? transcriptMirror : undefined,
      replies: [effectivePayload],
      onMediaAccepted: options?.onMediaAccepted,
      onVoiceRecording: turn.context.sendRecordVoice,
      silent,
      mediaLoader: turn.telegramDeps.loadWebMedia,
      promptContextSequence: projectionSequence,
      onPlatformSendDispatch: options?.onPlatformSendDispatch,
      assertPlatformSendAuthorized: options?.assertPlatformSendAuthorized,
      ...(options?.textMode ? { textMode: options.textMode } : {}),
    });
    if (!result.delivered) {
      await projectionSequence.fail();
      return { visibleReplySent: false, suppression: { reason: "no_visible_result" } };
    }
    try {
      await projectionSequence.finish();
    } catch (error) {
      if (!result.receipt?.platformMessageIds.length) {
        throw error;
      }
      // Telegram accepted every part; a later prompt-context write failure cannot
      // turn that receipt into an uncertain send or authorize a delivery warning.
      if (options?.durable) {
        await observeFinalDelivery(turn, { visibleReplySent: true, receipt: result.receipt });
      }
      throw mergeTelegramPartialDeliveryError(error, {
        receipt: result.receipt,
        messageIds: result.receipt.platformMessageIds,
        visibleReplySent: true,
      });
    }
    turn.deliveryState.markDelivered();
    return { visibleReplySent: true, receipt: result.receipt };
  } catch (error) {
    return await failPromptContextSequence(projectionSequence, error);
  }
}

async function emitPreviewFinalizedHook(turn: Turn, result: LaneDeliveryResult): Promise<void> {
  if (
    turn.isSuperseded() ||
    (result.kind !== "preview-finalized" && result.kind !== "preview-finalized-partial")
  ) {
    return;
  }
  // A finalized preview is the durable Telegram message. Emit the composite
  // terminal here so plugin and internal observers see that one provider result.
  (turn.telegramDeps.emitTelegramMessageSentHooks ?? emitTelegramMessageSentHooks)({
    sessionKeyForInternalHooks: turn.context.ctxPayload.SessionKey,
    chatId: String(turn.context.chatId),
    accountId: turn.context.route.accountId,
    content: result.delivery.content,
    success: result.kind === "preview-finalized",
    messageId: result.delivery.messageId,
    isGroup: turn.context.isGroup,
    groupId: turn.context.isGroup ? String(turn.context.chatId) : undefined,
  });
  const transcriptMirror = createTelegramTranscriptMirror(turn);
  if (transcriptMirror && result.delivery.content) {
    void transcriptMirror({ text: result.delivery.content }).catch((err: unknown) => {
      logVerbose(`telegram preview-finalized transcriptMirror failed: ${formatErrorMessage(err)}`);
    });
  }
}

export async function handlePreviewFinalizedResult(
  turn: Turn,
  result: LaneDeliveryResult,
): Promise<void> {
  if (result.kind !== "preview-finalized" && result.kind !== "preview-finalized-partial") {
    return;
  }
  await emitPreviewFinalizedHook(turn, result);
  if (result.kind === "preview-finalized-partial") {
    // The preview is already visible, so this failure is terminal: preserve its
    // receipt and prevent outer fallback delivery from duplicating the message.
    throw mergeTelegramPartialDeliveryError(result.error, {
      ...result.deliveryResult,
      visibleReplySent: true,
    });
  }
}

export function registerTelegramQuestionDeliveryForMessage(
  turn: Turn,
  payload: ReplyPayload,
  delivery: { messageId: number; text: string },
): void {
  const { chatId } = turn.context;
  const accountId = turn.context.route.accountId;
  const api = turn.bot.api;
  const cfg = turn.cfg;
  const linkPreview = turn.telegramCfg.linkPreview;
  const editText = turn.telegramDeps.editMessageTelegram ?? editMessageTelegram;
  const { messageId, text } = delivery;
  registerTelegramQuestionDelivery({
    accountId,
    chatId: String(chatId),
    messageId,
    payload,
    text,
    textLimit: turn.textLimit,
    clearButtons: async () => {
      await editMessageReplyMarkupTelegram(chatId, messageId, [], { api, cfg, accountId });
    },
    annotate: async (finalText) => {
      await editText(chatId, messageId, finalText, { api, cfg, accountId, linkPreview });
    },
  });
}

async function materializeAnswerLaneBeforeRotation(turn: Turn): Promise<void> {
  const block = turn.activeAnswerBlockDelivery;
  const lane = turn.answerLane;
  if (
    !block ||
    !lane.stream ||
    !lane.hasStreamedMessage ||
    lane.finalized ||
    turn.activeAnswerDraftIsToolProgressOnly
  ) {
    return;
  }
  const text = lane.lastPartialText || turn.lastAnswerPartialText || block.text;
  if (!text?.trim()) {
    return;
  }
  const result = await turn.deliverLaneText({
    laneName: "answer",
    text,
    payload: block.payload,
    infoKind: "block",
    buttons: block.buttons,
    finalizePreview: true,
    durable: false,
  });
  turn.activeAnswerBlockDelivery = undefined;
  await handlePreviewFinalizedResult(turn, result);
}

function recoverFinalPayload(
  turn: Turn,
  payload: ReplyPayload,
  text: string,
  final: CurrentTurnTranscriptFinal | undefined,
): ReplyPayload | undefined {
  const projected = projectPayloadForDelivery(
    turn,
    applyTextToPayload(payload, text),
    final?.openclawDelivery,
  );
  return projected
    ? copyTelegramDroppedControlFallback(
        payload,
        deduplicateBlockSentMedia(
          preserveReplyPayloadMediaSelection(payload, projected),
          turn.sentBlockMediaUrls,
        ),
      )
    : undefined;
}

export async function observeFinalDelivery(
  turn: Turn,
  result: LivePreviewDeliveryResult,
  isError = false,
): Promise<void> {
  if (result.visibleReplySent) {
    turn.deliveryState.markDelivered();
  }
  const reason = result.suppression?.reason;
  if (result.deliveryIntent || reason === "adapter_returned_no_identity") {
    turn.finalDispatchClaimed = true;
  }
  if (reason === "adapter_returned_no_identity" || reason === "no_visible_result") {
    turn.previewLifecycle.observeFailure(result);
  } else if (result.visibleReplySent) {
    await turn.previewLifecycle.observeDelivery(result, { isError });
  } else if (result.suppression) {
    turn.previewLifecycle.observeSuppression();
  } else {
    turn.previewLifecycle.observeFailure(result);
  }
}

export async function deliverFinalAnswerText(
  turn: Turn,
  answerPayload: ReplyPayload,
  text: string,
  buttons?: TelegramInlineButtons,
  onPlatformSendDispatch?: () => Promise<void>,
  assertPlatformSendAuthorized?: () => void,
  bindPendingFinalDelivery?: <T extends ReplyPayload>(payload: T) => T,
): Promise<LaneDeliveryResult> {
  turn.previewLifecycle.beginFinalDelivery();
  const transcriptFinal = await turn.resolveCurrentTurnTranscriptFinal();
  const selectedText = await resolveTranscriptBackedChannelFinalText({
    payload: answerPayload,
    finalText: text,
    resolveCandidateText: async () => transcriptFinal?.text,
  });
  const finalPayload =
    selectedText === text
      ? answerPayload
      : recoverFinalPayload(turn, answerPayload, selectedText, transcriptFinal);
  if (!finalPayload) {
    const deliveryResult: LivePreviewDeliveryResult = {
      visibleReplySent: false,
      suppression: { reason: "channel_transform" },
    };
    await observeFinalDelivery(turn, deliveryResult);
    return { kind: "skipped", deliveryResult };
  }
  const finalText = selectedText === text ? text : (finalPayload.text ?? "");
  const source = resolvePromptContextSource(
    turn,
    transcriptFinal,
    answerPayload,
    applyTextToPayload(finalPayload, finalText),
  );
  const promptContextSequence = createPromptContextSequence(turn, source);
  const isFollowUp = turn.previewLifecycle.finalDelivered;
  let result: LaneDeliveryResult;
  if (!isFollowUp && turn.streamMode === "progress") {
    const afterAcceptedDraft = turn.answerLane.stream?.hasConsumedReplyTarget() === true;
    // Freeze writes, but keep the only visible progress until replacement is accepted.
    await turn.answerLane.stream?.discard().catch((error: unknown) => {
      logVerbose(`telegram progress discard failed: ${formatErrorMessage(error)}`);
    });
    const deliveryResult = await sendPayload(turn, applyTextToPayload(finalPayload, finalText), {
      afterAcceptedDraft,
      durable: true,
      promptContextSequence,
      onPlatformSendDispatch,
      assertPlatformSendAuthorized,
      bindPendingFinalDelivery,
    });
    result = { kind: deliveryResult.visibleReplySent ? "sent" : "skipped", deliveryResult };
  } else {
    if (isFollowUp) {
      turn.answerLane.stream?.forceNewMessage();
      resetLaneState(turn, turn.answerLane);
    } else if (!turn.activeAnswerDraftIsToolProgressOnly) {
      await rotateAnswerLaneAfterQueuedBlocksSettle(turn);
    }
    result = await turn.deliverLaneText({
      laneName: "answer",
      text: finalText,
      payload: finalPayload,
      replyTargetBeforeRecovery: answerPayload,
      infoKind: "final",
      buttons,
      allowStream:
        !turn.activeAnswerDraftIsToolProgressOnly &&
        (!usesNativeTelegramQuote(turn, finalPayload) ||
          (turn.replyQuoteText == null &&
            resolveTelegramReplyId(finalPayload.replyToId) ===
              turn.answerLane.stream?.currentMessageSnapshot()?.replyToMessageId)),
      promptContextSequence,
      onPlatformSendDispatch,
      assertPlatformSendAuthorized,
      bindPendingFinalDelivery,
    });
  }
  if (result.kind === "preview-finalized-partial" && !result.confirmedFinalContent) {
    turn.previewLifecycle.observeFailure(result.deliveryResult);
  } else {
    await observeFinalDelivery(turn, result.deliveryResult, finalPayload.isError === true);
  }
  await handlePreviewFinalizedResult(turn, result);
  if (result.kind === "preview-finalized") {
    registerTelegramQuestionDeliveryForMessage(turn, finalPayload, {
      messageId: result.delivery.messageId,
      text: result.delivery.content,
    });
  }
  return result;
}
export async function finalizePendingAnswerBlockDraft(turn: Turn): Promise<void> {
  const block = turn.activeAnswerBlockDelivery;
  if (
    !block ||
    turn.finalDispatchClaimed ||
    turn.dispatchError ||
    turn.previewLifecycle.finalStarted ||
    turn.isSuperseded() ||
    turn.answerLane.finalized
  ) {
    return;
  }
  const content = block.text.trimEnd();
  if (!content) {
    return;
  }
  await deliverFinalAnswerText(turn, block.payload, content, block.buttons);
  turn.activeAnswerBlockDelivery = undefined;
}

export async function deliverFallback(turn: Turn, replies: ReplyPayload[], silent: boolean) {
  try {
    const result = await (turn.telegramDeps.deliverReplies ?? deliverReplies)({
      replies,
      ...createDeliveryBaseOptions(turn),
      silent,
      mediaLoader: turn.telegramDeps.loadWebMedia,
    });
    if (result.delivered && !turn.previewLifecycle.finalDelivered) {
      await observeFinalDelivery(turn, { visibleReplySent: true, receipt: result.receipt }, true);
    } else if (result.delivered) {
      // A diagnostic does not complete a partially delivered answer.
      turn.deliveryState.markDelivered();
    }
    return result;
  } catch (error) {
    const accepted = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
    turn.previewLifecycle.observeFailure(accepted);
    if (accepted) {
      turn.deliveryState.markDelivered();
    }
    turn.runtime.error?.(`telegram fallback delivery failed: ${formatErrorMessage(error)}`);
    return { delivered: accepted !== undefined };
  }
}

export function createDeliveryState(
  config: TelegramDeliveryConfig,
  getTurn: () => Turn,
): TelegramDeliveryStateSlice {
  const { context } = config;
  const sessionKey = context.ctxPayload.SessionKey;
  const implicitQuoteReplyTargetId =
    context.ctxPayload.ReplyToIsQuote &&
    !context.msg.reply_to_message?.from?.is_bot &&
    config.replyQuoteMessageId != null
      ? String(config.replyQuoteMessageId)
      : undefined;
  const currentMessageIdForQuoteReply =
    implicitQuoteReplyTargetId && context.ctxPayload.MessageSid
      ? context.ctxPayload.MessageSid
      : undefined;
  const deliveryState = createLaneDeliveryStateTracker();
  const deliverLaneText = createLaneTextDeliverer({
    lanes: config.lanes,
    applyTextToPayload,
    sendPayload: async (payload, options) => await sendPayload(getTurn(), payload, options),
    flushDraftLane: async (lane) => await lane.stream?.flush(),
    stopDraftLane: async (lane) => await lane.stream?.stop(),
    clearDraftLane: async (lane) => await lane.stream?.clear(),
    editStreamMessage: async ({ messageId, text, textMode, buttons }) => {
      const turn = getTurn();
      if (!turn.isSuperseded()) {
        await (turn.telegramDeps.editMessageTelegram ?? editMessageTelegram)(
          turn.context.chatId,
          messageId,
          text,
          {
            api: turn.bot.api,
            cfg: turn.cfg,
            accountId: turn.context.route.accountId,
            linkPreview: turn.telegramCfg.linkPreview,
            textMode,
            buttons,
          },
        );
      }
    },
    createPromptContextSequence: () => createPromptContextSequence(getTurn()),
    resolveFinalPresentationText: ({ payload, text }) =>
      resolveFinalTelegramPresentationText({
        payload,
        text,
        richMessages: getTurn().telegramCfg.richMessages === true,
        allowWebAppButtons:
          resolveTelegramTargetChatType(String(getTurn().context.chatId)) === "direct",
      }),
    resolveFinalPayloadCandidate: async ({ finalText, payload, candidateTexts }) => {
      const turn = getTurn();
      const transcriptFinal = await turn.resolveCurrentTurnTranscriptFinal();
      const previewText = selectLongerFinalText({ finalText, candidateTexts });
      const selectedText = await resolveTranscriptBackedChannelFinalText({
        payload,
        finalText,
        resolveCandidateText: async () => transcriptFinal?.text,
      });
      if (selectedText === finalText) {
        return undefined;
      }
      const recovered = recoverFinalPayload(turn, payload, selectedText, transcriptFinal);
      return recovered &&
        previewText &&
        previewText.length > (recovered.text ?? "").trimEnd().length
        ? applyTextToPayload(recovered, previewText)
        : recovered;
    },
    log: logVerbose,
    markDelivered: deliveryState.markDelivered,
  });

  return {
    deliveryState,
    deliverLaneText,
    // Draft's rotate path calls this through the turn record: a direct import
    // from draft.ts would recreate the draft<->delivery runtime import cycle.
    materializeAnswerLaneBeforeRotation: async () =>
      await materializeAnswerLaneBeforeRotation(getTurn()),
    resolveCurrentTurnTranscriptFinal: context.ctxPayload.GroupThread
      ? async () => undefined
      : createCurrentTurnTranscriptFinalResolver({
          agentId: context.route.agentId,
          dispatchStartedAt: config.dispatchStartedAt,
          loadFreshSessionEntry: config.loadFreshSessionEntry,
          sessionKey,
        }),
    transcriptMirrorSequence: 0,
    transcriptMirrorTurnId: `${context.chatId}:${context.ctxPayload.MessageSid ?? context.msg.message_id ?? config.dispatchStartedAt}`,
    implicitQuoteReplyTargetId,
    currentMessageIdForQuoteReply,
  };
}
