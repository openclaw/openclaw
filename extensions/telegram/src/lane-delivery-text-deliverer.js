import {
  isRecoverableTelegramNetworkError,
  isSafeToRetrySendError,
  isTelegramClientRejection
} from "./network-errors.js";
const MESSAGE_NOT_MODIFIED_RE = /400:\s*Bad Request:\s*message is not modified|MESSAGE_NOT_MODIFIED/i;
const MESSAGE_NOT_FOUND_RE = /400:\s*Bad Request:\s*message to edit not found|MESSAGE_ID_INVALID|message can't be edited/i;
function extractErrorText(err) {
  return typeof err === "string" ? err : err instanceof Error ? err.message : typeof err === "object" && err && "description" in err ? typeof err.description === "string" ? err.description : "" : "";
}
function isMessageNotModifiedError(err) {
  return MESSAGE_NOT_MODIFIED_RE.test(extractErrorText(err));
}
function isMissingPreviewMessageError(err) {
  return MESSAGE_NOT_FOUND_RE.test(extractErrorText(err));
}
function shouldSkipRegressivePreviewUpdate(args) {
  const currentPreviewText = args.currentPreviewText;
  if (currentPreviewText === void 0) {
    return false;
  }
  return currentPreviewText.startsWith(args.text) && args.text.length < currentPreviewText.length && (args.skipRegressive === "always" || args.hadPreviewMessage);
}
function resolvePreviewTarget(params) {
  const lanePreviewMessageId = params.lane.stream?.messageId();
  const previewMessageId = typeof params.previewMessageIdOverride === "number" ? params.previewMessageIdOverride : lanePreviewMessageId;
  const hadPreviewMessage = typeof params.previewMessageIdOverride === "number" || typeof lanePreviewMessageId === "number";
  return {
    hadPreviewMessage,
    previewMessageId: typeof previewMessageId === "number" ? previewMessageId : void 0,
    stopCreatesFirstPreview: params.stopBeforeEdit && !hadPreviewMessage && params.context === "final"
  };
}
function createLaneTextDeliverer(params) {
  const getLanePreviewText = (lane) => lane.lastPartialText;
  const markActivePreviewComplete = (laneName) => {
    params.activePreviewLifecycleByLane[laneName] = "complete";
    params.retainPreviewOnCleanupByLane[laneName] = true;
  };
  const isDraftPreviewLane = (lane) => lane.stream?.previewMode?.() === "draft";
  const canMaterializeDraftFinal = (lane, previewButtons) => {
    const hasPreviewButtons = Boolean(previewButtons && previewButtons.length > 0);
    return isDraftPreviewLane(lane) && !hasPreviewButtons && typeof lane.stream?.materialize === "function";
  };
  const tryMaterializeDraftPreviewForFinal = async (args) => {
    const stream = args.lane.stream;
    if (!stream || !isDraftPreviewLane(args.lane)) {
      return false;
    }
    stream.update(args.text);
    const materializedMessageId = await stream.materialize?.();
    if (typeof materializedMessageId !== "number") {
      params.log(
        `telegram: ${args.laneName} draft preview materialize produced no message id; falling back to standard send`
      );
      return false;
    }
    args.lane.lastPartialText = args.text;
    params.markDelivered();
    return true;
  };
  const tryEditPreviewMessage = async (args) => {
    try {
      await params.editPreview({
        laneName: args.laneName,
        messageId: args.messageId,
        text: args.text,
        previewButtons: args.previewButtons,
        context: args.context
      });
      if (args.updateLaneSnapshot) {
        args.lane.lastPartialText = args.text;
      }
      params.markDelivered();
      return "edited";
    } catch (err) {
      if (isMessageNotModifiedError(err)) {
        params.log(
          `telegram: ${args.laneName} preview ${args.context} edit returned "message is not modified"; treating as delivered`
        );
        params.markDelivered();
        return "edited";
      }
      if (args.context === "final") {
        if (args.finalTextAlreadyLanded) {
          params.log(
            `telegram: ${args.laneName} preview final edit failed after stop flush; keeping existing preview (${String(err)})`
          );
          params.markDelivered();
          return "retained";
        }
        if (isSafeToRetrySendError(err)) {
          params.log(
            `telegram: ${args.laneName} preview final edit failed before reaching Telegram; falling back to standard send (${String(err)})`
          );
          return "fallback";
        }
        if (isMissingPreviewMessageError(err)) {
          if (args.retainAlternatePreviewOnMissingTarget) {
            params.log(
              `telegram: ${args.laneName} preview final edit target missing; keeping alternate preview without fallback (${String(err)})`
            );
            params.markDelivered();
            return "retained";
          }
          params.log(
            `telegram: ${args.laneName} preview final edit target missing with no alternate preview; falling back to standard send (${String(err)})`
          );
          return "fallback";
        }
        if (isRecoverableTelegramNetworkError(err, { allowMessageMatch: true })) {
          params.log(
            `telegram: ${args.laneName} preview final edit may have landed despite network error; keeping existing preview (${String(err)})`
          );
          params.markDelivered();
          return "retained";
        }
        if (isTelegramClientRejection(err)) {
          params.log(
            `telegram: ${args.laneName} preview final edit rejected by Telegram (client error); falling back to standard send (${String(err)})`
          );
          return "fallback";
        }
        params.log(
          `telegram: ${args.laneName} preview final edit failed with ambiguous error; keeping existing preview to avoid duplicate (${String(err)})`
        );
        params.markDelivered();
        return "retained";
      }
      params.log(
        `telegram: ${args.laneName} preview ${args.context} edit failed; falling back to standard send (${String(err)})`
      );
      return "fallback";
    }
  };
  const tryUpdatePreviewForLane = async ({
    lane,
    laneName,
    text,
    previewButtons,
    stopBeforeEdit = false,
    updateLaneSnapshot = false,
    skipRegressive,
    context,
    previewMessageId: previewMessageIdOverride,
    previewTextSnapshot
  }) => {
    const editPreview = (messageId, finalTextAlreadyLanded, retainAlternatePreviewOnMissingTarget) => tryEditPreviewMessage({
      laneName,
      messageId,
      text,
      context,
      previewButtons,
      updateLaneSnapshot,
      lane,
      finalTextAlreadyLanded,
      retainAlternatePreviewOnMissingTarget
    });
    const finalizePreview = (previewMessageId, finalTextAlreadyLanded, hadPreviewMessage, retainAlternatePreviewOnMissingTarget = false) => {
      const currentPreviewText = previewTextSnapshot ?? getLanePreviewText(lane);
      const shouldSkipRegressive = shouldSkipRegressivePreviewUpdate({
        currentPreviewText,
        text,
        skipRegressive,
        hadPreviewMessage
      });
      if (shouldSkipRegressive) {
        params.markDelivered();
        return "edited";
      }
      return editPreview(
        previewMessageId,
        finalTextAlreadyLanded,
        retainAlternatePreviewOnMissingTarget
      );
    };
    if (!lane.stream) {
      return "fallback";
    }
    const previewTargetBeforeStop = resolvePreviewTarget({
      lane,
      previewMessageIdOverride,
      stopBeforeEdit,
      context
    });
    if (previewTargetBeforeStop.stopCreatesFirstPreview) {
      lane.stream.update(text);
      await params.stopDraftLane(lane);
      const previewTargetAfterStop2 = resolvePreviewTarget({
        lane,
        stopBeforeEdit: false,
        context
      });
      if (typeof previewTargetAfterStop2.previewMessageId !== "number") {
        return "fallback";
      }
      return finalizePreview(previewTargetAfterStop2.previewMessageId, true, false);
    }
    if (stopBeforeEdit) {
      await params.stopDraftLane(lane);
    }
    const previewTargetAfterStop = resolvePreviewTarget({
      lane,
      previewMessageIdOverride,
      stopBeforeEdit: false,
      context
    });
    if (typeof previewTargetAfterStop.previewMessageId !== "number") {
      if (context === "final" && lane.hasStreamedMessage && lane.stream?.sendMayHaveLanded?.()) {
        params.log(
          `telegram: ${laneName} preview send may have landed despite missing message id; keeping to avoid duplicate`
        );
        params.markDelivered();
        return "retained";
      }
      return "fallback";
    }
    const activePreviewMessageId = lane.stream?.messageId();
    return finalizePreview(
      previewTargetAfterStop.previewMessageId,
      false,
      previewTargetAfterStop.hadPreviewMessage,
      typeof activePreviewMessageId === "number" && activePreviewMessageId !== previewTargetAfterStop.previewMessageId
    );
  };
  const consumeArchivedAnswerPreviewForFinal = async ({
    lane,
    text,
    payload,
    previewButtons,
    canEditViaPreview
  }) => {
    const archivedPreview = params.archivedAnswerPreviews.shift();
    if (!archivedPreview) {
      return void 0;
    }
    if (canEditViaPreview) {
      const finalized = await tryUpdatePreviewForLane({
        lane,
        laneName: "answer",
        text,
        previewButtons,
        stopBeforeEdit: false,
        skipRegressive: "existingOnly",
        context: "final",
        previewMessageId: archivedPreview.messageId,
        previewTextSnapshot: archivedPreview.textSnapshot
      });
      if (finalized === "edited") {
        return "preview-finalized";
      }
      if (finalized === "retained") {
        params.retainPreviewOnCleanupByLane.answer = true;
        return "preview-retained";
      }
    }
    const delivered = await params.sendPayload(params.applyTextToPayload(payload, text));
    if (delivered || archivedPreview.deleteIfUnused !== false) {
      try {
        await params.deletePreviewMessage(archivedPreview.messageId);
      } catch (err) {
        params.log(
          `telegram: archived answer preview cleanup failed (${archivedPreview.messageId}): ${String(err)}`
        );
      }
    }
    return delivered ? "sent" : "skipped";
  };
  return async ({
    laneName,
    text,
    payload,
    infoKind,
    previewButtons,
    allowPreviewUpdateForNonFinal = false
  }) => {
    const lane = params.lanes[laneName];
    const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
    const canEditViaPreview = !hasMedia && text.length > 0 && text.length <= params.draftMaxChars && !payload.isError;
    if (infoKind === "final") {
      if (params.activePreviewLifecycleByLane[laneName] === "transient") {
        params.retainPreviewOnCleanupByLane[laneName] = false;
      }
      if (laneName === "answer") {
        const archivedResult = await consumeArchivedAnswerPreviewForFinal({
          lane,
          text,
          payload,
          previewButtons,
          canEditViaPreview
        });
        if (archivedResult) {
          return archivedResult;
        }
      }
      if (canEditViaPreview && params.activePreviewLifecycleByLane[laneName] === "transient") {
        await params.flushDraftLane(lane);
        if (laneName === "answer") {
          const archivedResultAfterFlush = await consumeArchivedAnswerPreviewForFinal({
            lane,
            text,
            payload,
            previewButtons,
            canEditViaPreview
          });
          if (archivedResultAfterFlush) {
            return archivedResultAfterFlush;
          }
        }
        if (canMaterializeDraftFinal(lane, previewButtons)) {
          const materialized = await tryMaterializeDraftPreviewForFinal({
            lane,
            laneName,
            text
          });
          if (materialized) {
            markActivePreviewComplete(laneName);
            return "preview-finalized";
          }
        }
        const finalized = await tryUpdatePreviewForLane({
          lane,
          laneName,
          text,
          previewButtons,
          stopBeforeEdit: true,
          skipRegressive: "existingOnly",
          context: "final"
        });
        if (finalized === "edited") {
          markActivePreviewComplete(laneName);
          return "preview-finalized";
        }
        if (finalized === "retained") {
          markActivePreviewComplete(laneName);
          return "preview-retained";
        }
      } else if (!hasMedia && !payload.isError && text.length > params.draftMaxChars) {
        params.log(
          `telegram: preview final too long for edit (${text.length} > ${params.draftMaxChars}); falling back to standard send`
        );
      }
      await params.stopDraftLane(lane);
      const delivered2 = await params.sendPayload(params.applyTextToPayload(payload, text));
      return delivered2 ? "sent" : "skipped";
    }
    if (allowPreviewUpdateForNonFinal && canEditViaPreview) {
      if (isDraftPreviewLane(lane)) {
        const previewRevisionBeforeFlush = lane.stream?.previewRevision?.() ?? 0;
        lane.stream?.update(text);
        await params.flushDraftLane(lane);
        const previewUpdated = (lane.stream?.previewRevision?.() ?? 0) > previewRevisionBeforeFlush;
        if (!previewUpdated) {
          params.log(
            `telegram: ${laneName} draft preview update not emitted; falling back to standard send`
          );
          const delivered2 = await params.sendPayload(params.applyTextToPayload(payload, text));
          return delivered2 ? "sent" : "skipped";
        }
        lane.lastPartialText = text;
        params.markDelivered();
        return "preview-updated";
      }
      const updated = await tryUpdatePreviewForLane({
        lane,
        laneName,
        text,
        previewButtons,
        stopBeforeEdit: false,
        updateLaneSnapshot: true,
        skipRegressive: "always",
        context: "update"
      });
      if (updated === "edited") {
        return "preview-updated";
      }
    }
    const delivered = await params.sendPayload(params.applyTextToPayload(payload, text));
    return delivered ? "sent" : "skipped";
  };
}
export {
  createLaneTextDeliverer
};
