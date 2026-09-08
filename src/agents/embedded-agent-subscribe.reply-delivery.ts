import { randomUUID } from "node:crypto";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import {
  getReplyPayloadMetadata,
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
} from "../auto-reply/reply-payload.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import type { BlockReplyPayload } from "./embedded-agent-payloads.js";
import { runBestEffortCallback } from "./embedded-agent-subscribe.callback.js";
import {
  consumePendingAssistantReplyDirectivesIntoReply,
  consumePendingToolMediaIntoReply,
  hasAssistantVisibleReply,
  readPendingToolMediaReply,
  recordDeferredAssistantReplyDirectives,
  recordDeliveredAssistantReplyDirectives,
  recordDeliveredAutoMedia,
  restorePendingToolMediaReply,
} from "./embedded-agent-subscribe.handlers.messages.replies.js";
import type {
  AssistantStreamData,
  EmbeddedAgentSubscribeContext,
} from "./embedded-agent-subscribe.handlers.types.js";
import { emitInSettlementOrder } from "./embedded-agent-subscribe.reply-delivery.serial.js";
import { createAssistantTextAccumulator } from "./embedded-agent-subscribe.reply-text.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";
import type { AgentMessage } from "./runtime/index.js";

type AssistantStreamDelivery = {
  data: AssistantStreamData;
  eventData?: AssistantStreamData;
  emitPartialReply: boolean;
  finalMessage: boolean;
  blockIndex: number;
};

type AssistantStreamScope = {
  delivery?: AssistantStreamDelivery;
  active?: boolean;
  pending?: boolean;
  emitted?: boolean;
};

const isStreamAppend = ({ data, finalMessage }: AssistantStreamDelivery) =>
  !finalMessage && !data.replace && !data.mediaUrls?.length && !data.managedMediaUrls?.length;
const mergeStreamAppend = (previous: AssistantStreamData, next: AssistantStreamData) => ({
  ...next,
  delta: previous.delta + next.delta,
});

type ReplyDeliveryParams = {
  params: SubscribeEmbeddedAgentSessionParams;
  state: EmbeddedAgentSubscribeContext["state"];
  log: EmbeddedAgentSubscribeContext["log"];
};

export function createReplyDelivery({ params, state, log }: ReplyDeliveryParams) {
  const assistantTexts = state.assistantTexts;
  const {
    finalizeAssistantTexts,
    pushAssistantText,
    replaceCurrentAssistantText,
    shouldSkipAssistantText,
  } = createAssistantTextAccumulator({ params, state });
  const deferredAssistantScopes: AssistantStreamScope[] = [];
  const provisionalAssistantBlocks = new Set<number>();
  const lastEmittedCommentaryByItem = new Map<string, string>();
  const pendingBlockReplyTasks = new Map<Promise<void>, number>();
  const pendingPartialReplyTasks = new Set<Promise<void>>();
  let streamScope: AssistantStreamScope = {};
  const drainPartialReply = (scope: AssistantStreamScope) => {
    if (
      !scope.delivery ||
      !scope.pending ||
      state.unsubscribed ||
      (scope === streamScope && scope.active)
    ) {
      return;
    }
    const data = scope.delivery.data;
    scope.pending = false;
    // Reserve before invocation: callbacks may synchronously enqueue text or open another scope.
    scope.active = true;
    const settled = () => {
      if (scope === streamScope) {
        scope.active = false;
        drainPartialReply(scope);
      }
    };
    runBestEffortCallback({
      callback: () => params.onPartialReply?.(data),
      label: "assistant partial reply",
      log,
      pending: pendingPartialReplyTasks,
      onSuccess: settled,
      onError: settled,
    });
  };
  // Retry subscriptions reuse run IDs; scopes stay distinct across attempts.
  const streamId = randomUUID();
  let messageIndex = -1;
  let blockIndex = -1;
  let assistantItemId = "";
  let prefix = "";
  let streamedText = "";
  let finalized = false;
  const emitAssistantStreamDataSafely = (scope: AssistantStreamScope) => {
    if (!scope.delivery || scope.emitted || state.unsubscribed) {
      return;
    }
    const delivery = scope.delivery;
    const { eventData } = delivery;
    scope.emitted = true;
    scope.pending ||=
      delivery.emitPartialReply && Boolean(params.onPartialReply) && state.shouldEmitPartialReplies;
    const itemId = eventData?.itemId ?? "";
    const progressText =
      eventData?.phase === "commentary" ? eventData.text.replace(/\s+/g, " ").trim() : "";
    const preamblePhase = delivery.finalMessage ? "end" : "update";
    // Completion must survive an identical last delta: first-notification
    // consumers wait for this boundary, not a timer or a repeated text snapshot.
    const commentarySignature = `${preamblePhase}\0${progressText}`;
    const event = progressText
      ? {
          stream: "item" as const,
          data: {
            kind: "preamble",
            title: "Preamble",
            phase: preamblePhase,
            progressText,
            ...(itemId ? { itemId } : {}),
          },
        }
      : !eventData || eventData.phase === "commentary"
        ? undefined
        : { stream: "assistant" as const, data: eventData };
    if (
      event &&
      (event.stream !== "item" || lastEmittedCommentaryByItem.get(itemId) !== commentarySignature)
    ) {
      if (event.stream === "item") {
        lastEmittedCommentaryByItem.set(itemId, commentarySignature);
      }
      emitAgentEvent({ runId: params.runId, ...event });
      if (params.onAgentEvent) {
        runBestEffortCallback({
          label: "assistant agent event",
          log,
          callback: () => params.onAgentEvent?.(event),
        });
      }
    }
    drainPartialReply(scope);
  };
  const emitAssistantStreamData: EmbeddedAgentSubscribeContext["emitAssistantStreamData"] = (
    data,
    options,
  ) => {
    if (state.unsubscribed) {
      return;
    }
    let eventData: AssistantStreamData | undefined;
    if (data.phase === "commentary") {
      eventData = data;
    } else {
      if (messageIndex !== state.assistantMessageStartIndex) {
        messageIndex = state.assistantMessageStartIndex;
        blockIndex = state.assistantMessageIndex;
        assistantItemId = `${streamId}:${messageIndex}`;
        prefix = streamedText = "";
        finalized = false;
      }
      if (!finalized || options?.finalMessage) {
        if (blockIndex !== state.assistantMessageIndex) {
          prefix = streamedText;
          blockIndex = state.assistantMessageIndex;
        }
        const text = options?.finalMessage
          ? data.text
          : prefix && data.text
            ? `${prefix}\n${data.text}`
            : prefix || data.text;
        const replace = options?.finalMessage
          ? !text.startsWith(streamedText)
          : data.replace === true;
        const delta = options?.finalMessage
          ? replace
            ? ""
            : text.slice(streamedText.length)
          : prefix && streamedText.length === prefix.length && data.delta
            ? `\n${data.delta}`
            : data.delta;
        if (text !== streamedText || data.mediaUrls?.length || data.managedMediaUrls?.length) {
          eventData = {
            ...data,
            text,
            delta,
            replace: replace || undefined,
            itemId: assistantItemId,
          };
        }
        streamedText = text;
        finalized = options?.finalMessage === true;
      }
    }
    // Capture both coordinate domains before any callback can advance message state.
    const delivery = {
      data,
      eventData,
      emitPartialReply: options?.emitPartialReply === true,
      finalMessage: options?.finalMessage === true,
      blockIndex: state.assistantMessageIndex,
    };
    if (!eventData && !delivery.emitPartialReply) {
      return;
    }
    const previous = streamScope.delivery;
    const deferred = state.deferBlockReplyDelivery && data.phase !== "commentary";
    const coalesce =
      previous &&
      isStreamAppend(previous) &&
      isStreamAppend(delivery) &&
      previous.blockIndex === delivery.blockIndex &&
      previous.data.phase === data.phase &&
      previous.data.itemId === data.itemId &&
      previous.emitPartialReply === delivery.emitPartialReply &&
      Boolean(previous.eventData) === Boolean(eventData);
    const scope = coalesce ? streamScope : flushAssistantStream(delivery);
    if (coalesce) {
      // A reentrant boundary may append before this scope has emitted its first snapshot.
      if (!scope.emitted || scope.pending) {
        delivery.data = mergeStreamAppend(previous.data, data);
      }
      if (!scope.emitted && previous.eventData && eventData) {
        delivery.eventData = mergeStreamAppend(previous.eventData, eventData);
      }
      scope.delivery = delivery;
      scope.emitted = false;
    }
    if (!deferred) {
      emitAssistantStreamDataSafely(scope);
    }
  };
  const flushAssistantStream = (delivery?: AssistantStreamDelivery) => {
    // Publish the next scope before callbacks: a reentrant boundary can flush it exactly once.
    const previous = streamScope;
    const scope: AssistantStreamScope = { delivery };
    streamScope = scope;
    if (delivery && state.deferBlockReplyDelivery && delivery.data.phase !== "commentary") {
      deferredAssistantScopes.push(scope);
    }
    if (!state.deferBlockReplyDelivery) {
      for (const deferred of deferredAssistantScopes.splice(0)) {
        emitAssistantStreamDataSafely(deferred);
        deferred.delivery = undefined;
      }
    }
    if (!state.deferBlockReplyDelivery || previous.delivery?.data.phase === "commentary") {
      emitAssistantStreamDataSafely(previous);
      drainPartialReply(previous);
      previous.delivery = undefined;
    }
    return scope;
  };
  const clearAssistantStream = () => {
    streamScope.delivery = undefined;
    streamScope = {};
    deferredAssistantScopes.length = 0;
    provisionalAssistantBlocks.clear();
  };
  const noteLastAssistant = (msg: AgentMessage, options?: { hasToolResults: boolean }) => {
    if (msg.role !== "assistant") {
      return;
    }
    state.lastAssistant = msg;
    if (
      state.deferBlockReplyDelivery &&
      (msg.stopReason === "toolUse" || options?.hasToolResults)
    ) {
      // Async tools can leave a normal-stop tail after their tool-use fragment.
      // The response's tool results, not its text phase, establish continuation.
      for (
        let index = state.assistantMessageStartIndex;
        index <= state.assistantMessageIndex;
        index++
      ) {
        provisionalAssistantBlocks.add(index);
      }
    }
  };
  const deferredToolMediaReplies = new WeakMap<
    BlockReplyPayload,
    { pendingToolMedia: BlockReplyPayload; autoDeliveryMediaUrls: string[] }
  >();
  const deferredBlockReplyCallbacks = new WeakMap<BlockReplyPayload, () => void>();
  const failedBlockReplies: Array<{
    payload: BlockReplyPayload;
    options?: {
      assistantMessageIndex?: number;
      pendingToolMedia?: BlockReplyPayload | null;
      autoDeliveryMediaUrls?: string[];
    };
    onDelivered?: () => void;
    deliveryGeneration: number;
    deliveryKey: string;
    deliverySequence: number;
  }> = [];
  const exhaustedBlockReplyKeys = new Set<string>();
  let blockReplyDeliveryGeneration = 0;
  let blockReplyDeliverySequence = 0;
  let resolveBlockReplyDeliveryInvalidation: () => void = () => {};
  let blockReplyDeliveryInvalidation = new Promise<void>((resolve) => {
    resolveBlockReplyDeliveryInvalidation = resolve;
  });
  const blockReplyDeliveryKey = (
    payload: BlockReplyPayload,
    options?: { assistantMessageIndex?: number },
  ) =>
    JSON.stringify([
      options?.assistantMessageIndex,
      payload.text ?? "",
      payload.mediaUrls ?? [],
      payload.audioAsVoice === true,
      payload.replyToId ?? "",
      payload.replyToTag === true,
      payload.replyToCurrent === true,
      payload.isReasoning === true,
    ]);
  const emitBlockReplySafely = (
    payload: Parameters<NonNullable<SubscribeEmbeddedAgentSessionParams["onBlockReply"]>>[0],
    options?: {
      assistantMessageIndex?: number;
      pendingToolMedia?: BlockReplyPayload | null;
      autoDeliveryMediaUrls?: string[];
    },
    onDelivered?: () => void,
    retrying = false,
    deliveryGeneration = blockReplyDeliveryGeneration,
    deliveryKey = blockReplyDeliveryKey(payload, options),
    deliverySequence = blockReplyDeliverySequence++,
  ): boolean => {
    if (!params.onBlockReply) {
      return false;
    }
    if (deliveryGeneration !== blockReplyDeliveryGeneration) {
      return false;
    }
    if (!retrying && exhaustedBlockReplyKeys.has(deliveryKey)) {
      log.warn("block reply callback retry already exhausted");
      return false;
    }
    const recordDeliveryFailure = () => {
      if (options?.pendingToolMedia) {
        restorePendingToolMediaReply(state, options.pendingToolMedia);
      }
    };
    try {
      const taggedPayload =
        options?.assistantMessageIndex !== undefined
          ? setReplyPayloadMetadata(payload, {
              assistantMessageIndex: options.assistantMessageIndex,
            })
          : payload;
      const assistantMessageIndex =
        options?.assistantMessageIndex ??
        getReplyPayloadMetadata(taggedPayload)?.assistantMessageIndex;
      const context = assistantMessageIndex === undefined ? undefined : { assistantMessageIndex };
      const maybeTask = context
        ? params.onBlockReply(taggedPayload, context)
        : params.onBlockReply(taggedPayload);
      if (!isPromiseLike<void>(maybeTask)) {
        if (deliveryGeneration === blockReplyDeliveryGeneration) {
          exhaustedBlockReplyKeys.delete(deliveryKey);
          onDelivered?.();
        }
        return true;
      }
      const task = Promise.resolve(maybeTask).then(
        () => {
          if (deliveryGeneration === blockReplyDeliveryGeneration) {
            exhaustedBlockReplyKeys.delete(deliveryKey);
            onDelivered?.();
          }
        },
        () => {
          recordDeliveryFailure();
          if (deliveryGeneration !== blockReplyDeliveryGeneration) {
            return;
          }
          if (options?.pendingToolMedia) {
            return;
          }
          if (!retrying) {
            failedBlockReplies.push({
              payload,
              options,
              onDelivered,
              deliveryGeneration,
              deliveryKey,
              deliverySequence,
            });
          } else {
            exhaustedBlockReplyKeys.add(deliveryKey);
          }
        },
      );
      pendingBlockReplyTasks.set(task, deliveryGeneration);
      void task.finally(() => {
        pendingBlockReplyTasks.delete(task);
      });
      return true;
    } catch {
      recordDeliveryFailure();
      if (deliveryGeneration !== blockReplyDeliveryGeneration) {
        return false;
      }
      if (options?.pendingToolMedia) {
        return false;
      }
      if (!retrying) {
        failedBlockReplies.push({
          payload,
          options,
          onDelivered,
          deliveryGeneration,
          deliveryKey,
          deliverySequence,
        });
      } else {
        exhaustedBlockReplyKeys.add(deliveryKey);
      }
      return false;
    }
  };
  const resolveAutoDeliveryMediaUrls = (pendingToolMedia: BlockReplyPayload | null) => {
    if (params.sourceReplyDeliveryMode !== "message_tool_only") {
      return [];
    }
    const sent = new Set(state.messagingToolSentMediaUrls.map((url) => url.trim()));
    return (pendingToolMedia?.mediaUrls ?? []).filter(
      (url) => state.toolAutoDeliveryMediaUrls.has(url.trim()) && !sent.has(url.trim()),
    );
  };
  const recordVisibleBlockReply = (
    payload: BlockReplyPayload,
    pendingToolMedia?: BlockReplyPayload | null,
    autoDeliveryMediaUrls?: string[],
  ) => {
    if (payload.isReasoning || !hasAssistantVisibleReply(payload)) {
      return;
    }
    recordDeliveredAssistantReplyDirectives(state, payload);
    state.visibleBlockReplyCount += 1;
    if (pendingToolMedia) {
      state.pendingToolMediaDeliveryFailed = false;
      state.hasToolMediaBlockReply = true;
    }
    recordDeliveredAutoMedia(state, autoDeliveryMediaUrls);
  };
  const emitBlockReply = (
    payload: BlockReplyPayload,
    options?: {
      assistantMessageIndex?: number;
      consumePendingToolMedia?: boolean;
      onDelivered?: () => void;
    },
  ) => {
    flushAssistantStream();
    const withAssistantDirectives = consumePendingAssistantReplyDirectivesIntoReply(state, payload);
    const pendingToolMedia =
      payload.isReasoning || options?.consumePendingToolMedia === false
        ? null
        : readPendingToolMediaReply(state);
    const withToolMedia =
      options?.consumePendingToolMedia === false
        ? withAssistantDirectives
        : consumePendingToolMediaIntoReply(state, withAssistantDirectives);
    const autoDeliveryMediaUrls = resolveAutoDeliveryMediaUrls(pendingToolMedia);
    const pendingAttachments = new Map(
      (pendingToolMedia?.mediaUrls ?? []).map((url, index) => [
        url.trim(),
        pendingToolMedia?.attachments?.[index] ?? {},
      ]),
    );
    const blockPayload: BlockReplyPayload =
      autoDeliveryMediaUrls.length === 0
        ? withToolMedia
        : markReplyPayloadForSourceSuppressionDelivery({
            mediaUrls: autoDeliveryMediaUrls,
            mediaUrl: autoDeliveryMediaUrls[0],
            attachments: autoDeliveryMediaUrls.map(
              (url) => pendingAttachments.get(url.trim()) ?? {},
            ),
            audioAsVoice: pendingToolMedia?.audioAsVoice || undefined,
            trustedLocalMedia: true,
          });
    const assistantTranscriptMediaUrls = Array.from(new Set(payload.mediaUrls ?? []));
    const taggedPayload =
      options?.assistantMessageIndex !== undefined
        ? setReplyPayloadMetadata(blockPayload, {
            assistantMessageIndex: options.assistantMessageIndex,
            ...(assistantTranscriptMediaUrls.length > 0 ? { assistantTranscriptMediaUrls } : {}),
          })
        : blockPayload;
    if (state.deferBlockReplyDelivery) {
      if (pendingToolMedia) {
        deferredToolMediaReplies.set(taggedPayload, {
          pendingToolMedia,
          autoDeliveryMediaUrls,
        });
      }
      if (!taggedPayload.isReasoning) {
        recordDeferredAssistantReplyDirectives(state, taggedPayload);
        if (taggedPayload.text) {
          state.deferredBlockReplyTexts.push(taggedPayload.text);
        }
      }
      if (options?.onDelivered) {
        deferredBlockReplyCallbacks.set(taggedPayload, options.onDelivered);
      }
      state.deferredBlockReplies.push(taggedPayload);
      return;
    }
    emitBlockReplySafely(
      taggedPayload,
      { ...options, pendingToolMedia, autoDeliveryMediaUrls },
      () => {
        recordVisibleBlockReply(taggedPayload, pendingToolMedia, autoDeliveryMediaUrls);
        options?.onDelivered?.();
      },
    );
  };
  const releaseDeferredReplies = (): void | Promise<void> => {
    // Later answers supersede deferred tool-turn text, not media or reasoning.
    const messageStartIndex = state.assistantMessageStartIndex;
    const isSuperseded = (index: number | undefined) =>
      index !== undefined && index < messageStartIndex && provisionalAssistantBlocks.has(index);
    for (const scope of deferredAssistantScopes) {
      const delivery = scope.delivery;
      if (delivery && isSuperseded(delivery.blockIndex)) {
        if (!delivery.data.mediaUrls?.length) {
          scope.delivery = undefined;
        } else {
          delivery.data = { ...delivery.data, text: "", delta: "" };
          if (delivery.eventData) {
            delivery.eventData = { ...delivery.eventData, text: "", delta: "" };
          }
        }
      }
    }
    const replies = state.deferredBlockReplies.splice(0);
    for (const payload of replies) {
      const index = getReplyPayloadMetadata(payload)?.assistantMessageIndex;
      if (!payload.isReasoning && isSuperseded(index)) {
        payload.text = undefined;
      }
    }
    provisionalAssistantBlocks.clear();
    state.deferBlockReplyDelivery = false;
    flushAssistantStream();
    const released = emitInSettlementOrder({
      items: replies.filter((payload) => hasAssistantVisibleReply(payload)),
      settle: () => settleBlockReplyDeliveries(),
      emit: (payload) => {
        const onDelivered = deferredBlockReplyCallbacks.get(payload);
        const toolMedia = deferredToolMediaReplies.get(payload);
        if (toolMedia?.pendingToolMedia) {
          emitBlockReplySafely(payload, toolMedia, () => {
            recordVisibleBlockReply(
              payload,
              toolMedia.pendingToolMedia,
              toolMedia.autoDeliveryMediaUrls,
            );
            onDelivered?.();
          });
          return;
        }
        emitBlockReply(payload, { onDelivered });
      },
    });
    state.deferredAssistantReplyDirectives = undefined;
    state.deferredBlockReplyTexts = [];
    return released;
  };
  const clearDeferredBlockReplies = () => {
    state.deferredBlockReplies.length = 0;
    state.deferredAssistantReplyDirectives = undefined;
    state.deferredBlockReplyTexts = [];
  };

  // Retry generation/invalidation lives here with emitBlockReplySafely.
  const currentPendingBlockReplyTasks = () =>
    Array.from(pendingBlockReplyTasks)
      .filter(([, generation]) => generation === blockReplyDeliveryGeneration)
      .map(([task]) => task);
  const waitForPendingBlockReplies = (): Promise<void> =>
    (async () => {
      const deliveryGeneration = blockReplyDeliveryGeneration;
      const deliveryInvalidation = blockReplyDeliveryInvalidation;
      let pending = currentPendingBlockReplyTasks();
      while (pending.length > 0) {
        if (deliveryGeneration !== blockReplyDeliveryGeneration) {
          return;
        }
        await Promise.race([
          Promise.allSettled(pending).then(() => undefined),
          deliveryInvalidation,
        ]);
        if (deliveryGeneration !== blockReplyDeliveryGeneration) {
          if (!params.blockReplyChunking && params.onBlockReplyFlush) {
            await Promise.allSettled(pending);
            if (params.blockReplyBreak === "message_end") {
              await params.onBlockReplyFlush({ reason: "message_end" });
            }
          }
          return;
        }
        pending = currentPendingBlockReplyTasks();
      }
    })();
  const settleBlockReplyDeliveries = (options?: {
    retryFailures?: boolean;
  }): void | Promise<void> => {
    if (currentPendingBlockReplyTasks().length > 0) {
      return waitForPendingBlockReplies().then(() => settleBlockReplyDeliveries(options));
    }
    if (!options?.retryFailures || failedBlockReplies.length === 0) {
      return;
    }
    const failed = failedBlockReplies
      .splice(0)
      .toSorted((left, right) => left.deliverySequence - right.deliverySequence);
    for (const entry of failed) {
      emitBlockReplySafely(
        entry.payload,
        entry.options,
        entry.onDelivered,
        true,
        entry.deliveryGeneration,
        entry.deliveryKey,
        entry.deliverySequence,
      );
    }
    if (currentPendingBlockReplyTasks().length > 0 || failedBlockReplies.length > 0) {
      return settleBlockReplyDeliveries(options);
    }
  };
  const invalidateBlockReplyDeliveries = () => {
    blockReplyDeliveryGeneration += 1;
    resolveBlockReplyDeliveryInvalidation();
    blockReplyDeliveryInvalidation = new Promise<void>((resolve) => {
      resolveBlockReplyDeliveryInvalidation = resolve;
    });
    for (const [task, generation] of pendingBlockReplyTasks) {
      if (generation !== blockReplyDeliveryGeneration) {
        pendingBlockReplyTasks.delete(task);
      }
    }
  };
  const getBlockReplyDeliveryGeneration = () => blockReplyDeliveryGeneration;
  const resetBlockReplyFailures = () => {
    failedBlockReplies.length = 0;
    exhaustedBlockReplyKeys.clear();
  };
  const waitForPendingEvents = async (options?: { includePartialReplies?: boolean }) => {
    // Terminal settlement must observe callbacks launched while events drain.
    const includePartialReplies = options?.includePartialReplies !== false;
    while (true) {
      const eventChain = state.pendingEventChain;
      const partialReplyTasks = includePartialReplies ? [...pendingPartialReplyTasks] : [];
      if (!eventChain && partialReplyTasks.length === 0) {
        return;
      }
      await Promise.allSettled([...(eventChain ? [eventChain] : []), ...partialReplyTasks]);
    }
  };
  return {
    assistantTexts,
    clearAssistantStream,
    clearDeferredBlockReplies,
    currentPendingBlockReplyTasks,
    emitAssistantStreamData,
    emitBlockReply,
    finalizeAssistantTexts,
    flushAssistantStream,
    noteLastAssistant,
    releaseDeferredReplies,
    getBlockReplyDeliveryGeneration,
    invalidateBlockReplyDeliveries,
    pendingBlockReplyTasks,
    pushAssistantText,
    replaceCurrentAssistantText,
    resetBlockReplyFailures,
    settleBlockReplyDeliveries,
    shouldSkipAssistantText,
    waitForPendingBlockReplies,
    waitForPendingEvents,
  };
}
