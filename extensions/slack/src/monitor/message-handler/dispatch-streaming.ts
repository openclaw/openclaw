import type { AnyChunk } from "@slack/types";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyDispatchKind, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { danger, logVerbose, warn } from "openclaw/plugin-sdk/runtime-env";
import { formatSlackError } from "../../errors.js";
import { emitSlackMessageSentHooks } from "../../message-sent-hook.js";
import { prepareSlackReply, resolveSlackReplyRenderPlan } from "../../reply-blocks.js";
import { SlackStreamMessageLedger } from "../../stream-size.js";
import {
  appendSlackStream,
  markSlackStreamFallbackDelivered,
  SlackStreamMessageTooLongError,
  SlackStreamNotDeliveredError,
  startSlackStream,
  stopSlackStream,
  type SlackStreamSession,
} from "../../streaming.js";
import { resolveSlackReplyThreadTs } from "../../thread-ts.js";
import { countSlackTextUtf8Bytes } from "../../truncate.js";
import { deliverReplies, readSlackReplyBlocks } from "../replies.js";
import {
  createSlackEventDeliveryTracker,
  buildSlackEventDeliveryKey,
  resolveSlackStreamRecipientTeamId,
  type SlackEventDeliveryAttempt,
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
    // Content on the current stream message; replaced whenever a stream starts.
    streamLedger: new SlackStreamMessageLedger(),
    nativeProgressStreamStartPromise: null as Promise<SlackStreamSession | null> | null,
    nativeProgressStreamThreadTs: undefined as string | undefined,
    streamFailed: false,
    // Slack's Stop cancelled a message of this turn. It outlives that session:
    // the chain must not open a continuation or write the answer after it.
    stoppedBySlack: false,
    usedReplyThreadTs: undefined as string | undefined,
    usedBlockReplyThreadTs: undefined as string | undefined,
    observedReplyDelivery: false,
    observedFinalReplyDelivery: false,
  };
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
  const isStoppedBySlack = (): boolean =>
    state.stoppedBySlack || state.streamSession?.stoppedBySlack === true;
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
  ): Promise<{ messageId?: string } | undefined> => {
    if (session.stoppedBySlack) {
      return undefined;
    }
    let fallbackError = err;
    // A finalize would flush the rejected text again and fail the same way;
    // after `msg_too_long` go straight to the normal reply path.
    if (!session.stopped && !(err instanceof SlackStreamMessageTooLongError)) {
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
        return stopResult;
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
    await deliverReplies({
      cfg: ctx.cfg,
      replies: [prepareSlackReply({ text: fallbackText })],
      target: prepared.replyTarget,
      token: ctx.botToken,
      accountId: account.accountId,
      runtime,
      textLimit: ctx.textLimit,
      mediaMaxBytes: ctx.mediaMaxBytes,
      replyThreadTs: session.threadTs,
      replyToMode: replyDeliveryMode,
      ...(slackIdentity ? { identity: slackIdentity } : {}),
      ...(slackMessageMetadata ? { metadata: slackMessageMetadata } : {}),
      ...messageSentDeliveryHookContext,
      deferMessageSentHooks: true,
      eventScope: prepared.eventScope,
    });
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
    // Chunked fallback has no single message ID for this reply payload.
    return {};
  };

  /**
   * Stops the current stream message, with the closeout chunks when given.
   * `chunksRejected` reports a closeout Slack refused with msg_too_long: the
   * message was stopped without it, and the caller still owns that content
   * (a rollover carries it to the continuation instead of recording it sent).
   */
  const finishStream = async (chunks?: AnyChunk[]): Promise<{ chunksRejected: boolean }> => {
    const session = state.streamSession;
    let chunksRejected = false;
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
          if (error instanceof SlackStreamMessageTooLongError && chunks?.length) {
            // The closeout chunks pushed the message over Slack's size. Finalize
            // without them so the message leaves streaming state.
            runtime.log?.(
              warn(
                "slack-stream: Slack rejected the closeout chunks with msg_too_long; stopping the stream without them",
              ),
            );
            chunksRejected = true;
            markSlackStreamFallbackDelivered(session);
            await stopSlackStream({
              session,
              ...(slackMessageMetadata ? { metadata: slackMessageMetadata } : {}),
            });
            state.observedReplyDelivery ||= session.delivered;
          } else if (error instanceof SlackStreamNotDeliveredError) {
            await deliverPendingStreamFallback(session, error);
          } else {
            throw error;
          }
        }
      } catch (error) {
        state.streamFailed = true;
        runtime.error?.(danger(`slack-stream: failed to stop stream: ${formatSlackError(error)}`));
      }
      // A Stop admitted while the stop request was in flight lands on the
      // session; remember it before the chain forgets this message.
      if (session.stoppedBySlack) {
        state.stoppedBySlack = true;
      }
    }
    return { chunksRejected };
  };

  const deliverNormally = async (params: {
    payload: ReplyPayload;
    kind: ReplyDispatchKind;
    forcedThreadTs?: string;
  }): Promise<string | undefined> => {
    if (isStoppedBySlack()) {
      return undefined;
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
      return deliveryReplyThreadTs;
    }
    await deliverReplies({
      cfg: ctx.cfg,
      replies: [preparedReply],
      target: prepared.replyTarget,
      token: ctx.botToken,
      accountId: account.accountId,
      runtime,
      textLimit: ctx.textLimit,
      mediaMaxBytes: ctx.mediaMaxBytes,
      replyThreadTs: deliveryReplyThreadTs,
      replyToMode: replyDeliveryMode,
      ...(slackIdentity ? { identity: slackIdentity } : {}),
      ...(slackMessageMetadata ? { metadata: slackMessageMetadata } : {}),
      ...messageSentDeliveryHookContext,
      eventScope: prepared.eventScope,
    });
    state.observedReplyDelivery = true;
    if (params.kind === "final") {
      state.observedFinalReplyDelivery = true;
    }
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
    return deliveryReplyThreadTs;
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
      !readSlackReplyBlocks(payload)?.length &&
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
    /** Thread of a stream chain to continue when no session is open. */
    forcedThreadTs?: string;
    /**
     * Slack answered `msg_too_long` for this text. Return true after finishing
     * the rejected message (and opening a continuation, or leaving no session
     * so the retry starts one); the text is then sent once more.
     */
    onMessageTooLong?: (session: SlackStreamSession) => Promise<boolean>;
  }): Promise<void> => {
    if (isStoppedBySlack()) {
      return;
    }
    if (!isStreamingEligible(params.payload)) {
      await deliverNormally({
        payload: params.payload,
        kind: params.kind,
        forcedThreadTs: state.streamSession?.threadTs ?? state.nativeProgressStreamThreadTs,
      });
      return;
    }
    if (!state.streamSession && state.nativeProgressStreamStartPromise) {
      await state.nativeProgressStreamStartPromise;
    }
    if (isStoppedBySlack()) {
      return;
    }
    let session = state.streamSession;
    const threadTs = session?.threadTs ?? params.forcedThreadTs ?? replyPlan.nextThreadTs();
    if (state.streamFailed || !threadTs) {
      state.streamFailed = true;
      await deliverNormally({
        payload: params.payload,
        kind: params.kind,
        forcedThreadTs: threadTs ?? state.nativeProgressStreamThreadTs,
      });
      return;
    }
    const hookContent = resolveSendableOutboundReplyParts(params.payload).trimmedText;
    const text = params.streamText ?? hookContent;
    const deliveryKey = buildSlackEventDeliveryKey({ ...params, threadTs, textOverride: text });
    if (deliveryTracker.hasDelivered(deliveryKey)) {
      logVerbose("slack-stream: suppressed duplicate reply payload");
      return;
    }
    let messageId: string | undefined;
    const sendText = async () => {
      // Each logical reply owns an acknowledged send. Empty chunks flush short
      // SDK buffers before core settles the reply, including queued fallbacks.
      if (session) {
        const streamText = `${params.appendSeparator === false ? "" : "\n"}${text}`;
        state.streamLedger.record({ text: streamText });
        await appendSlackStream({ session, text: streamText, chunks: [] });
      } else {
        session = await startSlackStream({
          client: slackClient,
          clientOptions: slackClientOptions,
          channel: message.channel,
          threadTs,
          text,
          chunks: [],
          ...(params.taskDisplayMode ? { taskDisplayMode: params.taskDisplayMode } : {}),
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
        beginStreamLedger().record({ text });
      }
      messageId = session.streamer.ts;
    };
    try {
      try {
        await sendText();
      } catch (error) {
        // Slack sized the message, not this text: let the caller finish that
        // message, then send the same text once more on the next one.
        if (
          !(error instanceof SlackStreamMessageTooLongError) ||
          !params.onMessageTooLong ||
          !session ||
          !(await params.onMessageTooLong(session))
        ) {
          throw error;
        }
        session = state.streamSession;
        await sendText();
      }
    } catch (error) {
      state.streamFailed = true;
      if (!(error instanceof SlackStreamNotDeliveredError)) {
        emitStreamedDelivery(hookContent, { success: false, error: formatErrorMessage(error) });
        throw error;
      }
      if (!session) {
        // Normal delivery owns the outcome of a definitely rejected start.
        await deliverNormally({
          payload: params.payload,
          kind: params.kind,
          forcedThreadTs: threadTs,
        });
        return;
      }
      try {
        const fallback = await deliverPendingStreamFallback(session, error);
        if (!fallback && !session.stoppedBySlack) {
          throw error;
        }
        messageId = fallback?.messageId;
      } catch (fallbackError) {
        emitStreamedDelivery(hookContent, {
          success: false,
          error: formatErrorMessage(fallbackError),
        });
        throw fallbackError;
      }
    }
    // SAFETY: sendText assigned the session it used; a rejected start returned above.
    const streamed = session as SlackStreamSession | null;
    if (streamed?.stoppedBySlack && streamed.pendingText) {
      emitStreamedDelivery(hookContent, { success: false, error: "Stopped by Slack user" });
      return;
    }
    state.observedReplyDelivery = true;
    if (params.kind === "final") {
      state.observedFinalReplyDelivery = true;
    }
    rememberDeliveredThreadTs(params.kind, threadTs);
    replyPlan.markSent();
    deliveryTracker.markDelivered(deliveryKey);
    emitStreamedDelivery(hookContent, { success: true, ...(messageId ? { messageId } : {}) });
  };

  const beginStreamLedger = () => {
    state.streamLedger = new SlackStreamMessageLedger();
    return state.streamLedger;
  };

  return Object.assign(state, {
    beginStreamLedger,
    deliverNormally,
    deliverWithStreaming,
    finishStream,
    hasDelivered: (params: SlackEventDeliveryAttempt) =>
      deliveryTracker.hasDelivered(buildSlackEventDeliveryKey(params)),
    isStoppedBySlack,
    isStreamingEligible,
    markPreviewPayloadDelivered,
    rememberDeliveredThreadTs,
    resetDeliveryTracker: () => {
      deliveryTracker = createSlackEventDeliveryTracker();
    },
  });
}

export type SlackStreamingDeliveryRuntime = ReturnType<typeof createSlackStreamingDeliveryRuntime>;
