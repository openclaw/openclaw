import { AsyncLocalStorage } from "node:async_hooks";
import { EmbeddedBlockChunker } from "openclaw/plugin-sdk/agent-runtime";
import {
  type ChannelProgressDraftLine,
  createChannelProgressDraftCompositor,
  createLivePreviewLifecycle,
  resolveChannelDraftStreamingChunking,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingPreviewCommandText,
  resolveChannelStreamingProgressNarration,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import {
  resolveSendableOutboundReplyParts,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyDispatchRuntimeInfo } from "openclaw/plugin-sdk/reply-runtime";
import {
  stripInlineDirectiveTagsForDelivery,
  stripReasoningTagsFromText,
} from "openclaw/plugin-sdk/text-chunking";
import { createDiscordDraftStream } from "../draft-stream.js";
import type { RequestClient } from "../internal/discord.js";
import {
  captureDiscordRequestAuthority,
  withDiscordRequestAuthority,
} from "../internal/request-authority.js";
import { DISCORD_TEXT_CHUNK_LIMIT } from "../outbound-adapter.js";
import { resolveDiscordPreviewStreamMode } from "../preview-streaming.js";
import { retainDiscordProgressDraft } from "./message-handler.progress-continuation.js";

type DraftReplyReference = {
  peek: () => string | undefined;
};

type DiscordConfig = NonNullable<OpenClawConfig["channels"]>["discord"];

export function createDiscordDraftPreviewController(params: {
  cfg: OpenClawConfig;
  discordConfig: DiscordConfig;
  accountId: string;
  abortSignal?: AbortSignal;
  isPolicyCurrent?: () => boolean;
  sourceRepliesAreToolOnly: boolean;
  groupThread?: boolean;
  isRoomEvent?: boolean;
  textLimit: number;
  deliveryRest: RequestClient;
  deliverChannelId: string;
  replyReference: DraftReplyReference;
  onFinalReplyStart?: () => void;
  onFinalReplyDelivered?: () => void;
  log: (message: string) => void;
}) {
  // Capture the channel owner before per-reply delivery binds a requester assertion.
  // Retained work restores this scope, never a settled requester or child tool scope.
  const runInChannelScope = AsyncLocalStorage.snapshot();
  const assertChannelAuthority = captureDiscordRequestAuthority();
  const discordStreamMode = resolveDiscordPreviewStreamMode(params.discordConfig);
  // Provider drafts are visible before outbound modifiers run. Keep them off whenever a hook
  // can rewrite or cancel so the original payload cannot flash before durable delivery.
  const hookRunner = getGlobalHookRunner();
  const allowProviderPreview =
    !params.groupThread &&
    !params.isRoomEvent &&
    !(
      (hookRunner?.hasHooks("reply_payload_sending") ?? false) ||
      (hookRunner?.hasHooks("message_sending") ?? false)
    );
  const draftMaxChars = Math.min(params.textLimit, 2000);
  const canStreamProgressDraftForToolOnlySource =
    params.sourceRepliesAreToolOnly && discordStreamMode === "progress";
  const previewAvailable =
    allowProviderPreview &&
    (!params.sourceRepliesAreToolOnly || canStreamProgressDraftForToolOnlySource) &&
    discordStreamMode !== "off";
  const accountBlockStreamingEnabled = resolveChannelStreamingBlockEnabled(params.discordConfig, {
    previewAvailable,
    blockStreamingDefault: params.cfg.agents?.defaults?.blockStreamingDefault,
  });
  const canStreamDraft = previewAvailable && !accountBlockStreamingEnabled;
  let currentChannelId = params.deliverChannelId;
  const createDraftStream = () =>
    createDiscordDraftStream({
      rest: params.deliveryRest,
      channelId: currentChannelId,
      maxChars: draftMaxChars,
      replyToMessageId: () => params.replyReference.peek(),
      minInitialChars: discordStreamMode === "progress" ? 0 : 30,
      suppressEmbeds: params.discordConfig?.suppressEmbeds ?? true,
      throttleMs: 1200,
      log: params.log,
      warn: params.log,
    });
  let draftStream = canStreamDraft ? createDraftStream() : undefined;
  const draftChunking =
    draftStream && discordStreamMode === "block"
      ? resolveChannelDraftStreamingChunking(params.cfg, "discord", params.accountId, {
          fallbackLimit: DISCORD_TEXT_CHUNK_LIMIT,
        })
      : undefined;
  const draftChunker = draftChunking ? new EmbeddedBlockChunker(draftChunking) : undefined;
  let lastPartialText = "";
  let draftText = "";
  let hasStreamedAssistantText = false;
  let progressNarratorLifecycle: { beginTurn: () => void; stopTurn: () => void } | undefined;
  const narrationProgressEnabled =
    Boolean(draftStream) &&
    discordStreamMode === "progress" &&
    resolveChannelStreamingProgressNarration(params.discordConfig);
  // Narration model input follows the channel's command-text display policy:
  // "status" hides raw exec/bash text from viewers, so it must not reach the
  // utility model either.
  const narrationHideCommandText =
    narrationProgressEnabled &&
    resolveChannelStreamingPreviewCommandText(params.discordConfig) === "status";
  const progressSeed = `${params.accountId}:${params.deliverChannelId}`;
  const progressDraft = createChannelProgressDraftCompositor({
    preparedItems: true,
    showWorkStatus: true,
    entry: params.discordConfig,
    mode: discordStreamMode,
    active: Boolean(draftStream),
    seed: progressSeed,
    reasoningLinePrefix: "🧠 ",
    commentaryLinePrefix: "💬 ",
    commentaryItalics: false,
    update: async (previewText, options) => {
      if (!draftStream) {
        return false;
      }
      lastPartialText = previewText;
      draftText = previewText;
      draftChunker?.reset();
      draftStream.update(previewText, { complete: true });
      if (options?.flush) {
        await draftStream.flush();
      }
      // REST-backed draft work is pending until Discord returns a message id.
      return Boolean(draftStream.messageId());
    },
    deleteCurrent: async () => {
      lastPartialText = "";
      draftText = "";
      hasStreamedAssistantText = false;
      await draftStream?.deleteCurrentMessage();
    },
    isEmptyLine: isEmptyDiscordProgressLine,
    shouldStartNow: shouldStartDiscordProgressDraftNow,
  });

  const freezeProgress = () => {
    progressDraft.markFinalReplyStarted();
    progressNarratorLifecycle?.stopTurn();
  };
  const flush = async () => {
    if (!draftStream) {
      return;
    }
    if (draftChunker?.hasBuffered()) {
      draftChunker.drain({
        force: true,
        emit: (chunk, metadata) => {
          draftText += metadata?.sourceText ?? chunk;
        },
      });
      draftChunker.reset();
      if (draftText) {
        draftStream.update(draftText);
      }
    }
    await draftStream.flush();
  };
  const lifecycle = createLivePreviewLifecycle<ReplyPayload, string>({
    draft: draftStream
      ? {
          flush,
          id: () => draftStream?.messageId(),
          seal: async () => {
            await draftStream?.seal();
          },
          discardPending: async () => {
            await draftStream?.discardPending();
          },
          clear: async () => await draftStream?.clear(),
        }
      : undefined,
    retainOnError: true,
    cleanupUndelivered: true,
    onFinalStarted: () => {
      freezeProgress();
      params.onFinalReplyStart?.();
    },
    onFinalDelivered: () => {
      progressDraft.markFinalReplyDelivered();
      params.onFinalReplyDelivered?.();
    },
    onCleanupFailure: (err) => params.log(`discord: draft cleanup failed: ${String(err)}`),
  });

  const resetProgressState = () => {
    lastPartialText = "";
    draftText = "";
    hasStreamedAssistantText = false;
    draftChunker?.reset();
  };

  const beginNewProgressTurn = (options?: { force?: boolean }) => {
    const beganNewTurn = progressDraft.beginNewTurn(options);
    if (beganNewTurn) {
      // A retained continuation owns its old stream; queued work needs a new one.
      if (!draftStream && canStreamDraft) {
        draftStream = createDraftStream();
      }
      lifecycle.reset();
      progressNarratorLifecycle?.beginTurn();
    } else {
      progressDraft.beginAssistantMessage();
    }
    if (discordStreamMode === "progress") {
      if (beganNewTurn) {
        draftStream?.forceNewMessage("discard");
      }
    } else {
      if (discordStreamMode === "block" && hasStreamedAssistantText) {
        params.log("discord: calling forceNewMessage() for draft stream");
        draftStream?.forceNewMessage();
      }
      resetProgressState();
    }
    return beganNewTurn;
  };

  return {
    get draftStream() {
      return draftStream;
    },
    lifecycle,
    narrationProgressEnabled,
    narrationHideCommandText,
    commentaryProgressEnabled: progressDraft.commentaryProgressEnabled,
    suppressDefaultToolProgressMessages: progressDraft.suppressDefaultToolProgressMessages,
    get isProgressMode() {
      return discordStreamMode === "progress";
    },
    get isProgressDraftVisible() {
      return progressDraft.isVisible;
    },
    setProgressNarratorLifecycle(narratorLifecycle: {
      beginTurn: () => void;
      stopTurn: () => void;
    }) {
      progressNarratorLifecycle = narratorLifecycle;
    },
    freezeProgress,
    async adoptProgressDraft(payload: ReplyPayload, info: ReplyDispatchRuntimeInfo) {
      const stream = draftStream;
      const adopt = info.adoptProgressDraft;
      if (
        !stream ||
        discordStreamMode !== "progress" ||
        !adopt ||
        info.kind !== "final" ||
        payload.isError ||
        payload.isCommentary ||
        payload.isReasoning ||
        resolveSendableOutboundReplyParts(payload).hasMedia ||
        payload.interactive !== undefined ||
        payload.presentation !== undefined ||
        payload.channelData !== undefined ||
        lifecycle.previewFinalized
      ) {
        return false;
      }
      const snapshot = progressDraft.getSnapshot();
      const text = progressDraft.getText().trimEnd();
      // No label-only card can substitute for the required waiting reply.
      if (
        !text ||
        (!progressDraft.hasStatusHeadline &&
          !progressDraft.hasPlanProgress &&
          !snapshot.lines.length)
      ) {
        return false;
      }
      const assertCurrent = () => {
        params.abortSignal?.throwIfAborted();
        info.assertPlatformSendAuthorized?.();
      };
      // beforeDeliver freezes the producer. Publish its existing state without
      // reopening callbacks, then transfer only confirmed transport custody.
      freezeProgress();
      await withDiscordRequestAuthority(assertCurrent, async () => {
        assertCurrent();
        stream.update(text, { complete: true });
        await stream.flush();
        assertCurrent();
      });
      if (
        !stream.messageId() ||
        stream.isStopped() ||
        stream.lastDeliveredText() !== text ||
        draftStream !== stream
      ) {
        return false;
      }
      assertCurrent();
      if (
        !adopt(
          retainDiscordProgressDraft({
            stream,
            snapshot,
            entry: params.discordConfig,
            seed: progressSeed,
            log: params.log,
            runInChannelScope,
            assertChannelAuthority,
            isPolicyCurrent: params.isPolicyCurrent,
          }),
        )
      ) {
        return false;
      }
      lifecycle.retainPreview();
      draftStream = undefined;
      resetProgressState();
      return true;
    },
    async retarget(channelId: string) {
      await draftStream?.retarget(channelId);
      currentChannelId = channelId;
    },
    async finalizeProgressDraft() {
      if (!draftStream || discordStreamMode !== "progress") {
        return false;
      }
      const progressText = lastPartialText.trimEnd();
      if (!progressText) {
        return false;
      }
      // Seal the draft on its own last content. The finished draft is the turn
      // record, so nothing synthesized gets appended to it.
      lifecycle.retainPreview();
      draftStream.update(progressText);
      await draftStream.stop();
      return Boolean(draftStream.messageId());
    },
    disableBlockStreamingForDraft: draftStream ? true : undefined,
    pushToolEvent: progressDraft.pushToolEvent,
    pushItemEvent: progressDraft.pushItemEvent.bind(progressDraft),
    pushApprovalEvent: progressDraft.pushApprovalEvent.bind(progressDraft),
    pushPlanProgress: progressDraft.pushPlanProgress.bind(progressDraft),
    pushReasoningProgress: progressDraft.pushReasoningProgress.bind(progressDraft),
    pushNarrationProgress: progressDraft.pushNarrationProgress.bind(progressDraft),
    updateFromPartial(text?: string) {
      const stream = draftStream;
      if (!stream || !text) {
        return;
      }
      const cleaned = stripInlineDirectiveTagsForDelivery(
        stripReasoningTagsFromText(text, { mode: "strict", trim: "both" }),
      ).text;
      if (
        !cleaned ||
        cleaned.startsWith("Reasoning:\n") ||
        cleaned === lastPartialText ||
        discordStreamMode === "progress"
      ) {
        return;
      }
      progressDraft.resetActivity({ suppressed: true });
      hasStreamedAssistantText = true;
      if (discordStreamMode === "partial") {
        if (
          lastPartialText &&
          lastPartialText.startsWith(cleaned) &&
          cleaned.length < lastPartialText.length
        ) {
          return;
        }
        lastPartialText = cleaned;
        stream.update(cleaned);
        return;
      }

      let delta = cleaned;
      if (cleaned.startsWith(lastPartialText)) {
        delta = cleaned.slice(lastPartialText.length);
      } else {
        draftChunker?.reset();
        draftText = "";
      }
      lastPartialText = cleaned;
      if (!delta) {
        return;
      }
      if (!draftChunker) {
        draftText = cleaned;
        stream.update(draftText);
        return;
      }
      draftChunker.append(delta);
      draftChunker.drain({
        force: false,
        mutablePreview: true,
        emit: (chunk, metadata) => {
          draftText += metadata?.sourceText ?? chunk;
          stream.update(draftText);
        },
      });
    },
    handleAssistantMessageBoundary() {
      // Queued/followup turns need a fresh progress draft after the primary final.
      return beginNewProgressTurn();
    },
    resetReasoningProgress: progressDraft.resetReasoningProgress,
    handleQueuedFollowupAdmitted() {
      return beginNewProgressTurn({ force: true });
    },
    flush,
    async cleanup({ failed = false }: { failed?: boolean } = {}) {
      try {
        progressDraft.cancel();
        await lifecycle.cleanup({ failed });
        await draftStream?.cleanupPendingMessages();
      } catch (err) {
        params.log(`discord: draft cleanup failed: ${String(err)}`);
      }
    },
  };
}

function isEmptyDiscordProgressLine(line: string | ChannelProgressDraftLine | undefined): boolean {
  if (!line || typeof line === "string") {
    return false;
  }
  return line.toolName === "apply_patch" && !line.detail && !line.status;
}

function shouldStartDiscordProgressDraftNow(
  line: string | ChannelProgressDraftLine | undefined,
): boolean {
  return typeof line === "object" && line?.kind === "patch" && Boolean(line.detail);
}
