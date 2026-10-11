import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { isRecord, readStringValue as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ClawdbotConfig, HistoryEntry, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import type { handleFeishuMessage } from "./bot.js";
import {
  claimUnprocessedFeishuMessage,
  type FeishuMessageProcessingClaim,
  type hasProcessedFeishuMessage,
} from "./dedup.js";
import { resolveFeishuMessageDedupeKey } from "./dedupe-key.js";
import type { FeishuMessageEvent } from "./event-types.js";
import {
  buildFeishuFlushIngressLifecycle,
  FeishuIngressPermanentError,
  type FeishuIngressLifecycle,
} from "./feishu-ingress.js";
import { isMentionForwardRequest } from "./mention.js";
import { parsePostContent } from "./post.js";
import type { getFeishuSequentialKey } from "./sequential-key.js";
import { createSequentialQueue } from "./sequential-queue.js";
import { normalizeFeishuEventChatType } from "./types.js";

type FeishuMessageReceiveHandlerContext = {
  cfg: ClawdbotConfig;
  channelRuntime: PluginRuntime["channel"];
  accountId: string;
  runtime?: RuntimeEnv;
  chatHistories: Map<string, HistoryEntry[]>;
  fireAndForget?: boolean;
  isAccountActive?: () => boolean;
  trackTask?: (task: Promise<void>) => void;
  handleMessage: typeof handleFeishuMessage;
  resolveDebounceText: (params: { event: FeishuMessageEvent; botOpenId?: string }) => string;
  hasProcessedMessage: typeof hasProcessedFeishuMessage;
  getBotOpenId?: (accountId: string) => string | undefined;
  resolveSequentialKey?: typeof getFeishuSequentialKey;
  /**
   * Optional status sink. When provided, the handler will publish `lastEventAt`
   * on every inbound message for message recency. Transport liveness is
   * published by the transport layer.
   */
  statusSink?: import("./monitor.js").FeishuStatusSink;
  resolveIngressLifecycle?: (data: unknown) => FeishuIngressLifecycle | undefined;
};

function parseFeishuMessageEventPayload(value: unknown): FeishuMessageEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const sender = value.sender;
  const message = value.message;
  if (!isRecord(sender) || !isRecord(message)) {
    return null;
  }
  const senderId = sender.sender_id;
  if (!isRecord(senderId)) {
    return null;
  }
  const messageId = readString(message.message_id);
  const chatId = readString(message.chat_id);
  const chatType = normalizeFeishuEventChatType(message.chat_type);
  const messageType = readString(message.message_type);
  // Feishu can deliver a legitimately empty message body; keep absent or
  // non-string bodies malformed instead of inventing fallback content.
  if (!messageId || !chatId || !chatType || !messageType || typeof message.content !== "string") {
    return null;
  }
  return value as FeishuMessageEvent;
}

function mergeFeishuDebounceMentions(
  entries: FeishuMessageEvent[],
): FeishuMessageEvent["message"]["mentions"] | undefined {
  const merged = new Map<string, NonNullable<FeishuMessageEvent["message"]["mentions"]>[number]>();
  for (const entry of entries) {
    for (const mention of entry.message.mentions ?? []) {
      const stableId =
        mention.id.open_id?.trim() || mention.id.user_id?.trim() || mention.id.union_id?.trim();
      const mentionName = mention.name?.trim();
      const mentionKey = mention.key?.trim();
      const fallback =
        mentionName && mentionKey ? `${mentionName}|${mentionKey}` : mentionName || mentionKey;
      const key = stableId || fallback;
      if (!key || merged.has(key)) {
        continue;
      }
      merged.set(key, mention);
    }
  }
  return merged.size > 0 ? Array.from(merged.values()) : undefined;
}

type FeishuMessageDebounceEntry = {
  event: FeishuMessageEvent;
  messageDedupeKey: string | undefined;
  processingClaim?: FeishuMessageProcessingClaim;
  turnAdoptionLifecycle?: FeishuIngressLifecycle;
  abandoned?: boolean;
};

function resolveFeishuDebounceMentions(params: {
  entries: FeishuMessageEvent[];
  botOpenId?: string;
}): FeishuMessageEvent["message"]["mentions"] | undefined {
  const { entries, botOpenId } = params;
  if (entries.length === 0) {
    return undefined;
  }
  for (const entry of entries.toReversed()) {
    if (isMentionForwardRequest(entry, botOpenId)) {
      return mergeFeishuDebounceMentions([entry]);
    }
  }
  const merged = mergeFeishuDebounceMentions(entries);
  if (!merged) {
    return undefined;
  }
  const normalizedBotOpenId = botOpenId?.trim();
  if (!normalizedBotOpenId) {
    return undefined;
  }
  const botMentions = merged.filter(
    (mention) => mention.id.open_id?.trim() === normalizedBotOpenId,
  );
  return botMentions.length > 0 ? botMentions : undefined;
}

/**
 * An already-fired owner abort ends the turn by intent, so it settles through
 * cancellation without spending retry budget. Any other pre-admission stop
 * remains abandonment.
 */
async function releaseUnadmittedIngress(lifecycle?: {
  abortSignal: AbortSignal;
  onCancelled?: () => void | Promise<void>;
  onAbandoned: () => void | Promise<void>;
}): Promise<void> {
  if (lifecycle?.abortSignal.aborted && lifecycle.onCancelled) {
    await lifecycle.onCancelled();
    return;
  }
  await lifecycle?.onAbandoned();
}

export function createFeishuMessageReceiveHandler({
  cfg,
  channelRuntime,
  accountId,
  runtime,
  chatHistories,
  fireAndForget,
  isAccountActive = () => true,
  trackTask,
  handleMessage,
  resolveDebounceText: resolveText,
  hasProcessedMessage,
  getBotOpenId = () => undefined,
  resolveSequentialKey = ({ accountId: accountIdLocal, event }) =>
    `feishu:${accountIdLocal}:${event.message.chat_id?.trim() || "unknown"}`,
  statusSink,
  resolveIngressLifecycle,
}: FeishuMessageReceiveHandlerContext): (
  data: unknown,
) => Promise<{ kind: "deferred" } | { kind: "failed-retryable"; error: unknown } | void> {
  const readConfig = createRuntimeConfigReader(cfg);
  const resolveDebounceMs = () =>
    channelRuntime.debounce.resolveInboundDebounceMs({ cfg: readConfig(), channel: "feishu" });
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;
  const enqueue = createSequentialQueue({
    onTaskTimeout: (key, timeoutMs) => {
      log(
        `feishu[${accountId}]: per-chat task exceeded ${timeoutMs}ms cap (key=${key}); evicting from queue so later same-key messages can proceed (#70133)`,
      );
    },
  });

  const dispatchFeishuMessage = async (
    { event, messageDedupeKey, processingClaim }: FeishuMessageDebounceEntry,
    turnAdoptionLifecycle?: FeishuIngressLifecycle,
    preparedContent?: string,
  ) => {
    const sequentialKey = resolveSequentialKey({
      accountId,
      event,
      preparedContent,
      botOpenId: getBotOpenId(accountId),
    });
    const task = async () => {
      if (turnAdoptionLifecycle?.abortSignal.aborted) {
        await releaseUnadmittedIngress(turnAdoptionLifecycle);
        return;
      }
      const handling = handleMessage({
        trackTask,
        cfg,
        event,
        preparedContent,
        botOpenId: getBotOpenId(accountId),
        runtime,
        channelRuntime,
        chatHistories,
        accountId,
        processingClaim,
        messageDedupeKey,
        turnAdoptionLifecycle,
      });
      trackTask?.(handling);
      await handling;
    };
    await enqueue(sequentialKey, task);
  };

  const resolveDebounceText = (event: FeishuMessageEvent): string => {
    return resolveText({
      event,
      botOpenId: getBotOpenId(accountId),
    }).trim();
  };

  const recordSuppressedMessageIds = async (
    entries: FeishuMessageDebounceEntry[],
    dispatchDedupeKey?: string,
  ) => {
    const keepDedupeKey = dispatchDedupeKey?.trim();
    for (const { messageDedupeKey, processingClaim } of entries) {
      if (!messageDedupeKey || messageDedupeKey === keepDedupeKey) {
        continue;
      }
      try {
        await processingClaim?.commit();
      } catch (err) {
        error(
          `feishu[${accountId}]: failed to record merged dedupe id ${messageDedupeKey}: ${String(err)}`,
        );
      }
    }
  };

  const inboundDebouncer =
    channelRuntime.debounce.createInboundDebouncer<FeishuMessageDebounceEntry>({
      debounceMs: resolveDebounceMs(),
      resolveDebounceMs,
      buildKey: ({ event }) => {
        const chatId = event.message.chat_id?.trim();
        const senderId =
          event.sender.sender_id.open_id?.trim() || event.sender.sender_id.user_id?.trim();
        if (!chatId || !senderId) {
          return null;
        }
        const threadId = event.message.root_id?.trim() || event.message.thread_id?.trim();
        const threadKey = threadId ? `thread:${threadId}` : "chat";
        return `feishu:${accountId}:${chatId}:${threadKey}:${senderId}`;
      },
      shouldDebounce: ({ event }) => {
        if (event.message.message_type !== "text") {
          return false;
        }
        const text = resolveDebounceText(event);
        return Boolean(text) && !channelRuntime.commands.isControlCommandMessage(text, cfg);
      },
      onFlush: (entries, createFlush) => {
        const activeEntries = entries.filter((entry) => !entry.abandoned);
        const last = activeEntries.at(-1);
        const { lifecycle, settle } = buildFeishuFlushIngressLifecycle(
          activeEntries.map((entry) => ({
            lifecycle: entry.turnAdoptionLifecycle,
            replayClaim: entry.processingClaim,
          })),
          {
            trackTask,
            onReplayCommitError: (err) =>
              error(`feishu[${accountId}]: failed to commit logical replay guard: ${String(err)}`),
          },
        );
        return createFlush({
          lifecycle,
          dispatch: async (admissionLifecycle) => {
            if (!last) {
              return;
            }
            if (admissionLifecycle.abortSignal.aborted) {
              await releaseUnadmittedIngress(admissionLifecycle);
              return;
            }
            try {
              if (activeEntries.length === 1) {
                await dispatchFeishuMessage(last, admissionLifecycle);
                await settle();
                return;
              }
              // Admission already holds one exclusive claim for each logical message.
              const dispatchEntry = last;
              const dispatchDedupeKey = dispatchEntry.messageDedupeKey;
              if (!lifecycle) {
                await recordSuppressedMessageIds(activeEntries, dispatchDedupeKey);
              }
              const combinedText = activeEntries
                .map((entry) => resolveDebounceText(entry.event))
                .filter(Boolean)
                .join("\n");
              const mergedMentions = resolveFeishuDebounceMentions({
                entries: activeEntries.map((entry) => entry.event),
                botOpenId: getBotOpenId(accountId),
              });
              await dispatchFeishuMessage(
                {
                  ...dispatchEntry,
                  event: {
                    ...dispatchEntry.event,
                    message: {
                      ...dispatchEntry.event.message,
                      mentions: mergedMentions ?? dispatchEntry.event.message.mentions,
                    },
                  },
                },
                admissionLifecycle,
                combinedText,
              );
              await settle();
            } catch (err) {
              await admissionLifecycle.onAbandoned();
              throw err;
            }
          },
        });
      },
      onError: (err, entries) => {
        for (const entry of entries) {
          entry.processingClaim?.release({ error: err });
          try {
            void Promise.resolve(entry.turnAdoptionLifecycle?.onAbandoned()).catch(
              (abandonError: unknown) => {
                error(
                  `feishu[${accountId}]: failed to abandon durable ingress after debounce error: ${String(abandonError)}`,
                );
              },
            );
          } catch (abandonError) {
            error(
              `feishu[${accountId}]: failed to abandon durable ingress after debounce error: ${String(abandonError)}`,
            );
          }
        }
        error(`feishu[${accountId}]: inbound debounce flush failed: ${String(err)}`);
      },
    });

  return async (data) => {
    const turnAdoptionLifecycle = resolveIngressLifecycle?.(data);
    if (!isAccountActive() || turnAdoptionLifecycle?.abortSignal.aborted) {
      await releaseUnadmittedIngress(turnAdoptionLifecycle);
      return undefined;
    }
    const completeSuppressedIngress = async () => {
      if (!turnAdoptionLifecycle) {
        return;
      }
      turnAdoptionLifecycle.onAdoptionFinalizing();
      await turnAdoptionLifecycle.onAdopted();
    };
    // Publish message recency before dedupe/debounce; transport liveness is
    // owned by the WebSocket/Webhook lifecycle monitors.
    const inboundAt = Date.now();
    statusSink?.({
      lastEventAt: inboundAt,
    });

    const event = parseFeishuMessageEventPayload(data);
    if (!event) {
      if (turnAdoptionLifecycle) {
        throw new FeishuIngressPermanentError(
          "invalid-event",
          "Feishu durable message event payload is malformed.",
        );
      }
      error(`feishu[${accountId}]: ignoring malformed message event payload`);
      return undefined;
    }
    const messageId = event.message?.message_id?.trim();
    const botOpenId = getBotOpenId(accountId)?.trim();
    const senderOpenId = event.sender.sender_id.open_id?.trim();
    if (botOpenId && senderOpenId === botOpenId) {
      // Feishu bot receive events identify their sender by open_id. Drop this
      // account's bot before it can consume a claim or debounce slot.
      log(`feishu[${accountId}]: dropping self-authored message ${messageId ?? "unknown"}`);
      await completeSuppressedIngress();
      return undefined;
    }
    const messageDedupeKey = resolveFeishuMessageDedupeKey(event);
    // Attachment-free posts used their raw message ID before retry-stable keys.
    // Honor retained records until their normal replay TTL expires.
    if (
      event.message.message_type.trim() === "post" &&
      messageDedupeKey !== messageId &&
      (await hasProcessedMessage(messageId, accountId, log)) &&
      parsePostContent(event.message.content, { includeTopLevelFiles: false }).attachments
        .length === 0
    ) {
      log(`feishu[${accountId}]: dropping duplicate event for message ${messageId}`);
      await completeSuppressedIngress();
      return undefined;
    }
    const claim = await claimUnprocessedFeishuMessage({
      messageId: messageDedupeKey,
      namespace: accountId,
      log,
    });
    if (!isAccountActive() || turnAdoptionLifecycle?.abortSignal.aborted) {
      const stoppedError = new Error("feishu account stopped before message admission");
      if (claim.kind === "claimed") {
        claim.handle.release({ error: stoppedError });
      }
      await releaseUnadmittedIngress(turnAdoptionLifecycle);
      return { kind: "failed-retryable", error: stoppedError };
    }
    if (claim.kind === "duplicate" || claim.kind === "inflight") {
      log(`feishu[${accountId}]: dropping ${claim.kind} event for message ${messageId}`);
      await completeSuppressedIngress();
      return undefined;
    }
    const debounceEntry: FeishuMessageDebounceEntry = {
      event,
      messageDedupeKey,
      ...(claim.kind === "claimed" ? { processingClaim: claim.handle } : {}),
      ...(turnAdoptionLifecycle ? { turnAdoptionLifecycle } : {}),
    };
    if (claim.kind === "claimed" && turnAdoptionLifecycle) {
      // The durable drain can abandon before the debounce timer flushes. Tie
      // the logical claim and queued entry to that earlier lifecycle.
      turnAdoptionLifecycle.registerAbandonHandler?.(() => {
        debounceEntry.abandoned = true;
        claim.handle.release({ error: new Error("feishu-ingress-abandoned-before-flush") });
      });
    }
    if (turnAdoptionLifecycle) {
      try {
        await inboundDebouncer.enqueue(debounceEntry);
        return { kind: "deferred" };
      } catch (err) {
        if (claim.kind === "claimed") {
          claim.handle.release({ error: err });
        }
        return { kind: "failed-retryable", error: err };
      }
    }
    const processing = inboundDebouncer.enqueue(debounceEntry).catch((err: unknown) => {
      if (claim.kind === "claimed") {
        claim.handle.release({ error: err });
      }
      error(`feishu[${accountId}]: error handling message: ${String(err)}`);
    });
    if (!fireAndForget) {
      await processing;
    }
    return undefined;
  };
}
