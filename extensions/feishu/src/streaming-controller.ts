import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import type { MentionTarget } from "./mention.js";
import { buildMentionedCardContent, buildMentionedMessage } from "./mention.js";
import {
  closeStreamingModeFeishu,
  createCardEntityFeishu,
  deleteMessageFeishu,
  editMessageFeishu,
  sendCardByCardIdFeishu,
  sendMarkdownCardFeishu,
  sendMessageFeishu,
  updateCardElementContentFeishu,
  updateCardSummaryFeishu,
} from "./send.js";

const STREAM_THROTTLE_MS = 500;
const STREAM_UPDATE_MAX_RETRIES = 3;
const STREAM_SEQUENCE_MAX_RETRIES = 8;

type StreamingBackend = "none" | "cardkit" | "raw" | "stopped";

function isRetryableStreamError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate") ||
    msg.includes("too many") ||
    msg.includes("timeout") ||
    msg.includes("temporar") ||
    msg.includes("econn") ||
    msg.includes("etimedout") ||
    msg.includes("enotfound") ||
    msg.includes("5xx")
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export type FeishuStreamingControllerParams = {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  accountId?: string;
  accountLabel: string;
  chatId: string;
  replyToMessageId?: string;
  mentionTargets?: MentionTarget[];
  streamRenderMode: "card" | "raw";
  trueStreamingEnabled: boolean;
  blockStreamingEnabled: boolean;
  thinkingCardEnabled: boolean;
  summarize: (text: string) => string;
};

export function createFeishuStreamingController(params: FeishuStreamingControllerParams) {
  const {
    cfg,
    runtime,
    accountId,
    accountLabel,
    chatId,
    replyToMessageId,
    mentionTargets,
    streamRenderMode,
    trueStreamingEnabled,
    blockStreamingEnabled,
    thinkingCardEnabled,
    summarize,
  } = params;

  // Block streaming state.
  let streamingCardId: string | null = null;
  let accumulatedCardText = "";

  // True streaming state.
  let streamBackend: StreamingBackend = "none";
  let streamCardKitId: string | null = null;
  let streamMessageId: string | null = null;
  let streamSequence = 0;
  let streamLastSentText = "";
  let streamPendingText = "";
  let streamInFlight = false;
  let streamTimer: ReturnType<typeof setTimeout> | null = null;
  let streamFinalText: string | null = null;
  let streamPartialCount = 0;
  let streamFlushCount = 0;
  let streamUpdateCount = 0;
  let streamEverUpdated = false;
  let streamClosing = false;
  let streamClosed = false;
  let streamClosePromise: Promise<void> | null = null;
  let cardKitOpQueue: Promise<void> = Promise.resolve();
  let lastPartialQueued = "";

  const isSequenceCompareFailedError = (err: unknown): boolean =>
    /sequence\s+number\s+compare\s+failed/i.test(String(err));

  const enqueueCardKitOp = <T>(op: () => Promise<T>): Promise<T> => {
    const run = cardKitOpQueue.then(op, op);
    cardKitOpQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const runCardKitMutation = async (
    label: string,
    mutation: (sequence: number) => Promise<void>,
    options?: { markClosed?: boolean; maxRetries?: number },
  ): Promise<void> => {
    await enqueueCardKitOp(async () => {
      if (streamBackend !== "cardkit" || !streamCardKitId) {
        return;
      }
      if (streamClosed && !options?.markClosed) {
        return;
      }

      const maxRetries = options?.maxRetries ?? STREAM_SEQUENCE_MAX_RETRIES;
      let lastError: unknown;

      for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        const nextSequence = streamSequence + 1;
        try {
          await mutation(nextSequence);
          streamSequence = nextSequence;
          if (options?.markClosed) {
            streamClosed = true;
          }
          return;
        } catch (err) {
          lastError = err;
          const sequenceError = isSequenceCompareFailedError(err);
          const retryable = sequenceError || isRetryableStreamError(err);
          runtime.log?.(
            `feishu[${accountLabel}] ${label} failed (cardId=${streamCardKitId}, sequence=${nextSequence}, attempt=${attempt}, retryable=${retryable}, sequenceError=${sequenceError}): ${String(err)}`,
          );
          if (!retryable || attempt >= maxRetries) {
            throw err;
          }
          if (sequenceError) {
            streamSequence = nextSequence;
          }
          await sleep(100 * attempt);
        }
      }

      throw lastError ?? new Error(`${label} failed without details`);
    });
  };

  const applyMentions = (text: string): string => {
    if (!mentionTargets || mentionTargets.length === 0) {
      return text;
    }
    return streamRenderMode === "card"
      ? buildMentionedCardContent(mentionTargets, text)
      : buildMentionedMessage(mentionTargets, text);
  };

  const updateCardElementWithRetry = async (cardId: string, content: string): Promise<void> => {
    await runCardKitMutation("stream element update", async (sequence) => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= STREAM_UPDATE_MAX_RETRIES; attempt += 1) {
        try {
          await updateCardElementContentFeishu({
            cfg,
            cardId,
            content,
            sequence,
            accountId,
          });
          return;
        } catch (err) {
          lastError = err;
          const retryable = isRetryableStreamError(err) && !isSequenceCompareFailedError(err);
          if (!retryable || attempt >= STREAM_UPDATE_MAX_RETRIES) {
            throw err;
          }
          await sleep(250 * attempt);
        }
      }
      throw lastError ?? new Error("Feishu stream update failed without details");
    });
  };

  const sendOrUpdateStreamMessage = async (text: string): Promise<boolean> => {
    if (!text || text === streamLastSentText) {
      return true;
    }

    try {
      if (streamRenderMode === "card") {
        if (streamClosing || streamClosed) {
          return true;
        }
        if (streamBackend === "cardkit" && streamCardKitId) {
          await updateCardElementWithRetry(streamCardKitId, applyMentions(text));
          streamUpdateCount += 1;
          streamEverUpdated = true;
        } else if (streamBackend === "none") {
          try {
            const entity = await createCardEntityFeishu({
              cfg,
              initialContent: applyMentions(text),
              accountId,
            });

            const result = await sendCardByCardIdFeishu({
              cfg,
              to: chatId,
              cardId: entity.cardId,
              replyToMessageId,
              accountId,
            });

            streamCardKitId = entity.cardId;
            streamMessageId = result.messageId;
            streamBackend = "cardkit";
            streamSequence = 0;
            runtime.log?.(
              `feishu[${accountLabel}] CardKit stream initialized (method=cardkit.cardElement.content): cardId=${entity.cardId}, msgId=${result.messageId}`,
            );
          } catch (cardKitErr) {
            runtime.log?.(
              `feishu[${accountLabel}] CardKit stream init failed (create-or-bind), streaming unavailable: ${String(cardKitErr)}`,
            );
            streamBackend = "stopped";
          }
        }
      } else if (streamBackend === "raw" && streamMessageId) {
        await editMessageFeishu({
          cfg,
          messageId: streamMessageId,
          text: applyMentions(text),
          accountId,
        });
        streamUpdateCount += 1;
        streamEverUpdated = true;
      } else if (streamBackend === "none") {
        const result = await sendMessageFeishu({
          cfg,
          to: chatId,
          text,
          replyToMessageId,
          mentions: mentionTargets,
          accountId,
        });
        streamMessageId = result.messageId;
        streamBackend = "raw";
        runtime.log?.(`feishu[${accountLabel}] raw stream initialized`);
      }

      streamLastSentText = text;
      return true;
    } catch (err) {
      runtime.log?.(`feishu[${accountLabel}] streaming update failed: ${String(err)}`);
      streamBackend = "stopped";
      return false;
    }
  };

  const flushStream = async (): Promise<void> => {
    if (streamTimer) {
      clearTimeout(streamTimer);
      streamTimer = null;
    }
    if (streamInFlight) {
      return;
    }

    const text = streamPendingText;
    streamPendingText = "";
    if (!text) {
      return;
    }

    streamFlushCount += 1;
    streamInFlight = true;
    try {
      await sendOrUpdateStreamMessage(text);
    } finally {
      streamInFlight = false;
      if (streamPendingText && !streamTimer) {
        streamTimer = setTimeout(() => {
          void flushStream();
        }, STREAM_THROTTLE_MS);
      }
    }
  };

  const waitForStreamIdle = async (): Promise<void> => {
    while (streamInFlight) {
      await sleep(50);
    }
    if (streamTimer) {
      clearTimeout(streamTimer);
      streamTimer = null;
      await flushStream();
    }
  };

  const closeStreamingIfNeeded = async (): Promise<void> => {
    if (streamBackend !== "cardkit" || !streamCardKitId) {
      return;
    }
    if (streamClosed) {
      return;
    }
    if (streamClosePromise) {
      await streamClosePromise;
      return;
    }

    streamClosing = true;
    const cardId = streamCardKitId;
    streamClosePromise = (async () => {
      await waitForStreamIdle();
      await runCardKitMutation(
        "close streaming mode",
        async (sequence) => {
          await closeStreamingModeFeishu({
            cfg,
            cardId,
            sequence,
            accountId,
          });
        },
        { markClosed: true },
      );
    })();

    try {
      await streamClosePromise;
    } catch (err) {
      runtime.log?.(`feishu[${accountLabel}] close streaming mode failed: ${String(err)}`);
    } finally {
      if (!streamClosed) {
        streamClosing = false;
      }
      streamClosePromise = null;
    }
  };

  const clearPendingThinkingCard = async (): Promise<void> => {
    if (!streamCardKitId || streamEverUpdated) {
      return;
    }
    const cardId = streamCardKitId;
    runtime.log?.(`feishu[${accountLabel}] cleaning up orphan thinking card: cardId=${cardId}`);
    try {
      await runCardKitMutation(
        "orphan thinking card clear",
        async (sequence) => {
          await updateCardElementContentFeishu({
            cfg,
            cardId,
            content: " ",
            sequence,
            accountId,
          });
        },
        { maxRetries: 5 },
      );
      runtime.log?.(`feishu[${accountLabel}] orphan thinking card cleared`);
      return;
    } catch {
      // Fallback to recall below.
    }

    if (!streamMessageId) {
      runtime.log?.(
        `feishu[${accountLabel}] orphan thinking cleanup failed: no messageId for recall`,
      );
      return;
    }

    runtime.log?.(
      `feishu[${accountLabel}] orphan thinking card update failed, recalling message: msgId=${streamMessageId}`,
    );
    try {
      await deleteMessageFeishu({ cfg, messageId: streamMessageId, accountId });
      runtime.log?.(`feishu[${accountLabel}] orphan thinking card message recalled successfully`);
    } catch (recallErr) {
      runtime.log?.(
        `feishu[${accountLabel}] orphan thinking card recall failed: ${String(recallErr)}`,
      );
    }
  };

  const ensureThinkingCardIfNeeded = async (): Promise<void> => {
    if (!thinkingCardEnabled) {
      return;
    }
    if (!trueStreamingEnabled || streamRenderMode !== "card" || streamBackend !== "none") {
      return;
    }
    if (!replyToMessageId) {
      return;
    }
    try {
      const entity = await createCardEntityFeishu({
        cfg,
        initialContent: "⏳ Thinking ...",
        accountId,
      });
      const result = await sendCardByCardIdFeishu({
        cfg,
        to: chatId,
        cardId: entity.cardId,
        replyToMessageId,
        accountId,
      });
      streamCardKitId = entity.cardId;
      streamMessageId = result.messageId;
      streamBackend = "cardkit";
      streamSequence = 0;
      runtime.log?.(
        `feishu[${accountLabel}] eager thinking card: cardId=${entity.cardId}, msgId=${result.messageId}`,
      );
    } catch (err) {
      runtime.log?.(
        `feishu[${accountLabel}] eager thinking card failed (will retry on first partial): ${String(err)}`,
      );
    }
  };

  const queuePartialReply = (text: string): void => {
    if (!trueStreamingEnabled || !text) {
      return;
    }
    if (text === lastPartialQueued) {
      return;
    }
    lastPartialQueued = text;
    if (streamBackend === "stopped" || streamClosing || streamClosed) {
      return;
    }
    streamPartialCount += 1;
    streamPendingText = text;
    if (!streamTimer) {
      streamTimer = setTimeout(() => {
        void flushStream();
      }, STREAM_THROTTLE_MS);
    }
  };

  const tryDeliverFinalStream = async (
    text: string,
  ): Promise<{ handled: boolean; messageId?: string; msgType?: "post" | "interactive" }> => {
    streamFinalText = text;
    if (!trueStreamingEnabled || !text) {
      return { handled: false };
    }

    await waitForStreamIdle();
    if (streamBackend === "stopped" || !streamMessageId) {
      runtime.log?.(
        `feishu[${accountLabel}] deliver: streaming unavailable/failed (backend=${streamBackend}, partials=${streamPartialCount}, flushes=${streamFlushCount}, updates=${streamUpdateCount}), sending final message`,
      );
      return { handled: false };
    }

    runtime.log?.(
      `feishu[${accountLabel}] final stream delivery via ${streamRenderMode === "card" ? "cardkit.cardElement.content" : "im.message.update"}: backend=${streamBackend}, partials=${streamPartialCount}, flushes=${streamFlushCount}, updates=${streamUpdateCount}`,
    );

    const streamSuccess = await sendOrUpdateStreamMessage(text);
    if (!streamSuccess) {
      return { handled: false };
    }

    if (streamRenderMode === "card" && streamCardKitId) {
      const cardId = streamCardKitId;
      const summary = summarize(text);
      try {
        await runCardKitMutation("summary update", async (sequence) => {
          await updateCardSummaryFeishu({
            cfg,
            cardId,
            summaryText: summary,
            content: applyMentions(text),
            sequence,
            accountId,
          });
        });
      } catch (err) {
        runtime.log?.(`feishu[${accountLabel}] summary update skipped: ${String(err)}`);
      }
    }

    await closeStreamingIfNeeded();
    runtime.log?.(
      `feishu[${accountLabel}] streaming status: used=${streamEverUpdated}, backend=${streamBackend}, partials=${streamPartialCount}, flushes=${streamFlushCount}, updates=${streamUpdateCount}`,
    );

    return {
      handled: true,
      messageId: streamMessageId ?? undefined,
      msgType: streamRenderMode === "card" ? "interactive" : "post",
    };
  };

  const tryDeliverBlock = async (
    text: string,
  ): Promise<{ handled: boolean; messageId?: string }> => {
    if (!blockStreamingEnabled || streamBackend === "stopped") {
      return { handled: false };
    }

    if (streamingCardId) {
      accumulatedCardText += "\n\n" + text;
      runtime.log?.(`feishu[${accountLabel}] deliver: updating streaming card ${streamingCardId}`);
      if (streamBackend === "cardkit" && streamCardKitId) {
        try {
          await updateCardElementWithRetry(streamCardKitId, accumulatedCardText);
        } catch (err) {
          runtime.log?.(`feishu[${accountLabel}] deliver: CardKit update failed: ${String(err)}`);
          streamBackend = "stopped";
        }
      }
      return { handled: true };
    }

    accumulatedCardText = text;
    runtime.log?.(`feishu[${accountLabel}] deliver: creating streaming card in ${chatId}`);
    try {
      const entity = await createCardEntityFeishu({
        cfg,
        initialContent: applyMentions(text),
        accountId,
      });

      const result = await sendCardByCardIdFeishu({
        cfg,
        to: chatId,
        cardId: entity.cardId,
        replyToMessageId,
        accountId,
      });

      streamingCardId = result.messageId;
      streamCardKitId = entity.cardId;
      streamBackend = "cardkit";
      streamSequence = 0;
      return { handled: true, messageId: result.messageId };
    } catch (cardKitErr) {
      runtime.log?.(
        `feishu[${accountLabel}] deliver: CardKit create failed: ${String(cardKitErr)}`,
      );
      streamBackend = "stopped";
      const result = await sendMarkdownCardFeishu({
        cfg,
        to: chatId,
        text,
        replyToMessageId,
        mentions: mentionTargets,
        accountId,
      });
      return { handled: true, messageId: result.messageId };
    }
  };

  return {
    trueStreamingEnabled,
    blockStreamingEnabled,
    streamRenderMode,
    queuePartialReply,
    ensureThinkingCardIfNeeded,
    tryDeliverFinalStream,
    tryDeliverBlock,
    clearPendingThinkingCard,
    closeStreamingIfNeeded,
    getReplyDisableBlockStreamingFlag: () => (trueStreamingEnabled ? true : undefined),
  };
}
