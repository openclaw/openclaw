import type { AnyChunk } from "@slack/types";
import type { LivePreviewDeliveryResult } from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyDispatchKind, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatSlackError } from "../../errors.js";
import { emitSlackMessageSentHooks } from "../../message-sent-hook.js";
import {
  prepareSlackReply,
  resolveSlackReplyBlocks,
  resolveSlackReplyRenderPlan,
} from "../../reply-blocks.js";
import {
  appendSlackStream,
  markSlackStreamFallbackDelivered,
  SlackStreamNotDeliveredError,
  startSlackStream,
  stopSlackStream,
  type SlackStreamSession,
} from "../../streaming.js";
import { resolveSlackReplyThreadTs } from "../../thread-ts.js";
import { countSlackTextUtf8Bytes } from "../../truncate.js";
import { deliverReplies } from "../replies.js";
import {
  createSlackEventDeliveryTracker,
  buildSlackEventDeliveryKey,
  resolveSlackStreamRecipientTeamId,
} from "./dispatch-helpers.js";
import type { SlackDispatchSetup } from "./dispatch-setup.js";

export function createSlackStreamingDeliveryRuntime(setup: SlackDispatchSetup) {
  const {
    account,
    ctx,
    forcedReplyThreadTs,
    isThreadReply,
    message,
    messageSentDeliveryHookContext,
    messageSentHookContext,
    messageSentHookTarget,
    prepared,
    replyDeliveryMode,
    replyPlan,
    runtime,
    slackClient,
    slackClientOptions,
    slackIdentity,
    slackMessageMetadata,
    slackStreamFallbackTeamId,
  } = setup;
  const state = {
    streamSession: null as SlackStreamSession | null,
    nativeProgressStreamStartPromise: null as Promise<SlackStreamSession | null> | null,
    nativeProgressStreamThreadTs: undefined as string | undefined,
    streamFailed: false,
    usedReplyThreadTs: undefined as string | undefined,
    usedBlockReplyThreadTs: undefined as string | undefined,
    observedReplyDelivery: false,
  };
  const startStream = async (
    params: Pick<
      Parameters<typeof startSlackStream>[0],
      "threadTs" | "text" | "chunks" | "taskDisplayMode"
    >,
  ) => {
    const session = await startSlackStream({
      client: slackClient,
      clientOptions: slackClientOptions,
      channel: message.channel,
      ...params,
      ...(slackIdentity ? { identity: slackIdentity } : {}),
      teamId: await resolveSlackStreamRecipientTeamId({
        client: slackClient,
        token: ctx.botToken,
        userId: message.user,
        fallbackTeamId: slackStreamFallbackTeamId,
      }),
      userId: message.user,
    });
    state.streamSession = session;
    return session;
  };
  const deliverPreparedReply = (
    reply: ReturnType<typeof prepareSlackReply>,
    replyThreadTs: string | undefined,
    deferMessageSentHooks = false,
  ) =>
    deliverReplies({
      cfg: ctx.cfg,
      replies: [reply],
      target: prepared.replyTarget,
      token: ctx.botToken,
      accountId: account.accountId,
      runtime,
      textLimit: ctx.textLimit,
      mediaMaxBytes: ctx.mediaMaxBytes,
      replyThreadTs,
      replyToMode: replyDeliveryMode,
      ...(slackIdentity ? { identity: slackIdentity } : {}),
      ...(slackMessageMetadata ? { metadata: slackMessageMetadata } : {}),
      ...messageSentDeliveryHookContext,
      ...(deferMessageSentHooks ? { deferMessageSentHooks: true } : {}),
      eventScope: prepared.eventScope,
    });
  const emitStreamedDelivery = (
    content: string,
    result: { success: boolean; messageId?: string; error?: string },
  ) => {
    emitSlackMessageSentHooks({
      ...messageSentHookContext,
      to: messageSentHookTarget,
      accountId: account.accountId,
      content,
      ...result,
    });
  };
  let deliveryTracker = createSlackEventDeliveryTracker();
  const markPreviewPayloadDelivered = (params: {
    kind: ReplyDispatchKind;
    payload: ReplyPayload;
    threadTs: string | undefined;
  }) => {
    const preparedReply = prepareSlackReply(params.payload);
    deliveryTracker.markDelivered(buildSlackEventDeliveryKey(params, preparedReply));
    // Single-use reply modes move later same-turn payloads off the preview
    // thread, so protect both delivery keys from duplicates.
    const nextThreadTs = replyPlan.peekThreadTs();
    if (nextThreadTs !== params.threadTs) {
      deliveryTracker.markDelivered(
        buildSlackEventDeliveryKey({ ...params, threadTs: nextThreadTs }, preparedReply),
      );
    }
  };
  const resolveDeliveryThreadTs = (params: {
    kind: ReplyDispatchKind;
    forcedThreadTs?: string;
  }): string | undefined => {
    const plannedThreadTs = params.forcedThreadTs ? undefined : replyPlan.nextThreadTs();
    return (
      params.forcedThreadTs ??
      plannedThreadTs ??
      (params.kind === "block" ? state.usedBlockReplyThreadTs : undefined)
    );
  };
  const rememberDeliveredThreadTs = (
    kind: ReplyDispatchKind,
    deliveredThreadTs: string | undefined,
  ) => {
    if (!deliveredThreadTs) {
      return;
    }
    state.usedReplyThreadTs ??= deliveredThreadTs;
    if (kind === "block") {
      state.usedBlockReplyThreadTs = deliveredThreadTs;
    }
  };
  const deliverPendingStreamFallback = async (
    session: SlackStreamSession,
    err: SlackStreamNotDeliveredError,
  ): Promise<LivePreviewDeliveryResult | undefined> => {
    if (session.stoppedBySlack) {
      return undefined;
    }
    let fallbackError = err;
    if (!session.stopped) {
      try {
        const stopResult = await stopSlackStream({
          session,
          ...(slackMessageMetadata ? { metadata: slackMessageMetadata } : {}),
        });
        if (session.stoppedBySlack) {
          return undefined;
        }
        state.observedReplyDelivery = true;
        state.usedReplyThreadTs ??= session.threadTs;
        return {
          visibleReplySent: session.delivered,
          ...(stopResult.messageId ? { messageIds: [stopResult.messageId] } : {}),
          threadId: session.threadTs,
        };
      } catch (stopErr) {
        if (stopErr instanceof SlackStreamNotDeliveredError) {
          fallbackError = stopErr;
        } else {
          throw stopErr;
        }
      }
    }
    // The SDK retains definitely rejected text. Use the normal chunked sender;
    // one chat.postMessage cannot carry a tail beyond Slack's text limit.
    const fallbackText = fallbackError.pendingText.trim();
    if (!fallbackText) {
      return undefined;
    }
    const sent = await deliverPreparedReply(
      prepareSlackReply({ text: fallbackText }),
      session.threadTs,
      true,
    );
    if (!sent?.receipt.platformMessageIds.length) {
      return undefined;
    }
    markSlackStreamFallbackDelivered(session);
    if (!session.stopped) {
      try {
        await stopSlackStream({
          session,
          ...(slackMessageMetadata ? { metadata: slackMessageMetadata } : {}),
        });
      } catch (finalizeErr) {
        runtime.error?.(
          danger(
            `slack-stream: failed to finalize native stream after fallback delivery: ${formatSlackError(finalizeErr)}`,
          ),
        );
      }
    }
    state.observedReplyDelivery = true;
    state.usedReplyThreadTs ??= session.threadTs;
    logVerbose(
      `slack-stream: streamed delivery failed (${fallbackError.slackCode}); delivered ${fallbackText.length} chars via deliverReplies fallback`,
    );
    return {
      visibleReplySent: true,
      messageIds: sent.receipt.platformMessageIds,
      receipt: sent.receipt,
      threadId: sent.threadTs ?? session.threadTs,
    };
  };

  const finishStream = async (chunks?: AnyChunk[]) => {
    const session = state.streamSession;
    if (session && !session.stopped) {
      try {
        try {
          await stopSlackStream({
            session,
            ...(chunks?.length ? { chunks } : {}),
            ...(slackMessageMetadata ? { metadata: slackMessageMetadata } : {}),
          });
          state.observedReplyDelivery ||= session.delivered;
        } catch (error) {
          if (!(error instanceof SlackStreamNotDeliveredError)) {
            throw error;
          }
          await deliverPendingStreamFallback(session, error);
        }
      } catch (error) {
        state.streamFailed = true;
        runtime.error?.(danger(`slack-stream: failed to stop stream: ${formatSlackError(error)}`));
      }
    }
  };

  const deliverNormally = async (params: {
    payload: ReplyPayload;
    kind: ReplyDispatchKind;
    forcedThreadTs?: string;
  }): Promise<LivePreviewDeliveryResult> => {
    if (state.streamSession?.stoppedBySlack) {
      return {
        visibleReplySent: false,
        suppression: { reason: "no_visible_result", cancelReason: "stopped by Slack user" },
      };
    }
    const replyThreadTs = resolveDeliveryThreadTs(params);
    const deliveryReplyThreadTs =
      replyDeliveryMode === "off" && !forcedReplyThreadTs && !isThreadReply
        ? undefined
        : replyThreadTs;
    const preparedReply = prepareSlackReply(params.payload);
    const deliveryKey = buildSlackEventDeliveryKey(
      {
        kind: params.kind,
        payload: params.payload,
        threadTs: deliveryReplyThreadTs,
      },
      preparedReply,
    );
    if (deliveryTracker.hasDelivered(deliveryKey)) {
      logVerbose("slack: suppressed duplicate normal delivery within the same turn");
      return { visibleReplySent: false, suppression: { reason: "channel_transform" } };
    }
    const sent = await deliverPreparedReply(preparedReply, deliveryReplyThreadTs);
    if (!sent?.receipt.platformMessageIds.length) {
      return { visibleReplySent: false };
    }
    state.observedReplyDelivery = true;
    const deliveredThreadTs = resolveSlackReplyThreadTs({
      replyToMode: replyDeliveryMode,
      replyToId: params.payload.replyToId,
      threadId: deliveryReplyThreadTs,
      replyToCurrent: params.payload.replyToCurrent,
    });
    // Record the thread ts only after confirmed delivery success.
    rememberDeliveredThreadTs(params.kind, deliveredThreadTs);
    replyPlan.markSent();
    deliveryTracker.markDelivered(deliveryKey);
    return {
      visibleReplySent: true,
      messageIds: sent.receipt.platformMessageIds,
      receipt: sent.receipt,
      threadId: sent.threadTs ?? deliveredThreadTs,
    };
  };

  const isStreamingEligible = (payload: ReplyPayload, options?: { maxTextBytes?: number }) => {
    const reply = resolveSendableOutboundReplyParts(payload);
    const renderPlan = resolveSlackReplyRenderPlan(payload);
    const plannedBlocks =
      renderPlan.mode === "single" ? renderPlan.blocks : renderPlan.blockPart?.blocks;
    return (
      !state.streamFailed &&
      !reply.hasMedia &&
      renderPlan.mode !== "split" &&
      !renderPlan.textIsSlackPlainText &&
      !plannedBlocks?.length &&
      !resolveSlackReplyBlocks(payload)?.length &&
      reply.hasText &&
      (!options?.maxTextBytes || countSlackTextUtf8Bytes(reply.trimmedText) <= options.maxTextBytes)
    );
  };

  const deliverWithStreaming = async (params: {
    payload: ReplyPayload;
    kind: ReplyDispatchKind;
    streamText?: string;
    appendSeparator?: boolean;
    taskDisplayMode?: "plan" | "timeline";
  }): Promise<LivePreviewDeliveryResult> => {
    if (state.streamSession?.stoppedBySlack) {
      return {
        visibleReplySent: false,
        suppression: { reason: "no_visible_result", cancelReason: "stopped by Slack user" },
      };
    }
    if (!isStreamingEligible(params.payload)) {
      return await deliverNormally({
        payload: params.payload,
        kind: params.kind,
        forcedThreadTs: state.streamSession?.threadTs ?? state.nativeProgressStreamThreadTs,
      });
    }
    if (!state.streamSession && state.nativeProgressStreamStartPromise) {
      await state.nativeProgressStreamStartPromise;
    }
    if (state.streamSession?.stoppedBySlack) {
      return {
        visibleReplySent: false,
        suppression: { reason: "no_visible_result", cancelReason: "stopped by Slack user" },
      };
    }
    let session = state.streamSession;
    const threadTs = session?.threadTs ?? replyPlan.nextThreadTs();
    if (state.streamFailed || !threadTs) {
      state.streamFailed = true;
      return await deliverNormally({
        payload: params.payload,
        kind: params.kind,
        forcedThreadTs: threadTs ?? state.nativeProgressStreamThreadTs,
      });
    }
    const hookContent = resolveSendableOutboundReplyParts(params.payload).trimmedText;
    const text = params.streamText ?? hookContent;
    const deliveryKey = buildSlackEventDeliveryKey({ ...params, threadTs, textOverride: text });
    if (deliveryTracker.hasDelivered(deliveryKey)) {
      logVerbose("slack-stream: suppressed duplicate reply payload");
      return { visibleReplySent: false, suppression: { reason: "channel_transform" } };
    }
    let messageId: string | undefined;
    let fallbackDelivery: LivePreviewDeliveryResult | undefined;
    try {
      // Each logical reply owns an acknowledged send. Empty chunks flush short
      // SDK buffers before core settles the reply, including queued fallbacks.
      if (session) {
        await appendSlackStream({
          session,
          text: `${params.appendSeparator === false ? "" : "\n"}${text}`,
          chunks: [],
        });
      } else {
        session = await startStream({
          threadTs,
          text,
          chunks: [],
          ...(params.taskDisplayMode ? { taskDisplayMode: params.taskDisplayMode } : {}),
        });
      }
      messageId = session.streamer.ts;
    } catch (error) {
      state.streamFailed = true;
      if (!(error instanceof SlackStreamNotDeliveredError)) {
        emitStreamedDelivery(hookContent, { success: false, error: formatErrorMessage(error) });
        throw error;
      }
      if (!session) {
        // Normal delivery owns the outcome of a definitely rejected start.
        return await deliverNormally({
          payload: params.payload,
          kind: params.kind,
          forcedThreadTs: threadTs,
        });
      }
      try {
        const fallback = await deliverPendingStreamFallback(session, error);
        if (!fallback && !session.stoppedBySlack) {
          throw error;
        }
        fallbackDelivery = fallback;
        // Chunked fallback has no single message ID for its logical hook.
        messageId = fallback?.receipt ? undefined : fallback?.messageIds?.[0];
      } catch (fallbackError) {
        emitStreamedDelivery(hookContent, {
          success: false,
          error: formatErrorMessage(fallbackError),
        });
        throw fallbackError;
      }
    }
    if (session.stoppedBySlack && session.pendingText) {
      emitStreamedDelivery(hookContent, { success: false, error: "Stopped by Slack user" });
      return {
        visibleReplySent: false,
        suppression: { reason: "no_visible_result", cancelReason: "stopped by Slack user" },
      };
    }
    if (!fallbackDelivery?.visibleReplySent && (!session.delivered || session.pendingText)) {
      return { visibleReplySent: false };
    }
    state.observedReplyDelivery = true;
    rememberDeliveredThreadTs(params.kind, threadTs);
    replyPlan.markSent();
    deliveryTracker.markDelivered(deliveryKey);
    emitStreamedDelivery(hookContent, { success: true, ...(messageId ? { messageId } : {}) });
    return (
      fallbackDelivery ?? {
        visibleReplySent: true,
        ...(messageId ? { messageIds: [messageId] } : {}),
        threadId: threadTs,
      }
    );
  };

  return Object.assign(state, {
    deliverNormally,
    deliverWithStreaming,
    finishStream,
    isStreamingEligible,
    markPreviewPayloadDelivered,
    rememberDeliveredThreadTs,
    startStream,
    resetDeliveryTracker: () => {
      deliveryTracker = createSlackEventDeliveryTracker();
    },
  });
}

export type SlackStreamingDeliveryRuntime = ReturnType<typeof createSlackStreamingDeliveryRuntime>;
