import {
  createReplyPrefixContext,
  createTypingCallbacks,
  logTypingFailure,
  type OpenClawConfig,
  type RuntimeEnv,
  type ReplyPayload,
} from "openclaw/plugin-sdk";
import type { MentionTarget } from "./mention.js";
import { resolveFeishuAccount } from "./accounts.js";
import { buildMentionedCardContent, buildMentionedMessage } from "./mention.js";
import { getFeishuRuntime } from "./runtime.js";
import {
  sendMessageFeishu,
  sendMarkdownCardFeishu,
  editMessageFeishu,
  createCardEntityFeishu,
  sendCardByCardIdFeishu,
  updateCardElementContentFeishu,
  updateCardSummaryFeishu,
  closeStreamingModeFeishu,
  deleteMessageFeishu,
} from "./send.js";
import { addTypingIndicator, removeTypingIndicator, type TypingIndicatorState } from "./typing.js";

/**
 * Detect if text contains markdown elements that benefit from card rendering.
 * Used by auto render mode.
 */
function shouldUseCard(text: string): boolean {
  // Code blocks (fenced)
  if (/```[\s\S]*?```/.test(text)) {
    return true;
  }
  // Tables (at least header + separator row with |)
  if (/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)) {
    return true;
  }
  return false;
}

function firstSentence(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Generating ...";
  }
  const match = normalized.match(/^(.{1,120}?[。！？.!?])(\s|$)/);
  if (match?.[1]) {
    return match[1].trim();
  }
  return normalized.slice(0, 120).trim();
}

const STREAM_THROTTLE_MS = 500;
const STREAM_UPDATE_MAX_RETRIES = 3;
const STREAM_SEQUENCE_MAX_RETRIES = 8;

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

type StreamingBackend =
  | "none" // Initial state, not yet determined
  | "cardkit" // Using CardKit API (cardkit.v1.card.create + cardElement.content)
  | "raw" // Using im.message.update for text edits
  | "stopped"; // Failed, stop trying to stream

export type CreateFeishuReplyDispatcherParams = {
  cfg: OpenClawConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  replyToMessageId?: string;
  /** Mention targets, will be auto-included in replies */
  mentionTargets?: MentionTarget[];
  /** Account ID for multi-account support */
  accountId?: string;
  disableBlockStreaming?: boolean;
  enableThinkingCard?: boolean;
};

export function createFeishuReplyDispatcher(params: CreateFeishuReplyDispatcherParams) {
  const core = getFeishuRuntime();
  const {
    cfg,
    agentId,
    chatId,
    replyToMessageId,
    mentionTargets,
    accountId,
    disableBlockStreaming,
  } = params;

  // Resolve account for config access
  const account = resolveFeishuAccount({ cfg, accountId });

  const prefixContext = createReplyPrefixContext({
    cfg,
    agentId,
  });

  // Feishu doesn't have a native typing indicator API.
  // We use message reactions as a typing indicator substitute.
  let typingState: TypingIndicatorState | null = null;

  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      if (!replyToMessageId) {
        return;
      }
      typingState = await addTypingIndicator({ cfg, messageId: replyToMessageId, accountId });
      params.runtime.log?.(`feishu[${account.accountId}]: added typing indicator reaction`);
    },
    stop: async () => {
      if (!typingState) {
        return;
      }
      await removeTypingIndicator({ cfg, state: typingState, accountId });
      typingState = null;
      params.runtime.log?.(`feishu[${account.accountId}]: removed typing indicator reaction`);
    },
    onStartError: (err) => {
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "start",
        error: err,
      });
    },
    onStopError: (err) => {
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "stop",
        error: err,
      });
    },
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, "feishu", accountId, {
    fallbackLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "feishu");
  const tableMode = core.channel.text.resolveMarkdownTableMode({ cfg, channel: "feishu" });

  const feishuCfg = account.config;
  const blockStreamingConfigured = feishuCfg?.blockStreaming !== false;
  const blockStreamingEnabled = blockStreamingConfigured && disableBlockStreaming !== true;
  const trueStreamingEnabled = feishuCfg?.streaming !== false;
  const renderMode = feishuCfg?.renderMode ?? "auto";
  const streamRenderMode = renderMode === "raw" ? "raw" : "card";
  const thinkingCardEnabled = params.enableThinkingCard !== false;
  const configuredStreamMethod = trueStreamingEnabled
    ? streamRenderMode === "card"
      ? "cardkit.cardElement.content"
      : "im.message.update"
    : "disabled";

  params.runtime.log?.(
    `feishu[${account.accountId}] streaming config: enabled=${trueStreamingEnabled}, renderMode=${renderMode}, streamRenderMode=${streamRenderMode}, blockStreamingConfigured=${blockStreamingConfigured}, blockStreamingEnabled=${blockStreamingEnabled}, method=${configuredStreamMethod}`,
  );

  // Block streaming state: accumulate blocks into a single card.
  let streamingCardId: string | null = null;
  let accumulatedCardText = "";

  // True streaming state with explicit backend mode.
  let streamBackend: StreamingBackend = "none";
  let streamCardKitId: string | null = null;
  let streamMessageId: string | null = null;
  let streamSequence = 0; // Next sequence to use (starts at 1)
  let streamLastSentText = "";
  let streamPendingText = "";
  let streamInFlight = false;
  let streamTimer: ReturnType<typeof setTimeout> | null = null;
  let streamFinalText: string | null = null; // Store final text for delivery after flush
  let streamPartialCount = 0;
  let streamFlushCount = 0;
  let streamUpdateCount = 0;
  let streamEverUpdated = false;
  let streamClosing = false;
  let streamClosed = false;
  let streamClosePromise: Promise<void> | null = null;
  let cardKitOpQueue: Promise<void> = Promise.resolve();

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
          params.runtime.log?.(
            `feishu[${account.accountId}] ${label} failed (cardId=${streamCardKitId}, sequence=${nextSequence}, attempt=${attempt}, retryable=${retryable}, sequenceError=${sequenceError}): ${String(err)}`,
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

  const clearPendingThinkingCard = async (): Promise<void> => {
    if (!streamCardKitId || streamEverUpdated) {
      return;
    }
    const cardId = streamCardKitId;
    params.runtime.log?.(
      `feishu[${account.accountId}] cleaning up orphan thinking card: cardId=${streamCardKitId}`,
    );

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
      params.runtime.log?.(`feishu[${account.accountId}] orphan thinking card cleared`);
      return;
    } catch {
      // Recall below if all retries fail.
    }

    // All sequence attempts failed — recall the message entirely
    if (streamMessageId) {
      params.runtime.log?.(
        `feishu[${account.accountId}] orphan thinking card update failed, recalling message: msgId=${streamMessageId}`,
      );
      try {
        await deleteMessageFeishu({
          cfg,
          messageId: streamMessageId,
          accountId,
        });
        params.runtime.log?.(
          `feishu[${account.accountId}] orphan thinking card message recalled successfully`,
        );
      } catch (recallErr) {
        params.runtime.log?.(
          `feishu[${account.accountId}] orphan thinking card recall failed: ${String(recallErr)}`,
        );
      }
    } else {
      params.runtime.log?.(
        `feishu[${account.accountId}] orphan thinking cleanup failed: no messageId for recall`,
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
      params.runtime.log?.(
        `feishu[${account.accountId}] eager thinking card: cardId=${entity.cardId}, msgId=${result.messageId}`,
      );
    } catch (err) {
      params.runtime.log?.(
        `feishu[${account.accountId}] eager thinking card failed (will retry on first partial): ${String(err)}`,
      );
    }
  };

  const applyMentions = (text: string): string => {
    if (!mentionTargets || mentionTargets.length === 0) {
      return text;
    }
    return streamRenderMode === "card"
      ? buildMentionedCardContent(mentionTargets, text)
      : buildMentionedMessage(mentionTargets, text);
  };

  const updateCardElementWithRetry = async (updateParams: {
    cardId: string;
    content: string;
  }): Promise<void> => {
    const { cardId, content } = updateParams;
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

  /**
   * Send or update the streaming message.
   * For CardKit: sequence starts at 1 and strictly increases.
   * Returns true on success, false to trigger fallback.
   */
  const sendOrUpdateStreamMessage = async (text: string): Promise<boolean> => {
    // Don't trim - preserve markdown formatting including leading/trailing whitespace
    if (!text || text === streamLastSentText) {
      return true;
    }

    try {
      if (streamRenderMode === "card") {
        if (streamClosing || streamClosed) {
          return true;
        }
        if (streamBackend === "cardkit" && streamCardKitId) {
          await updateCardElementWithRetry({
            cardId: streamCardKitId,
            content: applyMentions(text),
          });
          streamUpdateCount += 1;
          streamEverUpdated = true;
        } else if (streamBackend === "none") {
          // First partial: try CardKit first
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

            // Only set state after both operations succeed
            streamCardKitId = entity.cardId;
            streamMessageId = result.messageId;
            streamBackend = "cardkit";
            streamSequence = 0; // First element update should start at sequence 1
            params.runtime.log?.(
              `feishu[${account.accountId}] CardKit stream initialized (method=cardkit.cardElement.content): cardId=${entity.cardId}, msgId=${result.messageId}`,
            );
          } catch (cardKitErr) {
            // CardKit stream init unavailable (create or bind failed) — stop streaming.
            params.runtime.log?.(
              `feishu[${account.accountId}] CardKit stream init failed (create-or-bind), streaming unavailable: ${String(cardKitErr)}`,
            );
            streamBackend = "stopped";
          }
        }
        // If backend is "stopped", do nothing
      } else {
        // Raw mode — use text message edit
        if (streamBackend === "raw" && streamMessageId) {
          const textWithMentions = applyMentions(text);
          await editMessageFeishu({
            cfg,
            messageId: streamMessageId,
            text: textWithMentions,
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
          params.runtime.log?.(`feishu[${account.accountId}] raw stream initialized`);
        }
        // If backend is "stopped", do nothing
      }
      streamLastSentText = text;
      return true;
    } catch (err) {
      // Update failed — lock to stopped state and let deliver handle fallback
      params.runtime.log?.(`feishu[${account.accountId}] streaming update failed: ${String(err)}`);
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
      const success = await sendOrUpdateStreamMessage(text);
      if (!success && streamFinalText) {
        // Streaming failed but we have final text — deliver will handle it
      }
    } finally {
      streamInFlight = false;
      // Keep a single timer so update cadence stays stable.
      if (streamPendingText && !streamTimer) {
        streamTimer = setTimeout(() => {
          void flushStream();
        }, STREAM_THROTTLE_MS);
      }
    }
  };

  const queueStreamUpdate = (text: string) => {
    if (streamBackend === "stopped" || streamClosing || streamClosed) {
      return;
    }
    streamPendingText = text;
    if (!streamTimer) {
      streamTimer = setTimeout(() => {
        void flushStream();
      }, STREAM_THROTTLE_MS);
    }
  };

  const waitForStreamIdle = async (): Promise<void> => {
    // Wait for any in-flight stream operations to complete
    while (streamInFlight) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Also flush any pending timer
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
      params.runtime.log?.(
        `feishu[${account.accountId}] close streaming mode failed: ${String(err)}`,
      );
    } finally {
      if (!streamClosed) {
        streamClosing = false;
      }
      streamClosePromise = null;
    }
  };

  const notifyMessageSent = (content: string, messageId?: string) => {
    emitMessageSent(
      { to: chatId, content, success: true, messageId },
      { channelId: "feishu", accountId: account.accountId, conversationId: chatId },
    );
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: typingCallbacks.onReplyStart,
      deliver: async (payload: ReplyPayload) => {
        const text = payload.text ?? "";
        streamFinalText = text;

        if (trueStreamingEnabled && text) {
          // Wait for any pending stream operations to complete
          await waitForStreamIdle();

          // If streaming succeeded, just send the final update
          if (streamBackend !== "stopped" && streamMessageId) {
            params.runtime.log?.(
              `feishu[${account.accountId}] final stream delivery via ${streamRenderMode === "card" ? "cardkit.cardElement.content" : "im.message.update"}: backend=${streamBackend}, partials=${streamPartialCount}, flushes=${streamFlushCount}, updates=${streamUpdateCount}`,
            );
            const streamSuccess = await sendOrUpdateStreamMessage(text);
            if (streamSuccess && streamRenderMode === "card" && streamCardKitId) {
              const cardId = streamCardKitId;
              const summary = firstSentence(text);
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
                params.runtime.log?.(
                  `feishu[${account.accountId}] summary update skipped: ${String(err)}`,
                );
              }
            }
            if (streamSuccess) {
              await closeStreamingIfNeeded();
              params.runtime.log?.(
                `feishu[${account.accountId}] streaming status: used=${streamEverUpdated}, backend=${streamBackend}, partials=${streamPartialCount}, flushes=${streamFlushCount}, updates=${streamUpdateCount}`,
              );
              return;
            }
          }

          // If streaming failed or never started, continue to send final message below
          params.runtime.log?.(
            `feishu[${account.accountId}] deliver: streaming unavailable/failed (backend=${streamBackend}, partials=${streamPartialCount}, flushes=${streamFlushCount}, updates=${streamUpdateCount}), sending final message`,
          );
        }

        params.runtime.log?.(
          `feishu[${account.accountId}] deliver called: text=${text.slice(0, 100)}`,
        );
        if (!text) {
          params.runtime.log?.(`feishu[${account.accountId}] deliver: empty text, skipping`);
          return;
        }

        // Determine if we should use card for this message
        const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));

        // Card mode with block streaming: accumulate text and update via CardKit
        if (useCard && blockStreamingEnabled && streamBackend !== "stopped") {
          if (streamingCardId) {
            accumulatedCardText += "\n\n" + text;
            params.runtime.log?.(
              `feishu[${account.accountId}] deliver: updating streaming card ${streamingCardId}`,
            );
            if (streamBackend === "cardkit" && streamCardKitId) {
              // CardKit path — unlimited updates
              try {
                await updateCardElementWithRetry({
                  cardId: streamCardKitId,
                  content: accumulatedCardText,
                });
              } catch (err) {
                params.runtime.log?.(
                  `feishu[${account.accountId}] deliver: CardKit update failed: ${String(err)}`,
                );
                streamBackend = "stopped";
              }
            }
          } else {
            accumulatedCardText = text;
            params.runtime.log?.(
              `feishu[${account.accountId}] deliver: creating streaming card in ${chatId}`,
            );
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
            } catch (cardKitErr) {
              // CardKit unavailable — send as regular card, no block streaming
              params.runtime.log?.(
                `feishu[${account.accountId}] deliver: CardKit create failed: ${String(cardKitErr)}`,
              );
              streamBackend = "stopped";
              await sendMarkdownCardFeishu({
                cfg,
                to: chatId,
                text,
                replyToMessageId,
                mentions: mentionTargets,
                accountId,
              });
            }
          }
          return;
        }

        // Non-streaming path: send each delivery as a separate message
        // Only include @mentions in the first chunk (avoid duplicate @s)
        let isFirstChunk = true;

        if (useCard) {
          // Card mode: send as interactive card with markdown rendering
          const chunks = core.channel.text.chunkTextWithMode(text, textChunkLimit, chunkMode);
          params.runtime.log?.(
            `feishu[${account.accountId}] deliver: sending ${chunks.length} card chunks to ${chatId}`,
          );
          for (const chunk of chunks) {
            await sendMarkdownCardFeishu({
              cfg,
              to: chatId,
              text: chunk,
              replyToMessageId,
              mentions: isFirstChunk ? mentionTargets : undefined,
              accountId,
            });
            isFirstChunk = false;
          }
        } else {
          // Raw mode: send as plain text with table conversion
          const converted = core.channel.text.convertMarkdownTables(text, tableMode);
          const chunks = core.channel.text.chunkTextWithMode(converted, textChunkLimit, chunkMode);
          params.runtime.log?.(
            `feishu[${account.accountId}] deliver: sending ${chunks.length} text chunks to ${chatId}`,
          );
          for (const chunk of chunks) {
            await sendMessageFeishu({
              cfg,
              to: chatId,
              text: chunk,
              replyToMessageId,
              mentions: isFirstChunk ? mentionTargets : undefined,
              accountId,
            });
            isFirstChunk = false;
          }
        }
      },
      onError: (err, info) => {
        params.runtime.error?.(
          `feishu[${account.accountId}] ${info.kind} reply failed: ${String(err)}`,
        );
        typingCallbacks.onIdle?.();
      },
      onCleanup: () => {
        typingCallbacks.onCleanup?.();
        void clearPendingThinkingCard();
        void closeStreamingIfNeeded();
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: async (ctx: Parameters<typeof prefixContext.onModelSelected>[0]) => {
        await ensureThinkingCardIfNeeded();
        prefixContext.onModelSelected(ctx);
      },
      disableBlockStreaming: trueStreamingEnabled ? true : undefined,
      onPartialReply: trueStreamingEnabled
        ? (payload: ReplyPayload) => {
            const text = payload.text ?? "";
            if (!text) {
              return;
            }
            streamPartialCount += 1;
            queueStreamUpdate(text);
          }
        : undefined,
    },
    markDispatchIdle,
    finalizeThinkingCard: clearPendingThinkingCard,
  };
}
