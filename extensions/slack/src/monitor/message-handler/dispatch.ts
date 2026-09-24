import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  dispatchChannelInboundTurn,
  resolveInboundReplyDispatchCounts,
  readAgentRunTerminalOutcome,
  type InboundReplyRecordOptions,
  hasVisibleInboundReplyDispatch,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  type LivePreviewDeliveryResult,
} from "openclaw/plugin-sdk/channel-outbound";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import {
  buildTtsSupplementMediaPayload,
  getReplyPayloadTtsSupplement,
  isReplyPayloadNonTerminalToolErrorWarning,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload, ReplyDispatchRuntimeInfo } from "openclaw/plugin-sdk/reply-runtime";
import { danger, logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatSlackError } from "../../errors.js";
import { normalizeSlackOutboundText } from "../../format.js";
import { SLACK_EDIT_TEXT_MAX_BYTES } from "../../limits.js";
import { emitSlackMessageSentHooks } from "../../message-sent-hook.js";
import { resolveSlackReplyRenderPlan } from "../../reply-blocks.js";
import {
  clearSlackThreadFailureNotice,
  hasSlackThreadFailureNotice,
  hasSlackThreadParticipation,
  recordSlackThreadFailureNotice,
  recordSlackThreadParticipation,
} from "../../sent-thread-cache.js";
import { countSlackTextUtf8Bytes } from "../../truncate.js";
import { registerSlackSessionRun } from "../session-run-targets.js";
import { resolveSlackBotLoopProtection } from "./dispatch-helpers.js";
import { createSlackProgressRuntime } from "./dispatch-progress.js";
import { createSlackDispatchSetup, type SlackDispatchSetup } from "./dispatch-setup.js";
import { createSlackStreamingDeliveryRuntime } from "./dispatch-streaming.js";
import { finalizeSlackPreviewEdit } from "./preview-finalize.js";
import type { PreparedSlackMessage } from "./types.js";

function formatSlackGroupThreadReply(text: string, participant: { name: string }): string {
  const name = participant.name.replace(/[\\`*_{}[\]()<>#!|]/g, "\\$&").replace(/\s+/g, " ");
  return `**${name}**\n${text}`;
}

export async function dispatchPreparedSlackMessage(prepared: PreparedSlackMessage) {
  const setup = await createSlackDispatchSetup(prepared);
  const beginSessionRun = () =>
    registerSlackSessionRun(
      prepared.ctx,
      {
        channelId: prepared.message.channel,
        // First-mode roots publish in a thread even without a status target.
        threadTs: setup.streamThreadHint,
        eventScope: prepared.eventScope,
      },
      {
        ...prepared.route,
        sessionKey: prepared.ctxPayload.SessionKey ?? prepared.route.sessionKey,
      },
    );
  const upstreamLifecycle = prepared.turnAdoptionLifecycle;
  let releaseDeferred: (() => void) | undefined;
  const turnAdoptionLifecycle = upstreamLifecycle && {
    ...upstreamLifecycle,
    onDeferred: () => {
      const accepted = upstreamLifecycle.onDeferred?.();
      if (accepted !== false) {
        releaseDeferred ??= beginSessionRun();
      }
      return accepted;
    },
    onSettled: () => {
      releaseDeferred?.();
      upstreamLifecycle.onSettled?.();
    },
  };
  const release = beginSessionRun();
  await dispatchSlackMessageWithSetup(setup, beginSessionRun, turnAdoptionLifecycle).finally(
    release,
  );
}

async function dispatchSlackMessageWithSetup(
  setup: SlackDispatchSetup,
  beginSessionRun: () => () => void,
  turnAdoptionLifecycle: PreparedSlackMessage["turnAdoptionLifecycle"],
) {
  const { prepared } = setup;
  const {
    account,
    cfg,
    ctx,
    disableBlockStreaming,
    hasSlackCustomIdentity,
    hasRepliedRef,
    message,
    messageSentHookContext,
    messageSentHookTarget,
    onModelSelected,
    previewStreamingEnabled,
    replyPipeline,
    replyPlan,
    route,
    runtime,
    slackClient,
    slackStreaming,
    sourceReplyDeliveryMode,
    statusReactions,
    statusReactionsEnabled,
    statusThreadTs,
    suppressRoomEventTyping,
    useStreaming,
  } = setup;
  let dispatchError: unknown;
  const delivery = createSlackStreamingDeliveryRuntime(setup);
  const progress = createSlackProgressRuntime({ setup, delivery });
  const { draftStream, previewLifecycle } = progress;
  // A posted draft/progress message counts as visible output even before it is
  // committed as the reply, so the status keepalive stops at the same moment
  // Slack drops the status row.
  setup.threadStatusGate.hasVisibleOutput = () =>
    delivery.observedReplyDelivery ||
    previewLifecycle.previewFinalized ||
    Boolean(draftStream?.messageId());
  const failureNoticeThreadTs = message.thread_ts;
  const failureNoticeTeamId = prepared.eventScope?.teamId;
  let sawTerminalFailurePayload = false;
  let pendingFailureNotice:
    | {
        accountId: string;
        channelId: string;
        threadTs?: string;
        failureText: string;
        teamId?: string;
      }
    | undefined;

  const filterPassiveThreadFailure = (payload: ReplyPayload): ReplyPayload | null => {
    if (
      payload.isError !== true ||
      prepared.ctxPayload.ChatType !== "channel" ||
      isReplyPayloadNonTerminalToolErrorWarning(payload)
    ) {
      return payload;
    }
    sawTerminalFailurePayload = true;
    if (delivery.observedReplyDelivery || previewLifecycle.previewFinalized) {
      return payload;
    }

    const explicitlyAddressed =
      prepared.ctxPayload.ExplicitlyMentionedBot === true ||
      prepared.ctxPayload.MentionSource === "explicit_bot" ||
      prepared.ctxPayload.MentionSource === "subteam" ||
      prepared.ctxPayload.MentionSource === "mention_pattern" ||
      prepared.ctxPayload.MentionSource === "command_bypass" ||
      (prepared.ctxPayload.CommandTurn?.kind !== undefined &&
        prepared.ctxPayload.CommandTurn.kind !== "normal" &&
        prepared.ctxPayload.CommandTurn.authorized);
    const noticeThreadTs =
      failureNoticeThreadTs ?? (explicitlyAddressed ? statusThreadTs : undefined);

    const notice = {
      accountId: account.accountId,
      channelId: message.channel,
      ...(noticeThreadTs ? { threadTs: noticeThreadTs } : {}),
      failureText: payload.text ?? "",
      ...(failureNoticeTeamId ? { teamId: failureNoticeTeamId } : {}),
    };
    if (
      failureNoticeThreadTs &&
      !explicitlyAddressed &&
      prepared.ctxPayload.MentionSource !== "implicit_thread" &&
      !hasSlackThreadParticipation(
        notice.accountId,
        notice.channelId,
        failureNoticeThreadTs,
        failureNoticeTeamId,
      )
    ) {
      logVerbose("slack: suppressed passive failure before thread participation");
      return null;
    }

    if (!explicitlyAddressed && hasSlackThreadFailureNotice(notice)) {
      logVerbose("slack: suppressed repeated passive channel or thread failure");
      return null;
    }
    pendingFailureNotice = notice;
    return payload;
  };

  const deliverSlackPayload = async (
    incomingPayload: ReplyPayload,
    info: ReplyDispatchRuntimeInfo,
  ): Promise<LivePreviewDeliveryResult> => {
    let payload = incomingPayload;
    if (info.participant && (payload.text || payload.mediaUrl || payload.mediaUrls?.length)) {
      payload = {
        ...payload,
        text: formatSlackGroupThreadReply(payload.text ?? "", info.participant),
      };
    }
    if (info.kind === "final" && slackStreaming.mode === "progress" && progress.isProgressMode) {
      const supplement = getReplyPayloadTtsSupplement(payload);
      const finalPayload =
        !progress.useDraftProgressCard &&
        !progress.useNativeProgressStreaming &&
        supplement &&
        !supplement.visibleTextAlreadyDelivered &&
        !payload.text?.trim()
          ? { ...payload, text: supplement.spokenText }
          : payload;
      const result = await previewLifecycle.deliver({
        kind: info.kind,
        payload: finalPayload,
        isError: payload.isError === true,
        deliverNormally: (reply) =>
          progress.useNativeProgressStreaming
            ? progress.deliverNativeFinal(reply, info.kind)
            : delivery.deliverNormally({
                payload: reply,
                kind: info.kind,
                forcedThreadTs: delivery.usedReplyThreadTs,
              }),
        onNormalDelivered: progress.useDraftProgressCard
          ? async () => {
              const finalized = await progress.finalizeDraftProgressCard(
                payload.isError === true ? "error" : "success",
              );
              if (!finalized) {
                await draftStream?.clear();
              }
            }
          : undefined,
      });
      return result.deliveryResult ?? { visibleReplySent: false };
    }
    if (progress.useNativeProgressStreaming) {
      if (info.kind !== "final" && payload.isError !== true) {
        if (!delivery.isStreamingEligible(payload)) {
          return await delivery.deliverNormally({
            payload,
            kind: info.kind,
            forcedThreadTs:
              delivery.streamSession?.threadTs ?? delivery.nativeProgressStreamThreadTs,
          });
        }
        return await progress.appendNativeNarration(payload, info.kind);
      }
      return await delivery.deliverNormally({
        payload,
        kind: info.kind,
        forcedThreadTs: delivery.streamSession?.threadTs ?? delivery.nativeProgressStreamThreadTs,
      });
    }
    if (useStreaming) {
      const result = await previewLifecycle.deliver({
        kind: info.kind,
        payload,
        isError: payload.isError === true,
        deliverNormally: (reply) =>
          delivery.deliverWithStreaming({ payload: reply, kind: info.kind }),
      });
      return result.deliveryResult ?? { visibleReplySent: false };
    }

    const reply = resolveSendableOutboundReplyParts(payload);
    const ttsSupplement = getReplyPayloadTtsSupplement(payload);
    const replySourceText = payload.text ?? ttsSupplement?.spokenText;
    const replyRenderPlan = resolveSlackReplyRenderPlan(payload, replySourceText);
    const plannedBlocks =
      replyRenderPlan.mode === "single"
        ? replyRenderPlan.blocks
        : replyRenderPlan.blockPart?.blocks;
    const slackBlocks = plannedBlocks;
    const requiresSeparateFallbackDelivery =
      replyRenderPlan.mode === "split" || replyRenderPlan.textIsSlackPlainText === true;
    const trimmedFinalText =
      replyRenderPlan.mode === "single"
        ? replyRenderPlan.text.trim()
        : replyRenderPlan.fallbackText.trim();
    const previewFinalText =
      replyRenderPlan.mode === "single" && replyRenderPlan.textIsSlackMrkdwn
        ? trimmedFinalText
        : normalizeSlackOutboundText((replySourceText ?? "").trim(), {
            tableMode: resolveMarkdownTableMode({
              cfg,
              channel: "slack",
              accountId: account.accountId,
            }),
          });
    const previewFinalTextFitsEdit =
      countSlackTextUtf8Bytes(previewFinalText) <= SLACK_EDIT_TEXT_MAX_BYTES;
    const shouldRestoreTtsSupplementTextForPreviewFallback =
      Boolean(ttsSupplement) &&
      ttsSupplement?.visibleTextAlreadyDelivered !== true &&
      Boolean(draftStream) &&
      !previewLifecycle.previewFinalized &&
      !previewLifecycle.finalDelivered &&
      previewStreamingEnabled &&
      !payload.text?.trim();

    let ttsPreviewFinalization: { threadTs: string | undefined } | undefined;
    const result = await previewLifecycle.deliver({
      kind: info.kind,
      payload,
      isError: payload.isError === true,
      adapter: {
        buildFinalEdit: () => {
          if (
            hasSlackCustomIdentity ||
            !previewStreamingEnabled ||
            (reply.hasMedia && !ttsSupplement) ||
            payload.isError ||
            requiresSeparateFallbackDelivery ||
            !previewFinalTextFitsEdit ||
            (trimmedFinalText.length === 0 && !slackBlocks?.length)
          ) {
            return undefined;
          }
          return {
            text: previewFinalText,
            blocks: slackBlocks,
            threadTs: delivery.usedReplyThreadTs ?? statusThreadTs,
          };
        },
        editFinal: async (preview, edit) => {
          if (ttsSupplement) {
            ttsPreviewFinalization = { threadTs: edit.threadTs };
          }
          const finalized = await draftStream?.finalizeMessage(preview.messageId, async () => {
            await finalizeSlackPreviewEdit({
              client: slackClient,
              token: ctx.botToken,
              accountId: account.accountId,
              channelId: preview.channelId,
              messageId: preview.messageId,
              text: edit.text,
              ...(edit.blocks?.length ? { blocks: edit.blocks } : {}),
              threadTs: edit.threadTs,
            });
          });
          if (!finalized) {
            throw new Error("Slack preview moved below a newer conversation message");
          }
        },
        createPreviewReceipt: (preview, edit) =>
          createMessageReceiptFromOutboundResults({
            results: [
              { channel: "slack", channelId: preview.channelId, messageId: preview.messageId },
            ],
            threadId: edit.threadTs,
            kind: "text",
          }),
        onPreviewFinalized: (preview) => {
          const finalThreadTs = delivery.usedReplyThreadTs ?? statusThreadTs;
          delivery.observedReplyDelivery = true;
          replyPlan.markSent();
          // Supplemental TTS media is the terminal delivery for the logical
          // payload. Marking the preview first would suppress that media send.
          if (!ttsSupplement) {
            delivery.markPreviewPayloadDelivered({
              kind: info.kind,
              payload,
              threadTs: finalThreadTs,
            });
            emitSlackMessageSentHooks({
              ...messageSentHookContext,
              to: messageSentHookTarget,
              accountId: account.accountId,
              content: trimmedFinalText,
              success: true,
              messageId: preview.messageId,
            });
          }
        },
        buildSupplementalPayload: () =>
          ttsSupplement ? buildTtsSupplementMediaPayload(payload) : undefined,
        deliverSupplemental: async (supplementalPayload) => {
          const previewThreadTs = delivery.usedReplyThreadTs ?? statusThreadTs;
          const supplementalResult = await delivery.deliverNormally({
            payload: supplementalPayload,
            kind: info.kind,
            forcedThreadTs: previewThreadTs,
          });
          if (supplementalResult.visibleReplySent) {
            delivery.markPreviewPayloadDelivered({
              kind: info.kind,
              payload,
              threadTs: supplementalResult.threadId,
            });
          }
          return supplementalResult;
        },
        logPreviewEditFailure: (err) => {
          logVerbose(
            `slack: preview final edit failed; falling back to standard send (${formatSlackError(err)})`,
          );
        },
      },
      deliverNormally: async (normalPayload) => {
        return await delivery.deliverNormally({
          payload:
            normalPayload === payload &&
            (shouldRestoreTtsSupplementTextForPreviewFallback ||
              (ttsPreviewFinalization && !payload.text?.trim()))
              ? { ...normalPayload, text: ttsSupplement?.spokenText }
              : normalPayload,
          kind: info.kind,
          ...(ttsPreviewFinalization?.threadTs
            ? { forcedThreadTs: ttsPreviewFinalization.threadTs }
            : {}),
        });
      },
    });
    return result.deliveryResult ?? { visibleReplySent: false };
  };
  let agentRunFailed = false;
  let settledDispatchResult: Parameters<typeof hasVisibleInboundReplyDispatch>[0];
  try {
    const turnResult = await dispatchChannelInboundTurn({
      cfg,
      channel: "slack",
      accountId: route.accountId,
      route: { agentId: route.agentId, sessionKey: route.sessionKey },
      ctxPayload: prepared.ctxPayload,
      dispatchReplyFromConfig: ctx.dispatchReplyFromConfig,
      dispatcherOptions: {
        ...replyPipeline,
        // A channel transform marks intentional silence before core can synthesize an empty-reply error.
        transformReplyPayload: (payload) => {
          const transformed = replyPipeline.transformReplyPayload
            ? replyPipeline.transformReplyPayload(payload)
            : payload;
          return transformed ? filterPassiveThreadFailure(transformed) : null;
        },
        humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
      },
      delivery: {
        deliver: deliverSlackPayload,
        onError: (err, info) => {
          // Core settles delivery errors without throwing; Slack closeout still owns the failure.
          dispatchError ??= err;
          runtime.error?.(danger(`slack ${info.kind} reply failed: ${formatSlackError(err)}`));
          replyPipeline.typingCallbacks?.onIdle?.();
        },
      },
      record: prepared.turn.record as InboundReplyRecordOptions,
      botLoopProtection: resolveSlackBotLoopProtection(prepared),
      replyOptions: {
        groupThreadReplyFormatter: formatSlackGroupThreadReply,
        // Followups can outlive this dispatch and retain their own source address.
        queuedDeliveryCorrelations: [{ begin: beginSessionRun }],
        ...(turnAdoptionLifecycle ? { turnAdoptionLifecycle } : {}),
        skillFilter: prepared.channelConfig?.skills,
        sourceReplyDeliveryMode,
        // Room events are observe-style turns; Slack status indicators imply an
        // automatic visible reply and can auto-open assistant threads.
        suppressTyping: suppressRoomEventTyping ? true : undefined,
        hasRepliedRef,
        disableBlockStreaming,
        onModelSelected,
        suppressDefaultToolProgressMessages: progress.suppressDefaultToolProgressMessages
          ? true
          : undefined,
        commentaryProgressEnabled: progress.commentaryProgressEnabled ? true : undefined,
        progressPreambleEnabled:
          progress.progressDraftActive && slackStreaming.mode === "progress" ? true : undefined,
        commentaryPayloadsEnabled: progress.commentaryProgressEnabled ? true : undefined,
        shouldDeliverCommentaryPayloads: progress.commentaryProgressEnabled
          ? progress.shouldYieldDraftProgress
          : undefined,
        onVerboseProgressVisibility: progress.commentaryProgressEnabled
          ? (isActive) => {
              progress.setShouldYieldDraftProgress(isActive);
            }
          : undefined,
        allowProgressCallbacksWhenSourceDeliverySuppressed:
          sourceReplyDeliveryMode === "message_tool_only" && statusReactionsEnabled
            ? true
            : undefined,
        allowToolLifecycleWhenProgressHidden: statusReactionsEnabled ? true : undefined,
        onPartialReply: useStreaming
          ? undefined
          : !previewStreamingEnabled
            ? undefined
            : async (payload) => {
                return progress.updateDraftFromPartial(payload.text);
              },
        onAssistantMessageStart: progress.onDraftBoundary
          ? async () => {
              await progress.onDraftBoundary?.();
              return false;
            }
          : undefined,
        onReasoningEnd: async () => {
          await progress.onDraftBoundary?.();
          return false;
        },
        onQueuedFollowupAdmitted: progress.onQueuedFollowupAdmitted,
        onQueuedFollowupSettled: progress.onQueuedFollowupSettled,
        onReasoningStream: async (payload) => {
          const visible = await progress.pushReasoningProgress(payload);
          if (statusReactionsEnabled) {
            await statusReactions.setThinking();
          }
          return visible;
        },
        onToolStart: async (payload) => {
          if (statusReactionsEnabled) {
            await statusReactions.setTool(payload.name);
          }
          return await progress.progressDraft.pushToolEvent(payload);
        },
        onItemEvent: async (payload) => {
          if (payload.hideFromChannelProgress || payload.suppressChannelProgress) {
            return progress.preambleOnlyProgress
              ? false
              : progress.progressDraft.pushItemEvent(payload);
          }
          if (payload.kind === "preamble" && progress.shouldYieldDraftProgress()) {
            return false;
          }
          progress.progressWorkCounter.noteItem(payload);
          return progress.preambleOnlyProgress && payload.kind !== "preamble"
            ? await progress.progressDraft.noteActivity()
            : await progress.progressDraft.pushItemEvent(payload);
        },
        onPlanUpdate: async (payload) => {
          if (payload.phase !== "update") {
            return false;
          }
          return await progress.pushPlanProgress(
            payload.steps,
            payload.explanation,
            payload.explanationFormat,
          );
        },
        onApprovalEvent: (payload) => progress.progressDraft.pushApprovalEvent(payload),
      },
    });
    if (turnResult.dispatched) {
      const result = turnResult.dispatchResult;
      settledDispatchResult = result;
      const agentRunOutcome = readAgentRunTerminalOutcome(result);
      agentRunFailed = agentRunOutcome === "failed";
      if (
        agentRunOutcome === "completed" &&
        !sawTerminalFailurePayload &&
        prepared.ctxPayload.ChatType === "channel"
      ) {
        clearSlackThreadFailureNotice({
          accountId: account.accountId,
          channelId: message.channel,
          ...(failureNoticeThreadTs ? { threadTs: failureNoticeThreadTs } : {}),
          ...(failureNoticeTeamId ? { teamId: failureNoticeTeamId } : {}),
        });
      }
    }
  } catch (err) {
    dispatchError ??= err;
  } finally {
    await progress.cancel();
    if (!progress.useDraftProgressCard) {
      await draftStream?.discardPending();
    }
  }

  const completionChunks =
    progress.useNativeProgressStreaming && !progress.nativeProgressCompletionSent
      ? progress.buildNativeProgressCompletionChunks(
          dispatchError || agentRunFailed ? "error" : progress.nativeProgressTerminalStatus,
        )
      : undefined;
  if (completionChunks?.length) {
    progress.nativeProgressCompletionSent = true;
  }
  await delivery.finishStream(completionChunks);

  const anyReplyDelivered = hasVisibleInboundReplyDispatch(settledDispatchResult, {
    observedReplyDelivery: delivery.observedReplyDelivery || previewLifecycle.finalDelivered,
  });

  if (anyReplyDelivered && !previewLifecycle.finalStarted && !dispatchError && !agentRunFailed) {
    // Source/message-tool delivery is authoritative even without an automatic
    // final payload. Native progress alone is not such evidence.
    if (hasVisibleInboundReplyDispatch(settledDispatchResult)) {
      await previewLifecycle.observeDelivery({ visibleReplySent: true });
    }
  }
  await previewLifecycle.cleanup({ failed: Boolean(dispatchError || agentRunFailed) });

  if (pendingFailureNotice && anyReplyDelivered) {
    recordSlackThreadFailureNotice(pendingFailureNotice);
  }

  if (dispatchError || agentRunFailed) {
    await progress.finalizeDraftProgressCard("error");
  }
  await progress.dropDetachedProgressCards();

  if (statusReactionsEnabled) {
    if (dispatchError || agentRunFailed) {
      await statusReactions.setError();
      void statusReactions.restoreInitial();
    } else if (anyReplyDelivered) {
      await statusReactions.setDone();
      void statusReactions.restoreInitial();
    } else {
      // Silent success should preserve queued state and clear any stall timers
      // instead of transitioning to terminal/stall reactions after return.
      await statusReactions.restoreInitial();
    }
  }

  // Record thread participation only when we actually delivered a reply and
  // know the thread ts that was used (set by deliverNormally, streaming start,
  // or draft stream). Falls back to statusThreadTs for edge cases.
  const participationThreadTs = delivery.usedReplyThreadTs ?? statusThreadTs;
  if (anyReplyDelivered && participationThreadTs) {
    recordSlackThreadParticipation(account.accountId, message.channel, participationThreadTs, {
      agentId: route.agentId,
      teamId: prepared.eventScope?.teamId,
    });
  }
  if (dispatchError) {
    throw toErrorObject(dispatchError, "Slack dispatch failed");
  }
  if (
    !anyReplyDelivered &&
    !previewLifecycle.previewFinalized &&
    !(agentRunFailed && progress.useDraftProgressCard)
  ) {
    if (progress.useDraftProgressCard) {
      await draftStream?.clear();
    }
    return;
  }

  if (shouldLogVerbose()) {
    const finalCount = resolveInboundReplyDispatchCounts(settledDispatchResult).final;
    logVerbose(
      `slack: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${prepared.replyTarget}`,
    );
  }
}
