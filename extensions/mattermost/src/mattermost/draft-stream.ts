import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createFinalizableDraftLifecycle } from "openclaw/plugin-sdk/channel-outbound";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { chunkMarkdownTextWithMode } from "openclaw/plugin-sdk/reply-chunking";
import { truncateWithMarker } from "openclaw/plugin-sdk/string-normalization-runtime";
import {
  createMattermostPost,
  deleteMattermostPost,
  fetchMattermostChannelPosts,
  updateMattermostPost,
  type MattermostClient,
} from "./client.js";

const MATTERMOST_STREAM_MAX_CHARS = 4000;
const THROTTLE_MS = 1200;

type MattermostDraftPublishedPart = {
  messageId: string;
  content: string;
};

export function createMattermostDraftStream(params: {
  client: MattermostClient;
  channelId: string;
  rootId?: string;
  chunkText?: (text: string) => string[];
  log?: (message: string) => void;
  warn?: (message: string) => void;
}) {
  const streamState = { stopped: false, final: false };
  let terminalAcceptedDeliveryError: Error | undefined;
  const retainAcceptedDeliveryFailure = (err: unknown) => {
    if (isChannelPartialDeliveryError(err)) {
      // Publish terminal state before warning hooks can re-enter delivery.
      const acceptedDeliveryError = toErrorObject(err, "Mattermost accepted delivery failed");
      streamState.stopped = true;
      terminalAcceptedDeliveryError = acceptedDeliveryError;
      return acceptedDeliveryError;
    }
    return undefined;
  };
  const assertNoAcceptedDeliveryFailure = () => {
    if (terminalAcceptedDeliveryError !== undefined) {
      throw terminalAcceptedDeliveryError;
    }
  };
  type DraftGeneration = {
    postId?: string;
    lastSentText: string;
    lastProviderText?: string;
    // A boundary can arrive after pending text flushed. Keep the full source so sealing can
    // replace the ellipsized preview with lossless chunks instead of retaining truncation.
    latestSourceText: string;
    latestAssistantText?: string;
    ready: Promise<void>;
  };
  let currentGeneration: DraftGeneration = {
    lastSentText: "",
    latestSourceText: "",
    ready: Promise.resolve(),
  };
  const sealedAssistantTexts: Array<{ text: string; requiresBlockBoundary: boolean }> = [];
  const publishedAssistantParts = new Map<string, MattermostDraftPublishedPart>();

  const sendOrEditStreamMessage = async (text: string): Promise<boolean> => {
    const target = currentGeneration;
    const trimmed = text.trim();
    const normalized = trimmed
      ? truncateWithMarker(trimmed, MATTERMOST_STREAM_MAX_CHARS, {
          marker: "...",
          reserve: 3,
          trimEnd: true,
        })
      : "";
    if (!normalized) {
      return false;
    }
    await target.ready;
    if (streamState.stopped && !streamState.final) {
      return false;
    }
    if (normalized === target.lastSentText) {
      return true;
    }
    try {
      if (target.postId) {
        const updated = await updateMattermostPost(params.client, target.postId, {
          message: normalized,
        });
        target.lastProviderText = updated.message ?? normalized;
      } else {
        const sent = await createMattermostPost(params.client, {
          channelId: params.channelId,
          message: normalized,
          rootId: params.rootId,
        });
        target.postId = sent.id;
        target.lastProviderText = sent.message ?? normalized;
      }
      target.lastSentText = normalized;
      return true;
    } catch (err) {
      // Stop immediately so a discarded background failure cannot queue a second visible post.
      streamState.stopped = true;
      const acceptedDeliveryError = retainAcceptedDeliveryFailure(err);
      params.warn?.(
        `mattermost stream preview failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (acceptedDeliveryError) {
        throw acceptedDeliveryError;
      }
      return false;
    }
  };

  const {
    loop,
    update: updateLifecycle,
    stop: stopLifecycle,
    stopForClear,
    clearWithStop,
    seal: sealLifecycle,
  } = createFinalizableDraftLifecycle({
    throttleMs: THROTTLE_MS,
    coalesceInFlight: true,
    state: streamState,
    sendOrEditStreamMessage,
    readMessageId: () => currentGeneration.postId,
    clearMessageId: () => {
      currentGeneration.postId = undefined;
    },
    isValidMessageId: (value: unknown): value is string =>
      typeof value === "string" && value.length > 0,
    deleteMessage: (postId) => deleteMattermostPost(params.client, postId),
    warn: params.warn,
    warnPrefix: "mattermost stream preview cleanup failed",
  });

  const forceNewMessage = () => {
    if (terminalAcceptedDeliveryError !== undefined) {
      return Promise.reject(terminalAcceptedDeliveryError);
    }
    if (streamState.stopped || streamState.final) {
      return Promise.resolve();
    }
    // Agent boundary callbacks are fire-and-forget. Swap generations synchronously; the new
    // generation waits for the old send and seal so posts stay in publication order.
    const pendingText = loop.takePending();
    const inFlightAtBoundary = loop.waitForInFlight();
    const sealed = currentGeneration;
    const assistantText = sealed.latestAssistantText?.trim();
    let publishedAssistantOffset = 0;
    const recordPublishedAssistantPart = (messageId: string, content: string, offset: number) => {
      if (!assistantText) {
        return;
      }
      publishedAssistantParts.set(messageId, { messageId, content });
      const chunk = content.trim();
      let nextOffset = offset;
      if (chunk) {
        while (nextOffset < assistantText.length && /\s/.test(assistantText[nextOffset] ?? "")) {
          nextOffset += 1;
        }
      }
      publishedAssistantOffset =
        !chunk || assistantText.startsWith(chunk, nextOffset) ? nextOffset + chunk.length : offset;
    };
    const boundary = (async () => {
      try {
        await sealed.ready;
        assertNoAcceptedDeliveryFailure();
        await inFlightAtBoundary;
        assertNoAcceptedDeliveryFailure();
        if (streamState.stopped && !streamState.final) {
          return;
        }
        const sourceText = pendingText.trim() ? pendingText : sealed.latestSourceText;
        const finalizedText = sourceText.trim();
        const chunks =
          params.chunkText?.(finalizedText) ??
          chunkMarkdownTextWithMode(finalizedText, MATTERMOST_STREAM_MAX_CHARS, "length");
        const firstChunk = chunks[0];
        if (!firstChunk) {
          return;
        }
        if (sealed.postId) {
          if (assistantText && (sealed.lastProviderText || sealed.lastSentText)) {
            const publishedContent = sealed.lastProviderText ?? sealed.lastSentText;
            // The existing preview remains visible if its lossless boundary edit fails.
            recordPublishedAssistantPart(sealed.postId, publishedContent, 0);
          }
          let providerFirstChunk = sealed.lastProviderText ?? firstChunk;
          if (firstChunk !== sealed.lastSentText) {
            const updated = await updateMattermostPost(params.client, sealed.postId, {
              message: firstChunk,
            });
            providerFirstChunk = updated.message ?? firstChunk;
          }
          recordPublishedAssistantPart(sealed.postId, providerFirstChunk, 0);
        } else {
          const firstPost = await createMattermostPost(params.client, {
            channelId: params.channelId,
            message: firstChunk,
            rootId: params.rootId,
          });
          recordPublishedAssistantPart(firstPost.id, firstPost.message ?? firstChunk, 0);
        }
        for (const chunk of chunks.slice(1)) {
          const post = await createMattermostPost(params.client, {
            channelId: params.channelId,
            message: chunk,
            rootId: params.rootId,
          });
          recordPublishedAssistantPart(post.id, post.message ?? chunk, publishedAssistantOffset);
        }
        if (assistantText) {
          sealedAssistantTexts.push({ text: assistantText, requiresBlockBoundary: true });
        }
      } catch (err) {
        const acceptedDeliveryError = retainAcceptedDeliveryFailure(err);
        const publishedAssistantPrefix = assistantText?.slice(0, publishedAssistantOffset).trim();
        if (publishedAssistantPrefix) {
          // A later physical chunk failed after this exact source prefix became durable.
          // Strip only that proven prefix; unlike a completed block, its suffix is inline.
          sealedAssistantTexts.push({
            text: publishedAssistantPrefix,
            requiresBlockBoundary: false,
          });
        }
        params.warn?.(
          `mattermost stream preview boundary flush failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (acceptedDeliveryError) {
          throw acceptedDeliveryError;
        }
      }
    })();
    currentGeneration = {
      lastSentText: "",
      latestSourceText: "",
      ready: boundary,
    };
    loop.resetThrottleWindow();
    return boundary;
  };

  const settleOperation = (operation: () => Promise<void>) => async () => {
    assertNoAcceptedDeliveryFailure();
    await operation();
    await currentGeneration.ready;
    assertNoAcceptedDeliveryFailure();
  };
  const discardPending = settleOperation(stopForClear);
  const clear = async () => {
    assertNoAcceptedDeliveryFailure();
    await clearWithStop(discardPending);
    assertNoAcceptedDeliveryFailure();
  };
  const deleteCurrentMessage = async () => {
    assertNoAcceptedDeliveryFailure();
    const retiring = currentGeneration;
    loop.resetPending();
    const inFlight = loop.waitForInFlight();
    const retirement = clearWithStop(
      async () => {
        await retiring.ready;
        await inFlight;
        assertNoAcceptedDeliveryFailure();
      },
      {
        readMessageId: () => retiring.postId,
        clearMessageId: () => {
          retiring.postId = undefined;
        },
      },
    );
    // Claim retirement before yielding; replacement sends wait without reusing the deleted post.
    currentGeneration = { lastSentText: "", latestSourceText: "", ready: retirement };
    loop.resetThrottleWindow();
    await retirement;
    assertNoAcceptedDeliveryFailure();
  };
  const update = (text: string) => {
    currentGeneration.latestSourceText = text;
    currentGeneration.latestAssistantText = undefined;
    updateLifecycle(text);
  };
  const updateAssistantText = (text: string) => {
    currentGeneration.latestSourceText = text;
    currentGeneration.latestAssistantText = text;
    updateLifecycle(text);
  };
  const settleBoundaries = async () => {
    assertNoAcceptedDeliveryFailure();
    await currentGeneration.ready;
    assertNoAcceptedDeliveryFailure();
  };
  const resolveFinalText = (text: string) => {
    const publishedParts: readonly MattermostDraftPublishedPart[] = [
      ...publishedAssistantParts.values(),
    ];
    if (sealedAssistantTexts.length === 0) {
      return { kind: "full" as const, text, publishedParts };
    }

    let remainingText = text.trim();
    for (const sealedText of sealedAssistantTexts) {
      const completed = sealedText.text;
      if (!remainingText.startsWith(completed)) {
        return { kind: "full" as const, text, publishedParts };
      }
      const suffix = remainingText.slice(completed.length);
      // Canonical assistant block aggregation uses newline separators. A plain-space
      // suffix can be a block-local final that merely shares the prior block's prefix.
      if (sealedText.requiresBlockBoundary && suffix && !/^\r?\n/.test(suffix)) {
        return { kind: "full" as const, text, publishedParts };
      }
      remainingText = suffix.replace(sealedText.requiresBlockBoundary ? /^(?:\r?\n)+/ : /^\s+/, "");
    }
    const currentText = currentGeneration.latestAssistantText?.trim() ?? "";
    const remaining = remainingText.trim();
    if (currentText && !remaining.startsWith(currentText)) {
      return { kind: "full" as const, text, publishedParts };
    }
    return remaining
      ? { kind: "remaining" as const, text: remaining, publishedParts }
      : { kind: "already-delivered" as const, publishedParts };
  };

  // Generations publish in order, so the current preview is this draft's newest post: anything
  // after it came from someone else (message tool, a person, another bot). Without collapsed
  // threads every reply renders in the channel stream, so root-level previews check the whole
  // channel. Accepted gap: 200+ newer channel posts outside a threaded preview's thread.
  const findPostAfter = async (postId: string): Promise<string | undefined> => {
    const { messages } = await fetchMattermostChannelPosts(params.client, params.channelId, {
      after: postId,
      limit: 200,
      skipFetchThreads: true,
    });
    return messages.find(
      (post) =>
        !post.type?.startsWith("system_") && (!params.rootId || post.root_id === params.rootId),
    )?.id;
  };

  params.log?.(
    `mattermost stream preview ready (maxChars=${MATTERMOST_STREAM_MAX_CHARS}, throttleMs=${THROTTLE_MS})`,
  );

  return {
    update,
    updateAssistantText,
    flush: settleOperation(loop.flush),
    postId: () => currentGeneration.postId,
    clear,
    deleteCurrentMessage,
    discardPending,
    seal: settleOperation(sealLifecycle),
    stop: settleOperation(stopLifecycle),
    forceNewMessage,
    settleBoundaries,
    resolveFinalText,
    findPostAfter,
  };
}
