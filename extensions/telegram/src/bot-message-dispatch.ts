import { resolveAgentDir, resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import {
  formatMediaPlaceholderText,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { captureAsyncWorkTracker } from "openclaw/plugin-sdk/concurrency-runtime";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import {
  generateConversationLabel as generateTopicLabel,
  resolveChunkMode,
  resolveSessionTitleSource,
  resetTitlePrompt,
} from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { createSubsystemLogger, danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  getSessionTitleLifecycleAsync,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { prepareSkillCommandsForWorkspace } from "openclaw/plugin-sdk/skill-commands-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";
import {
  normalizeGeneratedTopicLabel,
  resolveAutoTopicLabelConfig,
  resolveAutoTopicLabelRefineConfig,
} from "./auto-topic-label-config.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import { resolveDispatchTelegramContext } from "./bot-message-dispatch-context.js";
import {
  createDeliveryState,
  deliverFallback,
  finalizePendingAnswerBlockDraft,
} from "./bot-message-dispatch-delivery.js";
import { cleanupDrafts, createDraftState } from "./bot-message-dispatch-draft.js";
import { createProgressState, settleFailedFinalDelivery } from "./bot-message-dispatch-progress.js";
import { createReplyState } from "./bot-message-dispatch-reply.js";
import {
  createFreshTelegramSessionEntryLoader,
  resolveTelegramReasoningLevel,
} from "./bot-message-dispatch-session.js";
import { runTelegramDispatchTurn } from "./bot-message-dispatch-turn.js";
import type {
  DispatchTelegramMessageParams,
  TelegramDispatchTurn,
  TelegramDispatchResult,
} from "./bot-message-dispatch.types.js";
import { getTelegramTextParts, resolveTelegramReplyId } from "./bot/helpers.js";
import {
  addTelegramNativeQuoteCandidate,
  buildTelegramNativeQuoteCandidate,
  type TelegramNativeQuoteCandidateByMessageId,
} from "./bot/native-quote.js";
import { resolveTelegramRichMessages, resolveTelegramTableMode } from "./rich-messages-config.js";
import { cacheSticker, describeStickerImage } from "./sticker-cache.js";
import { resolveStickerVisionSupport } from "./sticker-vision.js";
import {
  prepareTopicLabelTurn,
  finishInitialTopicLabel,
  maybeRefineTopicLabel,
} from "./topic-label-refinement.js";
import {
  resolveTelegramDirectTopicNameCacheScope,
  getTopicName,
  isTopicNameImplicit,
  updateTopicName,
} from "./topic-name-cache.js";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";
const silentReplyDispatchLogger = createSubsystemLogger("telegram/silent-reply-dispatch");

function includeStickerDescription(params: {
  body: string | undefined;
  formattedDescription: string;
}): string {
  if (!params.body?.trim()) {
    return params.formattedDescription;
  }
  if (params.body.includes(params.formattedDescription)) {
    return params.body;
  }
  return `${params.formattedDescription}\n${params.body}`;
}

async function prepareTelegramSticker(params: {
  cfg: DispatchTelegramMessageParams["cfg"];
  context: TelegramMessageContext;
}) {
  const { context } = params;
  const sticker = context.ctxPayload.Sticker;
  const stickerFact = context.ctxPayload.media?.find((media) => media.kind === "sticker");
  const stickerPath =
    stickerFact?.path ??
    (!stickerFact && context.ctxPayload.StickerMediaIncluded
      ? context.ctxPayload.media?.[0]?.path
      : undefined);
  if (!sticker?.fileId || !sticker.fileUniqueId || !stickerPath) {
    return;
  }
  const agentDir = resolveAgentDir(params.cfg, context.route.agentId);
  const stickerSupportsVision = await resolveStickerVisionSupport({
    cfg: params.cfg,
    agentId: context.route.agentId,
  });
  const description =
    sticker.cachedDescription ||
    (await describeStickerImage({
      imagePath: stickerPath,
      cfg: params.cfg,
      agentDir,
      agentId: context.route.agentId,
    }));
  if (!description) {
    return;
  }
  const stickerContext = [sticker.emoji, sticker.setName ? `from "${sticker.setName}"` : null]
    .filter(Boolean)
    .join(" ");
  const formattedDescription = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${description}`;
  sticker.cachedDescription = description;
  if (!stickerSupportsVision) {
    context.ctxPayload.Body = includeStickerDescription({
      body: context.ctxPayload.Body,
      formattedDescription,
    });
    // Reply finalization projects BodyForAgent from the canonical agent text.
    context.ctxPayload.agentText = includeStickerDescription({
      body: context.ctxPayload.agentText ?? context.ctxPayload.BodyForAgent,
      formattedDescription,
    });
    context.ctxPayload.BodyForAgent = context.ctxPayload.agentText;
    context.ctxPayload.SkipStickerMediaUnderstanding = true;
  }
  await cacheSticker({
    fileId: sticker.fileId,
    fileUniqueId: sticker.fileUniqueId,
    emoji: sticker.emoji,
    setName: sticker.setName,
    description,
    cachedAt: new Date().toISOString(),
    receivedFrom: context.ctxPayload.From,
  });
  logVerbose(`telegram: cached sticker description for ${sticker.fileUniqueId}`);
}

async function scheduleDmTopicLabel(params: {
  bot: DispatchTelegramMessageParams["bot"];
  cfg: DispatchTelegramMessageParams["cfg"];
  context: TelegramMessageContext;
  telegramCfg: DispatchTelegramMessageParams["telegramCfg"];
  userMessage: string;
  accountAbortSignal?: AbortSignal;
}) {
  const { context } = params;
  const isDmTopic =
    !context.isGroup && context.threadSpec.scope === "dm" && context.threadSpec.id != null;
  if (!isDmTopic) {
    return;
  }
  const directAutoTopicLabel =
    context.groupConfig && "autoTopicLabel" in context.groupConfig
      ? context.groupConfig.autoTopicLabel
      : undefined;
  const topicThreadId = context.threadSpec.id!;
  const assertAccountCurrent = () => {
    if (params.accountAbortSignal?.aborted) {
      throw new Error("telegram account stopped; refinement cancelled");
    }
  };
  const sessionKey = context.ctxPayload.SessionKey;
  if (!sessionKey) {
    return;
  }
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: context.route.agentId });
  const readLifecycle = () =>
    getSessionTitleLifecycleAsync({ storePath, sessionKey, agentId: context.route.agentId });
  const lifecycle = await readLifecycle();
  if (!lifecycle?.lifecycleRevision || lifecycle.explicitLabel?.trim()) {
    return;
  }
  const assertLifecycleCurrent = async () => {
    const current = await readLifecycle();
    if (
      current?.explicitLabel?.trim() ||
      current?.sessionId !== lifecycle.sessionId ||
      current?.lifecycleRevision !== lifecycle.lifecycleRevision
    ) {
      throw new Error("telegram title lifecycle changed");
    }
    assertAccountCurrent();
  };
  const skillCommands = params.userMessage.trim().startsWith("/")
    ? await prepareSkillCommandsForWorkspace(
        {
          cfg: params.cfg,
          agentId: context.route.agentId,
          sessionKey,
          workspaceDir: resolveAgentWorkspaceDir(params.cfg, context.route.agentId),
        },
        assertAccountCurrent,
      )
    : [];
  const userMessage = resolveSessionTitleSource(params.userMessage, skillCommands);
  if (!userMessage) {
    return;
  }
  const autoTopicConfig = resolveAutoTopicLabelConfig(
    directAutoTopicLabel,
    params.telegramCfg.autoTopicLabel,
  );
  if (!autoTopicConfig) {
    return;
  }
  const refineCfg = resolveAutoTopicLabelRefineConfig({
    directConfig: directAutoTopicLabel,
    accountConfig: params.telegramCfg.autoTopicLabel,
  });
  const cacheScope = resolveTelegramDirectTopicNameCacheScope(
    resolveStorePath(params.cfg.session?.store, {
      agentId: resolveTelegramAccountOwnerAgentId({
        cfg: params.cfg,
        accountId: context.route.accountId,
      }),
    }),
    context.route.accountId,
  );
  const previousName = await getTopicName(context.chatId, topicThreadId, cacheScope);
  await assertLifecycleCurrent();
  const decision = await prepareTopicLabelTurn({
    botId: params.bot.botInfo?.id,
    accountId: context.route.accountId,
    chatId: context.chatId,
    threadId: topicThreadId,
    lifecycleRevision: lifecycle.lifecycleRevision,
    currentName: previousName,
    isNameImplicit:
      previousName !== undefined &&
      (await isTopicNameImplicit(context.chatId, topicThreadId, cacheScope)),
  });
  if (decision === "skip") {
    return;
  }
  if (decision === "refine") {
    if (refineCfg.enabled) {
      await maybeRefineTopicLabel({
        botId: params.bot.botInfo?.id,
        accountId: context.route.accountId,
        bot: params.bot,
        assertServiceCurrent: assertAccountCurrent,
        assertLifecycleCurrent,
        lifecycleRevision: lifecycle.lifecycleRevision,
        cfg: params.cfg,
        agentId: context.route.agentId,
        chatId: context.chatId,
        threadId: topicThreadId,
        userMessage,
        afterMessages: refineCfg.afterMessages,
        logVerbose,
      });
    }
    return;
  }
  await (async () => {
    try {
      assertAccountCurrent();
      const label = normalizeGeneratedTopicLabel(
        await generateTopicLabel({
          userMessage,
          prompt: previousName
            ? resetTitlePrompt(lifecycle.resetMode ?? "reset", previousName)
            : autoTopicConfig.prompt,
          maxLength: 128,
          cfg: params.cfg,
          agentId: context.route.agentId,
          agentDir: resolveAgentDir(params.cfg, context.route.agentId),
          assertCurrent: assertAccountCurrent,
        }),
      );
      if (!label) {
        logVerbose("auto-topic-label: LLM returned empty label");
        return;
      }
      logVerbose(`auto-topic-label: generated label (len=${label.length})`);
      const applyInitialLabel = async () => {
        const currentName = await getTopicName(context.chatId, topicThreadId, cacheScope);
        if (currentName !== previousName) {
          throw new Error("telegram title changed during generation");
        }
        await assertLifecycleCurrent();
        assertAccountCurrent();
        if (label !== previousName) {
          await params.bot.api.editForumTopic(context.chatId, topicThreadId, { name: label });
        }
        // Cache the automatic label so the refinement's manual-rename guard can
        // observe later human renames of DM topics (Codex 4302875124).
        await updateTopicName(
          context.chatId,
          topicThreadId,
          { name: label },
          resolveTelegramDirectTopicNameCacheScope(
            resolveStorePath(params.cfg.session?.store, {
              agentId: resolveTelegramAccountOwnerAgentId({
                cfg: params.cfg,
                accountId: context.route.accountId,
              }),
            }),
            context.route.accountId,
          ),
        ).catch(() => {});
        logVerbose(`auto-topic-label: renamed topic ${context.chatId}/${topicThreadId}`);
      };
      await finishInitialTopicLabel({
        botId: params.bot.botInfo?.id,
        accountId: context.route.accountId,
        bot: params.bot,
        assertServiceCurrent: assertAccountCurrent,
        assertLifecycleCurrent,
        lifecycleRevision: lifecycle.lifecycleRevision,
        cfg: params.cfg,
        agentId: context.route.agentId,
        chatId: context.chatId,
        threadId: topicThreadId,
        afterMessages: refineCfg.enabled ? refineCfg.afterMessages : Number.POSITIVE_INFINITY,
        logVerbose,
        label,
        applyInitialLabel,
      });
    } catch (err) {
      logVerbose(`auto-topic-label: failed: ${String(err)}`);
    }
  })();
}

export const dispatchTelegramMessage = async (
  dispatchParams: DispatchTelegramMessageParams,
): Promise<TelegramDispatchResult> => {
  // Retain naming under the existing ingress owner, before the foreground turn
  // enters nested scopes. This captures work ownership, never authorization.
  const trackTopicLabelWork = captureAsyncWorkTracker();
  const {
    context,
    bot,
    cfg,
    runtime,
    replyToMode,
    telegramCfg,
    retryDispatchErrors = false,
    suppressFailureFallback = false,
    turnAdoptionLifecycle,
    opts,
  } = dispatchParams;
  const dispatchStartedAt = Date.now();
  const dispatchContext = await resolveDispatchTelegramContext({ context });
  const loadFreshSessionEntry = createFreshTelegramSessionEntryLoader({ cfg });
  const isRoomEvent = dispatchContext.ctxPayload.InboundEventKind === "room_event";
  const statusReactionController = isRoomEvent ? null : dispatchContext.statusReactionController;
  const finalizeStatus = async (outcome: "done" | "error" | "cancelled") => {
    if (!statusReactionController) {
      return;
    }
    if (outcome === "done") {
      await statusReactionController.setDone();
    } else if (outcome === "error") {
      await statusReactionController.setError();
    }
    await statusReactionController.restoreInitial();
  };
  const finalizeStatusInBackground = (outcome: "done" | "error" | "cancelled", label: string) => {
    void finalizeStatus(outcome).catch((err: unknown) => {
      logVerbose(`telegram: status reaction ${label} failed: ${String(err)}`);
    });
  };
  const richMessagesParams = {
    cfg,
    accountId: dispatchContext.route.accountId,
    accountConfig: telegramCfg,
  };
  const richMessages = resolveTelegramRichMessages(richMessagesParams);
  const tableMode = resolveTelegramTableMode(richMessagesParams);
  const resolvedReasoningLevel = await resolveTelegramReasoningLevel({
    cfg,
    sessionKey: dispatchContext.ctxPayload.SessionKey,
    agentId: dispatchContext.route.agentId,
    loadFreshSessionEntry,
  });
  const rawReplyQuoteText =
    dispatchContext.ctxPayload.ReplyToIsQuote &&
    typeof dispatchContext.ctxPayload.ReplyToQuoteText === "string"
      ? dispatchContext.ctxPayload.ReplyToQuoteText
      : undefined;
  const replyQuoteText = dispatchContext.ctxPayload.ReplyToIsQuote
    ? rawReplyQuoteText?.trim()
      ? rawReplyQuoteText
      : dispatchContext.ctxPayload.ReplyToBody?.trim() || undefined
    : undefined;
  const replyQuoteMessageId =
    replyQuoteText && !dispatchContext.ctxPayload.ReplyToIsExternal
      ? resolveTelegramReplyId(dispatchContext.ctxPayload.ReplyToId)
      : undefined;
  const replyQuotePosition =
    typeof dispatchContext.ctxPayload.ReplyToQuotePosition === "number"
      ? dispatchContext.ctxPayload.ReplyToQuotePosition
      : undefined;
  const replyQuoteEntities = Array.isArray(dispatchContext.ctxPayload.ReplyToQuoteEntities)
    ? dispatchContext.ctxPayload.ReplyToQuoteEntities
    : undefined;
  const replyQuoteTargetsBotMessage = dispatchContext.msg.reply_to_message?.from?.is_bot === true;
  const replyQuoteByMessageId: TelegramNativeQuoteCandidateByMessageId = {};
  if (replyToMode !== "off") {
    if (replyQuoteText && replyQuoteMessageId != null) {
      addTelegramNativeQuoteCandidate(replyQuoteByMessageId, replyQuoteMessageId, {
        text: replyQuoteText,
        ...(replyQuotePosition !== undefined ? { position: replyQuotePosition } : {}),
        ...(replyQuoteEntities ? { entities: replyQuoteEntities } : {}),
      });
    }
    addTelegramNativeQuoteCandidate(
      replyQuoteByMessageId,
      dispatchContext.ctxPayload.MessageSid ?? dispatchContext.msg.message_id,
      buildTelegramNativeQuoteCandidate(getTelegramTextParts(dispatchContext.msg)),
    );
    if (
      !dispatchContext.ctxPayload.ReplyToIsExternal &&
      typeof dispatchContext.ctxPayload.ReplyToQuoteSourceText === "string"
    ) {
      addTelegramNativeQuoteCandidate(
        replyQuoteByMessageId,
        dispatchContext.ctxPayload.ReplyToId,
        buildTelegramNativeQuoteCandidate({
          text: dispatchContext.ctxPayload.ReplyToQuoteSourceText,
          entities: Array.isArray(dispatchContext.ctxPayload.ReplyToQuoteSourceEntities)
            ? dispatchContext.ctxPayload.ReplyToQuoteSourceEntities
            : undefined,
        }),
      );
    }
  }
  const draftReplyToMessageId =
    replyToMode !== "off" && typeof dispatchContext.msg.message_id === "number"
      ? replyQuoteTargetsBotMessage
        ? dispatchContext.msg.message_id
        : (replyQuoteMessageId ?? dispatchContext.msg.message_id)
      : undefined;
  // Draft messages are provider-visible before final modifiers run. Suppress them when a hook
  // can rewrite or cancel, or the original payload can flash before the normal delivery gate.
  const hookRunner = getGlobalHookRunner();
  const allowProviderPreview =
    !dispatchContext.ctxPayload.GroupThread &&
    !(
      (hookRunner?.hasHooks("reply_payload_sending") ?? false) ||
      (hookRunner?.hasHooks("message_sending") ?? false)
    );
  const isDispatchSuperseded = () => turnAdoptionLifecycle?.abortSignal?.aborted === true;
  const turnConfig = {
    ...dispatchParams,
    draftReplyToMessageId,
    replyQuoteByMessageId,
    replyQuoteEntities,
    replyQuoteMessageId,
    replyQuotePosition,
    replyQuoteText,
    allowProviderPreview,
    chunkMode: resolveChunkMode(cfg, "telegram", dispatchContext.route.accountId),
    context: dispatchContext,
    dispatchStartedAt,
    isSuperseded: isDispatchSuperseded,
    loadFreshSessionEntry,
    mediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, dispatchContext.route.agentId),
    resolvedReasoningLevel,
    richMessages,
    statusReactionController,
    tableMode,
  };
  const draftState = createDraftState(turnConfig);
  const progressState = createProgressState(turnConfig, draftState, () => turn);
  const deliveryState = createDeliveryState({ ...turnConfig, lanes: draftState.lanes }, () => turn);
  const turn: TelegramDispatchTurn = {
    ...turnConfig,
    ...draftState,
    ...progressState,
    ...deliveryState,
    ...createReplyState(),
    finalDispatchClaimed: false,
    noVisibleReplyFallbackEligible: false,
    suppressSilentReplyFallback: false,
    hadErrorReplyFailureOrSkip: false,
  };

  let turnDispatched: boolean | undefined;
  await prepareTelegramSticker({ cfg, context: dispatchContext });
  loadFreshSessionEntry.clear();
  // Media hydration and other pre-dispatch work can outlive the durable
  // ingress watchdog. Never enter the reply pipeline after that owner has
  // already fenced this attempt; the canonical spool row will retry it.
  if (isDispatchSuperseded()) {
    finalizeStatusInBackground("cancelled", "cancelled finalize");
    return { kind: "completed" };
  }
  if (statusReactionController && !isRoomEvent) {
    void statusReactionController.setThinking();
  }
  try {
    turnDispatched = await runTelegramDispatchTurn(turn);
  } catch (err) {
    turn.dispatchError = err;
    turn.previewLifecycle.observeFailure(
      isChannelPartialDeliveryError(err) ? err.deliveryResult : undefined,
    );
    runtime.error?.(danger(`telegram dispatch failed: ${String(err)}`));
  } finally {
    // Stop producers before draining drafts, finalizing accepted text, and cleaning previews.
    turn.progressCompositor.cancel();
    await turn.draftEventQueue;
    try {
      await finalizePendingAnswerBlockDraft(turn);
    } catch (err) {
      turn.dispatchError ??= err;
      turn.previewLifecycle.observeFailure(
        isChannelPartialDeliveryError(err) ? err.deliveryResult : undefined,
      );
      runtime.error?.(danger(`telegram terminal block delivery failed: ${String(err)}`));
    }
    await cleanupDrafts(turn, isDispatchSuperseded());
  }
  const dispatchWasSuperseded = isDispatchSuperseded();
  if (turnDispatched === false) {
    return { kind: "completed" };
  }
  if (dispatchWasSuperseded) {
    if (statusReactionController) {
      finalizeStatusInBackground("done", "finalize");
    }
    return { kind: "completed" };
  }

  let deliverySummary = turn.deliveryState.snapshot();
  if (!turn.sendPolicyDenied && deliverySummary.failedNonSilent > 0) {
    await settleFailedFinalDelivery(turn);
    deliverySummary = turn.deliveryState.snapshot();
  }
  let sentFallback = false;
  const terminalFailure = turn.dispatchError || turn.agentRunFailed;
  const shouldSendFailureFallback =
    !isRoomEvent &&
    !turn.previewLifecycle.finalSuppressed &&
    !turn.sendPolicyDenied &&
    !turn.finalDispatchClaimed &&
    (!suppressFailureFallback || turn.agentRunFailed) &&
    !turn.previewLifecycle.finalDelivered &&
    (terminalFailure ||
      (!turn.progressContinuationAdopted &&
        (deliverySummary.failedNonSilent > 0 ||
          (deliverySummary.skippedNonSilent > 0 && !turn.suppressSilentReplyFallback))));
  if (shouldSendFailureFallback) {
    const fallbackText = terminalFailure
      ? "Something went wrong while processing your request. Please try again."
      : EMPTY_RESPONSE_FALLBACK;
    const result = await deliverFallback(
      turn,
      [{ text: fallbackText }],
      telegramCfg.silentErrorReplies === true &&
        Boolean(terminalFailure || turn.hadErrorReplyFailureOrSkip),
    );
    sentFallback = result.delivered;
  }

  if (
    !sentFallback &&
    !turn.previewLifecycle.finalSuppressed &&
    !turn.sendPolicyDenied &&
    !turn.dispatchError &&
    !deliverySummary.delivered &&
    !turn.suppressSilentReplyFallback &&
    !turn.finalDispatchClaimed &&
    turn.noVisibleReplyFallbackEligible
  ) {
    sentFallback = (await deliverFallback(turn, [{ text: EMPTY_RESPONSE_FALLBACK }], false))
      .delivered;
    silentReplyDispatchLogger.debug("telegram recovered eligible turn without visible response", {
      hasSessionKey: Boolean(dispatchContext.ctxPayload.SessionKey),
      hasChatId: dispatchContext.chatId != null,
      finalDispatchClaimed: turn.finalDispatchClaimed,
      sentFallback,
    });
  }

  const intentionalNoResponse =
    turn.previewLifecycle.finalSuppressed ||
    turn.sendPolicyDenied ||
    turn.suppressSilentReplyFallback;
  const hasFinalResponse =
    intentionalNoResponse ||
    turn.previewLifecycle.finalDelivered ||
    turn.progressContinuationAdopted ||
    sentFallback;
  const hasVisibleResponse = deliverySummary.delivered || sentFallback;
  const deliveryFailureWithoutFinalResponse =
    !intentionalNoResponse &&
    !turn.previewLifecycle.finalDelivered &&
    !turn.progressContinuationAdopted &&
    (turn.previewLifecycle.finalFailed ||
      deliverySummary.skippedNonSilent > 0 ||
      deliverySummary.failedNonSilent > 0);
  const retryableDispatchFailure =
    turn.dispatchError ??
    (deliveryFailureWithoutFinalResponse
      ? new Error(
          `Telegram reply delivery failed without a final response (failed=${deliverySummary.failedNonSilent}, skipped=${deliverySummary.skippedNonSilent})`,
        )
      : null);

  if (statusReactionController && !hasVisibleResponse && !intentionalNoResponse) {
    finalizeStatusInBackground("error", "error finalize");
  }
  const shouldReturnRetryableDispatchFailure =
    retryDispatchErrors &&
    !turn.finalDispatchClaimed &&
    ((turn.dispatchError != null && !hasFinalResponse) ||
      (turn.dispatchError == null && deliveryFailureWithoutFinalResponse && !hasVisibleResponse));
  if (retryableDispatchFailure && shouldReturnRetryableDispatchFailure) {
    return { kind: "failed-retryable", error: retryableDispatchFailure };
  }
  if (!hasVisibleResponse && !intentionalNoResponse) {
    return { kind: "completed" };
  }

  void trackTopicLabelWork(() =>
    scheduleDmTopicLabel({
      bot,
      cfg,
      context: dispatchContext,
      telegramCfg,
      userMessage: truncateUtf16Safe(
        (dispatchContext.ctxPayload.RawBody ?? dispatchContext.ctxPayload.Body ?? "").trim() ||
          formatMediaPlaceholderText(dispatchContext.ctxPayload.media ?? []),
        500,
      ),
      ...(opts.accountAbortSignal ? { accountAbortSignal: opts.accountAbortSignal } : {}),
    }),
  ).catch((error: unknown) => logVerbose(`auto-topic-label: failed: ${String(error)}`));
  if (statusReactionController) {
    finalizeStatusInBackground(
      turn.agentRunFailed ||
        turn.dispatchError != null ||
        turn.previewLifecycle.finalFailed ||
        (turn.previewLifecycle.finalDelivered && !turn.previewLifecycle.finalSucceeded) ||
        sentFallback
        ? "error"
        : "done",
      "finalize",
    );
  }
  return { kind: "completed" };
};
