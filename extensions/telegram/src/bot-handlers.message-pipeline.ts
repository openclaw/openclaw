import type { Message } from "grammy/types";
import { firstDefined } from "openclaw/plugin-sdk/allow-from";
import { resolveChannelContextVisibilityMode } from "openclaw/plugin-sdk/context-visibility-runtime";
import { kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import type { ChannelReplayClaimHandle } from "openclaw/plugin-sdk/persistent-dedupe";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { evaluateSupplementalContextVisibility } from "openclaw/plugin-sdk/security-runtime";
import { expandTelegramAllowFromWithAccessGroups } from "./access-groups.js";
import { resolveTelegramAccount, resolveTelegramMediaRuntimeOptions } from "./accounts.js";
import { isSenderAllowed, normalizeAllowFrom } from "./bot-access.js";
import {
  createTelegramMessageContextRuntime,
  createTelegramMessageSessionRuntime,
  type TelegramPromptContextMessageSelection,
} from "./bot-handlers.message-context.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import type { TelegramMediaRef } from "./bot-message-context.js";
import type { TelegramMessageContextOptions } from "./bot-message-context.types.js";
import {
  createTelegramSpooledReplayDeferredParticipant,
  createTelegramSpooledReplayParticipant,
  getTelegramSpooledReplayDeferredParticipant,
  getTelegramSpooledReplayLifecycle,
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
  type TelegramMessageProcessingResult,
  type TelegramSpooledReplayDeferredParticipant,
  type TelegramSpooledReplaySettlementHold,
} from "./bot-processing-outcome.js";
import { resolveMedia } from "./bot/delivery.resolve-media.js";
import {
  describeReplyTarget,
  resolveTelegramMessageThreadSpec,
  resolveTelegramPrimaryMedia,
} from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import { resolveTelegramScopedGroupConfig } from "./group-config-helpers.js";
import type { TelegramCachedMessageNode, TelegramReplyChainEntry } from "./message-cache-codec.js";
import type { TelegramResolvedMedia } from "./message-cache-persistence.js";
import {
  claimTelegramMessageDispatchReplay,
  commitTelegramMessageDispatchReplay,
  createTelegramMessageDispatchReplayGuard,
  releaseTelegramMessageDispatchReplay,
} from "./message-dispatch-dedupe.js";
import {
  resolveTelegramInboundMediaUri,
  resolveTelegramPromptMediaPath,
} from "./prompt-media-path.js";

const HOUR_MS = 60 * 60_000;

function resolveRetainedTelegramMedia(params: {
  media?: TelegramResolvedMedia;
  sourceMessage: Parameters<typeof resolveMedia>[0]["ctx"]["message"];
  maxBytes: number;
  ttlHours?: number;
}): TelegramMediaRef | undefined {
  const media = params.media;
  if (!media || media.size > params.maxBytes) {
    return undefined;
  }
  // The gateway's configured retention sweep owns file expiry. Mirror that
  // deadline here so reply hydration never polls the filesystem for freshness.
  if (params.ttlHours !== undefined && media.savedAt + params.ttlHours * HOUR_MS <= Date.now()) {
    return undefined;
  }
  const path = resolveTelegramInboundMediaUri(media.id);
  const fileName =
    params.sourceMessage.document?.file_name ??
    params.sourceMessage.audio?.file_name ??
    params.sourceMessage.video?.file_name ??
    params.sourceMessage.animation?.file_name;
  return path
    ? {
        path,
        kind: media.kind,
        ...(media.contentType ? { contentType: media.contentType } : {}),
        ...(fileName ? { fileName } : {}),
        ...(media.stickerMetadata ? { stickerMetadata: media.stickerMetadata } : {}),
      }
    : undefined;
}

export function createTelegramMessagePipeline({
  cfg,
  accountId,
  ownerAgentId,
  bot,
  opts,
  telegramTransport,
  runtime,
  mediaMaxBytes,
  telegramCfg,
  resolveTelegramGroupConfig,
  processMessage,
  logger,
  telegramDeps,
}: RegisterTelegramHandlerParams) {
  const { token } = opts;
  const mediaRuntimeOptions = resolveTelegramMediaRuntimeOptions({
    cfg,
    accountId,
    token,
    transport: telegramTransport,
  });
  // Resolve the ALS owner at operation time; buffered callers retain ownership
  // after that frame ends by passing their participant signals explicitly.
  const resolveMediaRuntime = (...explicitSignals: AbortSignal[]) => {
    const abortSignals = [
      opts.mediaAbortSignal,
      opts.fetchAbortSignal,
      getTelegramSpooledReplayLifecycle()?.abortSignal,
      ...explicitSignals,
    ].filter((signal): signal is AbortSignal => signal !== undefined);
    return {
      ...mediaRuntimeOptions,
      abortSignal: abortSignals.length > 1 ? AbortSignal.any(abortSignals) : abortSignals[0],
    };
  };
  const sessionRuntime = createTelegramMessageSessionRuntime({
    accountId,
    resolveTelegramGroupConfig,
    telegramDeps,
  });
  const { resolveTelegramSessionState, resolvePromptContextAmbientWatermark } = sessionRuntime;
  const {
    recordMessageForReplyChain,
    recordMessageResolvedMedia,
    recordReplyMessageResolvedMedia,
    resolveCachedMessageThreadSpec,
    buildReplyChainForMessage,
    toReplyChainEntry,
    buildPromptContextForMessage,
  } = createTelegramMessageContextRuntime({
    cfg,
    accountId,
    ownerAgentId,
    opts,
    telegramCfg,
    telegramDeps,
  });
  const replayGuard = createTelegramMessageDispatchReplayGuard({
    onDiskError: (error) => {
      runtime.error?.(danger(`[telegram] message dispatch dedupe store failed: ${String(error)}`));
    },
  });
  const mergeDispatchDedupeClaims = (
    ...groups: Array<readonly ChannelReplayClaimHandle[] | undefined>
  ) => [...new Set(groups.flatMap((group) => group ?? []))];
  const releaseDispatchDedupeClaims = (
    claims: readonly ChannelReplayClaimHandle[],
    error?: unknown,
  ) => {
    releaseTelegramMessageDispatchReplay({ claims, error });
  };
  const commitDispatchDedupeClaims = async (
    claims: readonly ChannelReplayClaimHandle[],
    options: { requirePersistent?: boolean } = {},
  ) => {
    await commitTelegramMessageDispatchReplay({ guard: replayGuard, claims, ...options });
  };
  const buildFailedProcessingResult = (error: unknown): TelegramMessageProcessingResult => ({
    kind: "failed-retryable",
    error,
  });
  const settleSpooledReplayParticipants = (
    participants: readonly TelegramSpooledReplayDeferredParticipant[],
    result: TelegramMessageProcessingResult,
  ) => {
    for (const participant of new Set(participants)) {
      participant.settle(result);
    }
  };
  const beginSpooledReplaySettlementHolds = (
    participants: readonly TelegramSpooledReplayDeferredParticipant[],
  ) => {
    const holds: TelegramSpooledReplaySettlementHold[] = [];
    for (const participant of new Set(participants)) {
      const hold = participant.beginSettlementHold();
      if (!hold) {
        for (const acquired of holds) {
          acquired.release("replay-pending");
        }
        const reason = participant.abortSignal.reason;
        throw reason instanceof Error
          ? reason
          : new Error(
              `telegram spooled replay participant ${participant.key} settled before durable adoption`,
            );
      }
      holds.push(hold);
    }
    return (mode: Parameters<TelegramSpooledReplaySettlementHold["release"]>[0]) => {
      for (const hold of holds) {
        hold.release(mode);
      }
    };
  };
  const createSpooledReplayParticipantForBufferedWork = (key: string) =>
    createTelegramSpooledReplayDeferredParticipant(key) ?? undefined;
  const spooledReplayOptions = (
    participants: readonly TelegramSpooledReplayDeferredParticipant[],
  ): Pick<TelegramMessageContextOptions, "spooledReplay"> =>
    participants.length > 0 ? { spooledReplay: true } : {};
  const claimMessageDispatchDedupe = async (
    msg: Message,
    botUserId: number,
  ): Promise<{ process: true; claims: ChannelReplayClaimHandle[] } | { process: false }> => {
    const claim = await claimTelegramMessageDispatchReplay({
      guard: replayGuard,
      accountId,
      botUserId,
      msg,
    });
    if (claim.kind === "duplicate") {
      logVerbose(`telegram dispatch dedupe: skipped message ${msg.chat.id}:${msg.message_id}`);
      return { process: false };
    }
    return { process: true, claims: claim.kind === "claimed" ? [claim.handle] : [] };
  };

  const resolveReplyMediaForChain = async (
    ctx: TelegramContext,
    chain: TelegramCachedMessageNode[],
    shouldHydrateMedia: (
      sender: Pick<TelegramReplyChainEntry, "senderId" | "senderUsername">,
      index: number,
    ) => Promise<boolean>,
    durableMediaReplay: boolean,
    ...participantSignals: AbortSignal[]
  ): Promise<{ replyMedia: TelegramMediaRef[]; replyChain: TelegramReplyChainEntry[] }> => {
    const mediaRuntime = resolveMediaRuntime(...participantSignals);
    const replyMedia: TelegramMediaRef[] = [];
    const replyChain: TelegramReplyChainEntry[] = [];
    const hydrateMedia = async (
      sourceMessage: Parameters<typeof resolveMedia>[0]["ctx"]["message"],
      replyFileId: string,
      node?: TelegramCachedMessageNode,
    ): Promise<TelegramMediaRef | undefined> => {
      let mediaRef: TelegramMediaRef | undefined;
      try {
        mediaRuntime.abortSignal?.throwIfAborted();
        const retainedMedia = resolveRetainedTelegramMedia({
          media: node?.resolvedMedia,
          sourceMessage,
          maxBytes: mediaMaxBytes,
          ttlHours: cfg.attachments?.ttlHours,
        });
        if (retainedMedia) {
          return retainedMedia;
        }
        const media = await resolveMedia({
          ctx: {
            message: sourceMessage,
            me: ctx.me,
            getFile: async (signal) => await bot.api.getFile(replyFileId, signal),
          },
          maxBytes: mediaMaxBytes,
          ...mediaRuntime,
        });
        if (!media) {
          return undefined;
        }
        mediaRef = {
          path: media.path,
          kind: media.kind,
          ...(media.contentType ? { contentType: media.contentType } : {}),
          ...(media.fileName ? { fileName: media.fileName } : {}),
          ...(media.stickerMetadata ? { stickerMetadata: media.stickerMetadata } : {}),
        };
        if (node) {
          await recordReplyMessageResolvedMedia({
            chatId: node.sourceMessage.chat.id,
            messageId: node.messageId,
            media,
            botUserId: ctx.me?.id,
          });
        }
      } catch (err) {
        // Only durable ingress can replay a reply-media abort. Live polling must
        // preserve the current text instead of acknowledging it without dispatch.
        if (mediaRuntime.abortSignal?.aborted && durableMediaReplay) {
          recordTelegramMessageProcessingResult({ kind: "failed-retryable", error: err });
          throw err;
        }
        logger.warn(
          { chatId: ctx.message.chat.id, error: String(err) },
          "reply media fetch failed",
        );
      }
      return mediaRef;
    };
    for (const [index, node] of chain.entries()) {
      const replyFileId = resolveTelegramPrimaryMedia(node.sourceMessage)?.fileRef.file_id;
      const mediaRef =
        replyFileId && (await shouldHydrateMedia(node, index))
          ? await hydrateMedia(node.sourceMessage, replyFileId, node)
          : undefined;
      if (mediaRef) {
        replyMedia.push(mediaRef);
      }
      replyChain.push(toReplyChainEntry(node, ctx, mediaRef));
    }
    // An explicit external reply belongs to this turn, not to the current chat's cache.
    const externalReply =
      chain.length === 0 && !ctx.message.reply_to_message ? ctx.message.external_reply : undefined;
    const externalFileId = resolveTelegramPrimaryMedia(externalReply)?.fileRef.file_id;
    const externalTarget = externalFileId ? describeReplyTarget(ctx.message) : null;
    if (
      externalReply &&
      externalFileId &&
      externalTarget &&
      (await shouldHydrateMedia(externalTarget, 0))
    ) {
      const mediaRef = await hydrateMedia(externalReply, externalFileId);
      if (mediaRef) {
        replyMedia.push(mediaRef);
      }
    }
    return { replyMedia, replyChain };
  };

  const processMessageWithReplyChain = async (params: {
    ctx: TelegramContext;
    msg: Message;
    allMedia: TelegramMediaRef[];
    promptContextMessageSelection?: TelegramPromptContextMessageSelection;
    storeAllowFrom: string[];
    options?: TelegramMessageContextOptions;
    dispatchDedupeClaims?: ChannelReplayClaimHandle[];
    spooledReplayParticipants?: readonly TelegramSpooledReplayDeferredParticipant[];
    spooledReplayAbortSignal?: AbortSignal;
  }): Promise<TelegramMessageProcessingResult> => {
    let dispatchDedupeCommitted = false;
    let spooledReplayFinalResult: TelegramMessageProcessingResult | undefined;
    let spooledReplayFinalization: Promise<TelegramMessageProcessingResult> | undefined;
    // Callback-submit retries also set options.spooledReplay without durable ingress.
    // Media aborts retry only when the update frame or a buffered participant owns replay.
    const durableMediaReplay =
      isTelegramSpooledReplayUpdate(params.ctx.update) ||
      Boolean(params.spooledReplayParticipants?.length);
    const spooledReplay = params.options?.spooledReplay === true || durableMediaReplay;
    const explicitParticipants = params.spooledReplayParticipants ?? [];
    const frameParticipant =
      spooledReplay &&
      explicitParticipants.length === 0 &&
      params.options?.isolateSpooledReplaySettlement !== true
        ? (getTelegramSpooledReplayDeferredParticipant() ??
          createTelegramSpooledReplayDeferredParticipant(
            `message:${params.msg.chat.id}:${params.msg.message_id}`,
          ) ??
          undefined)
        : undefined;
    const ingressSpooledReplayParticipants = [
      ...explicitParticipants,
      ...(frameParticipant ? [frameParticipant] : []),
    ];
    const processingParticipant =
      explicitParticipants.length > 0
        ? createTelegramSpooledReplayParticipant(
            `message-processing:${params.msg.chat.id}:${params.msg.message_id}`,
          )
        : frameParticipant;
    if (processingParticipant && explicitParticipants.length > 0) {
      for (const participant of explicitParticipants) {
        void participant.task.then((result) => {
          processingParticipant.settle(result);
        });
      }
    }
    const spooledReplayParticipants = [
      ...new Set([
        ...ingressSpooledReplayParticipants,
        ...(processingParticipant ? [processingParticipant] : []),
      ]),
    ];
    const finalizeSpooledReplayResult = async (
      result: TelegramMessageProcessingResult,
    ): Promise<TelegramMessageProcessingResult> => {
      if (spooledReplayFinalResult) {
        return spooledReplayFinalResult;
      }
      if (spooledReplayFinalization) {
        return await spooledReplayFinalization;
      }
      const finalization = (async () => {
        const finalized = result;
        if (result.kind === "completed") {
          // Do not cache or settle a durable-adoption failure. Deferred queue
          // ownership retries this callback with the same spool participants.
          const releaseSettlementHolds = beginSpooledReplaySettlementHolds(
            ingressSpooledReplayParticipants,
          );
          try {
            await commitDispatchDedupeClaims(params.dispatchDedupeClaims ?? [], {
              requirePersistent: true,
            });
          } catch (error) {
            releaseSettlementHolds("replay-pending");
            throw error;
          }
          releaseSettlementHolds("discard-pending");
          dispatchDedupeCommitted = true;
        } else {
          releaseDispatchDedupeClaims(
            params.dispatchDedupeClaims ?? [],
            result.kind === "failed-retryable" ? result.error : undefined,
          );
        }
        spooledReplayFinalResult = finalized;
        settleSpooledReplayParticipants(spooledReplayParticipants, finalized);
        return finalized;
      })();
      spooledReplayFinalization = finalization;
      try {
        return await finalization;
      } finally {
        if (!spooledReplayFinalResult && spooledReplayFinalization === finalization) {
          spooledReplayFinalization = undefined;
        }
      }
    };
    try {
      // One assembled turn owns one config identity. Reloading below this point
      // can validate a model pin against a different allowlist than dispatch uses.
      const runtimeCfg = telegramDeps.getRuntimeConfig();
      const runtimeTelegramCfg = resolveTelegramAccount({ cfg: runtimeCfg, accountId }).config;
      const replyChainNodes = await buildReplyChainForMessage(params.msg);
      const isGroupConversation =
        params.msg.chat.type === "group" || params.msg.chat.type === "supergroup";
      const scopedThreadId = resolveTelegramMessageThreadSpec(params.msg).id;
      const { groupConfig, topicConfig } = resolveTelegramScopedGroupConfig(
        runtimeTelegramCfg,
        params.msg.chat.id,
        scopedThreadId,
      );
      const scopedAllowFrom = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
      const configuredGroupAllowFrom =
        scopedAllowFrom ??
        opts.groupAllowFrom ??
        runtimeTelegramCfg.groupAllowFrom ??
        runtimeTelegramCfg.allowFrom ??
        opts.allowFrom;
      const contextVisibilityMode = resolveChannelContextVisibilityMode({
        cfg: runtimeCfg,
        channel: "telegram",
        accountId,
      });
      const shouldHydrateReplyMedia = async (
        node: Pick<TelegramReplyChainEntry, "senderId" | "senderUsername">,
        index: number,
      ): Promise<boolean> => {
        if (!isGroupConversation) {
          return true;
        }
        const expandedAllowFrom = await expandTelegramAllowFromWithAccessGroups({
          cfg: runtimeCfg,
          allowFrom: configuredGroupAllowFrom,
          accountId,
          senderId: node.senderId,
        });
        const effectiveAllow = normalizeAllowFrom(expandedAllowFrom);
        const senderAllowed = effectiveAllow.hasEntries
          ? isSenderAllowed({
              allow: effectiveAllow,
              senderId: node.senderId,
              senderUsername: node.senderUsername,
            })
          : true;
        return evaluateSupplementalContextVisibility({
          mode: contextVisibilityMode,
          kind: index === 0 ? "quote" : "thread",
          senderAllowed,
        }).include;
      };
      const { replyMedia, replyChain } = await resolveReplyMediaForChain(
        params.ctx,
        replyChainNodes,
        shouldHydrateReplyMedia,
        durableMediaReplay,
        ...spooledReplayParticipants.map((participant) => participant.abortSignal),
        ...(params.spooledReplayAbortSignal ? [params.spooledReplayAbortSignal] : []),
      );
      const promptContextMediaByMessageId = new Map<string, TelegramMediaRef>();
      const currentMessageId =
        typeof params.msg.message_id === "number" ? String(params.msg.message_id) : undefined;
      for (const [index, media] of params.allMedia.entries()) {
        const messageId = media.sourceMessageId ?? (index === 0 ? currentMessageId : undefined);
        const promptMediaPath = media.path ? resolveTelegramPromptMediaPath(media.path) : undefined;
        if (messageId && promptMediaPath) {
          promptContextMediaByMessageId.set(messageId, {
            ...media,
            path: promptMediaPath,
          });
        }
      }
      for (const entry of replyChain) {
        const promptMediaPath = entry.mediaPath
          ? resolveTelegramPromptMediaPath(entry.mediaPath)
          : undefined;
        // Stored kinds are typed non-unknown; MIME inference fills gaps and
        // collapses an "unknown" inference to document for this deliverable-only surface.
        const inferredKind = kindFromMime(entry.mediaType);
        const mediaKind =
          entry.mediaKind ??
          (inferredKind && inferredKind !== "unknown" ? inferredKind : "document");
        if (entry.messageId && entry.mediaPath && promptMediaPath) {
          promptContextMediaByMessageId.set(entry.messageId, {
            path: promptMediaPath,
            kind: mediaKind,
            ...(entry.mediaType ? { contentType: entry.mediaType } : {}),
          });
        }
      }
      const promptContext = await buildPromptContextForMessage(
        params.ctx,
        params.msg,
        replyChainNodes,
        runtimeCfg,
        runtimeTelegramCfg,
        params.options,
        promptContextMediaByMessageId,
        params.promptContextMessageSelection,
      );
      const result = await processMessage({
        ctx: params.ctx,
        allMedia: params.allMedia,
        storeAllowFrom: params.storeAllowFrom,
        turnContext: {
          cfg: runtimeCfg,
          telegramCfg: runtimeTelegramCfg,
          onDispatchStart: async () => {
            await commitDispatchDedupeClaims(params.dispatchDedupeClaims ?? []);
            dispatchDedupeCommitted = true;
          },
          spooledReplayAbortSignal: params.spooledReplayAbortSignal,
          spooledReplayParticipant: processingParticipant,
          finalizeSpooledReplayResult: async (processingResult) =>
            await finalizeSpooledReplayResult(processingResult),
          completeSpooledReplayAfterIrrevocableAdoption: async () => {
            const completed = { kind: "completed" } satisfies TelegramMessageProcessingResult;
            return await finalizeSpooledReplayResult(completed);
          },
        },
        options: params.options,
        replyMedia,
        replyChain,
        promptContext,
      });
      if (spooledReplay) {
        return await finalizeSpooledReplayResult(result);
      }
      if (result.kind === "completed" && !dispatchDedupeCommitted) {
        await commitDispatchDedupeClaims(params.dispatchDedupeClaims ?? []);
      } else if (result.kind !== "completed" && !dispatchDedupeCommitted) {
        releaseDispatchDedupeClaims(params.dispatchDedupeClaims ?? []);
      }
      return result;
    } catch (err) {
      if (spooledReplay) {
        return await finalizeSpooledReplayResult(buildFailedProcessingResult(err));
      }
      if (!dispatchDedupeCommitted) {
        releaseDispatchDedupeClaims(params.dispatchDedupeClaims ?? [], err);
      }
      throw err;
    }
  };

  return {
    resolveMediaRuntime,
    mergeDispatchDedupeClaims,
    releaseDispatchDedupeClaims,
    buildFailedProcessingResult,
    settleSpooledReplayParticipants,
    createSpooledReplayParticipantForBufferedWork,
    spooledReplayOptions,
    claimMessageDispatchDedupe,
    resolveTelegramSessionState,
    resolvePromptContextAmbientWatermark,
    recordMessageForReplyChain,
    recordMessageResolvedMedia,
    resolveCachedMessageThreadSpec,
    processMessageWithReplyChain,
  };
}

export type TelegramMessagePipeline = ReturnType<typeof createTelegramMessagePipeline>;
