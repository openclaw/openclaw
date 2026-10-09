import type { AnyChunk } from "@slack/types";
import type { LivePreviewDeliveryResult } from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyDispatchKind, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { trackSlackDraftMessage } from "../../draft-message-boundaries.js";
import { formatSlackError } from "../../errors.js";
import { SLACK_EDIT_TEXT_MAX_BYTES } from "../../limits.js";
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
  buildSlackEventDeliveryKey,
  resolveSlackStreamRecipientTeamId,
} from "./dispatch-helpers.js";
import type { SlackDispatchSetup } from "./dispatch-setup.js";

export function createSlackStreamingDeliveryRuntime(setup: SlackDispatchSetup) {
  const {
    isThreadReply,
    messageSentHookContext,
    messageSentHookTarget,
    prepared,
    replyDeliveryMode,
    replyPlan,
    runtime,
    slackClient,
    slackClientOptions,
    slackIdentity,
    slackStreamFallbackTeamId,
  } = setup;
  const { account, ctx, forcedReplyThreadTs, message, slackMessageMetadata } = prepared;
  const boundaryState: {
    streamBoundary: ReturnType<typeof trackSlackDraftMessage> | null;
    interruptedThreadTs: string | undefined;
  } = { streamBoundary: null, interruptedThreadTs: undefined };
  const state = {
    streamSession: null as SlackStreamSession | null,
    ...boundaryState,
    streamInterrupted: false,
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
    const boundary = trackSlackDraftMessage({
      accountId: account.accountId,
      teamId: prepared.eventScope?.teamId,
      channelId: message.channel,
      // Ingress records the conversation from the inbound message, while
      // params.threadTs is only the outbound delivery target.
      threadTs: message.thread_ts,
      onInterveningMessage: () => {
        state.streamInterrupted = true;
      },
    });
    state.streamBoundary = boundary;
    try {
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
      state.interruptedThreadTs = undefined;
      if (session.streamer.ts) {
        boundary.setMessageTs(session.streamer.ts);
      }
      return session;
    } catch (error) {
      boundary.stop();
      if (state.streamBoundary === boundary) {
        state.streamBoundary = null;
      }
      throw error;
    }
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
      ...messageSentHookContext,
      messageSentHookTarget,
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
  const deliveredKeys = new Set<string>();
  const markDelivered = (key: string | null) => {
    if (key) {
      deliveredKeys.add(key);
    }
  };
  const markPreviewPayloadDelivered = (params: {
    kind: ReplyDispatchKind;
    payload: ReplyPayload;
    threadTs: string | undefined;
  }) => {
    const preparedReply = prepareSlackReply(params.payload);
    markDelivered(buildSlackEventDeliveryKey(params, preparedReply));
    // Single-use reply modes move later same-turn payloads off the preview
    // thread, so protect both delivery keys from duplicates.
    const nextThreadTs = replyPlan.peekThreadTs();
    if (nextThreadTs !== params.threadTs) {
      markDelivered(
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
    state.streamBoundary?.stop();
    state.streamBoundary = null;
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

  const rotateInterruptedStream = async (): Promise<string | undefined> => {
    if (!state.streamInterrupted) {
      return undefined;
    }
    // A human can arrive before Slack returns the first message timestamp.
    // Wait for that receipt so the old stream can be sealed before replacement.
    await state.nativeProgressStreamStartPromise?.catch(() => null);
    if (!state.streamInterrupted) {
      return undefined;
    }
    state.streamInterrupted = false;
    if (state.streamSession?.stoppedBySlack) {
      // A native Stop belongs to the turn, not just the old message identity.
      // Retain the stopped session so all late progress and finals stay suppressed.
      state.streamBoundary?.stop();
      state.streamBoundary = null;
      return undefined;
    }
    const threadTs = state.streamSession?.threadTs ?? state.nativeProgressStreamThreadTs;
    // Finalize the visible pre-boundary message exactly once before any later
    // output is admitted to a fresh Slack message in the same thread.
    await finishStream();
    if (state.streamSession?.stoppedBySlack) {
      // Slack can Stop the stream while the sealing request is in flight.
      // Keep that turn-level cancellation visible to all later delivery paths.
      return undefined;
    }
    state.streamSession = null;
    state.interruptedThreadTs = threadTs;
    return threadTs;
  };

  const deliverNormally = async (params: {
    payload: ReplyPayload;
    kind: ReplyDispatchKind;
    forcedThreadTs?: string;
  }): Promise<LivePreviewDeliveryResult> => {
    if (state.streamSession?.stoppedBySlack) {
      return { visibleReplySent: false };
    }
    await rotateInterruptedStream();
    if (state.streamSession?.stoppedBySlack) {
      return { visibleReplySent: false };
    }
    const replyThreadTs =
      params.forcedThreadTs ?? state.interruptedThreadTs ?? resolveDeliveryThreadTs(params);
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
    if (deliveryKey && deliveredKeys.has(deliveryKey)) {
      logVerbose("slack: suppressed duplicate normal delivery within the same turn");
      return { visibleReplySent: false };
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
    markDelivered(deliveryKey);
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
      return { visibleReplySent: false };
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
    await rotateInterruptedStream();
    if (state.streamSession?.stoppedBySlack) {
      return { visibleReplySent: false };
    }
    let session = state.streamSession;
    const threadTs = session?.threadTs ?? state.interruptedThreadTs ?? replyPlan.nextThreadTs();
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
    if (deliveryKey && deliveredKeys.has(deliveryKey)) {
      logVerbose("slack-stream: suppressed duplicate reply payload");
      return { visibleReplySent: false };
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
      return { visibleReplySent: false };
    }
    if (!fallbackDelivery?.visibleReplySent && (!session.delivered || session.pendingText)) {
      return { visibleReplySent: false };
    }
    state.observedReplyDelivery = true;
    rememberDeliveredThreadTs(params.kind, threadTs);
    replyPlan.markSent();
    markDelivered(deliveryKey);
    emitStreamedDelivery(hookContent, { success: true, ...(messageId ? { messageId } : {}) });
    return (
      fallbackDelivery ?? {
        visibleReplySent: true,
        ...(messageId ? { messageIds: [messageId] } : {}),
        threadId: threadTs,
      }
    );
  };

  const nativeFinalThreadTs = () =>
    state.streamSession?.threadTs ??
    state.interruptedThreadTs ??
    state.nativeProgressStreamThreadTs;
  const canFinishNativeFinal = (payload: ReplyPayload, streamReady: boolean) =>
    payload.isError !== true &&
    streamReady &&
    Boolean(state.streamSession || state.interruptedThreadTs) &&
    isStreamingEligible(payload, { maxTextBytes: SLACK_EDIT_TEXT_MAX_BYTES });

  return Object.assign(state, {
    canFinishNativeFinal,
    deliverNormally,
    deliverWithStreaming,
    finishStream,
    isStreamingEligible,
    markPreviewPayloadDelivered,
    nativeFinalThreadTs,
    rememberDeliveredThreadTs,
    rotateInterruptedStream,
    startStream,
    resetDeliveryTracker: () => deliveredKeys.clear(),
  });
}

export type SlackStreamingDeliveryRuntime = ReturnType<typeof createSlackStreamingDeliveryRuntime>;
