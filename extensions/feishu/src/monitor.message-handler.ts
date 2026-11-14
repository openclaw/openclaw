import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { isRecord, readStringValue as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ClawdbotConfig, HistoryEntry, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import { normalizeFeishuCommandProbeBody } from "./bot-content.js";
import type { handleFeishuMessage } from "./bot.js";
import { resolveConfiguredFeishuGroupSessionScope } from "./conversation-id.js";
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
import { resolveFeishuGroupConfig } from "./policy.js";
import { parsePostContent } from "./post.js";
import type { getFeishuSequentialKey } from "./sequential-key.js";
import { createSequentialQueue } from "./sequential-queue.js";
import { isFeishuGroupChatType, normalizeFeishuEventChatType } from "./types.js";

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
  flushing?: boolean;
  topicOrder?: {
    key: string;
    ready?: Promise<void>;
    release: () => void;
    fallback: boolean;
    stopDeferredHeartbeat?: () => void;
  };
};

function resolveFeishuDebounceSenderId(event: FeishuMessageEvent): string | undefined {
  return event.sender.sender_id.open_id?.trim() || event.sender.sender_id.user_id?.trim();
}

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
  const pendingChatTasks = new Map<string, Set<Promise<void>>>();
  const chatBarriers = new Map<string, Promise<void>>();

  const dispatchFeishuMessage = async (
    { event, messageDedupeKey, processingClaim, topicOrder }: FeishuMessageDebounceEntry,
    turnAdoptionLifecycle?: FeishuIngressLifecycle,
    preparedContent?: string,
    onExecutionStart?: () => void,
  ) => {
    const sequentialKey = resolveSequentialKey({
      cfg: readConfig(),
      accountId,
      event,
      preparedContent,
      botOpenId: getBotOpenId(accountId),
      isControlCommandMessage: (text) =>
        channelRuntime.commands.isControlCommandMessage(text, readConfig()),
    });
    const task = async () => {
      onExecutionStart?.();
      if (turnAdoptionLifecycle?.abortSignal.aborted) {
        await turnAdoptionLifecycle.onAbandoned();
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
    if (topicOrder?.ready) {
      await topicOrder.ready;
    }
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
      // Never merge across an unidentified-topic barrier: that batch would
      // contain both a predecessor and a dependent of the same fallback turn.
      canAppend: (entry, pending) => {
        const first = pending[0];
        return (
          first !== undefined &&
          entry.topicOrder?.ready === first.topicOrder?.ready &&
          resolveFeishuDebounceSenderId(entry.event) === resolveFeishuDebounceSenderId(first.event)
        );
      },
      buildKey: ({ event, topicOrder }) => {
        // A pending ordinary batch must not serialize controls before their own lanes.
        if (
          event.message.message_type === "text" &&
          channelRuntime.commands.isControlCommandMessage(
            normalizeFeishuCommandProbeBody(resolveDebounceText(event)),
            readConfig(),
          )
        ) {
          return null;
        }
        const chatId = event.message.chat_id?.trim();
        const senderId = resolveFeishuDebounceSenderId(event);
        if (!chatId || !senderId) {
          return null;
        }
        if (topicOrder && !topicOrder.fallback) {
          return topicOrder.key;
        }
        const threadId = event.message.root_id?.trim() || event.message.thread_id?.trim();
        const threadKey = threadId ? `thread:${threadId}` : "chat";
        return `feishu:${accountId}:${chatId}:${threadKey}:${senderId}`;
      },
      shouldDebounce: ({ event, topicOrder }) => {
        if (topicOrder?.fallback) {
          return false;
        }
        if (event.message.message_type !== "text") {
          return false;
        }
        const text = resolveDebounceText(event);
        return Boolean(text);
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
        const stopDeferredHeartbeats = () => {
          for (const entry of activeEntries) {
            entry.topicOrder?.stopDeferredHeartbeat?.();
          }
        };
        return createFlush({
          lifecycle,
          dispatch: async (admissionLifecycle) => {
            for (const entry of activeEntries) {
              entry.flushing = true;
            }
            try {
              if (!last) {
                return;
              }
              if (admissionLifecycle.abortSignal.aborted) {
                await admissionLifecycle.onAbandoned();
                return;
              }
              try {
                if (activeEntries.length === 1) {
                  await dispatchFeishuMessage(
                    last,
                    admissionLifecycle,
                    undefined,
                    stopDeferredHeartbeats,
                  );
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
                  stopDeferredHeartbeats,
                );
                await settle();
              } catch (err) {
                await admissionLifecycle.onAbandoned();
                throw err;
              }
            } finally {
              for (const entry of entries) {
                entry.topicOrder?.release();
              }
            }
          },
        });
      },
      onError: (err, entries) => {
        for (const entry of entries) {
          entry.topicOrder?.release();
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
      await turnAdoptionLifecycle?.onAbandoned();
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
      await turnAdoptionLifecycle?.onAbandoned();
      return { kind: "failed-retryable", error: stoppedError };
    }
    if (claim.kind === "duplicate" || claim.kind === "inflight") {
      await completeSuppressedIngress();
      return undefined;
    }
    const debounceEntry: FeishuMessageDebounceEntry = {
      event,
      messageDedupeKey,
      ...(claim.kind === "claimed" ? { processingClaim: claim.handle } : {}),
      ...(turnAdoptionLifecycle ? { turnAdoptionLifecycle } : {}),
    };
    const config = readConfig();
    const sequentialKey = resolveSequentialKey({
      cfg: config,
      accountId,
      event,
      botOpenId,
      isControlCommandMessage: (text) =>
        channelRuntime.commands.isControlCommandMessage(text, config),
    });
    const chatId = event.message.chat_id.trim();
    const chatKey = `feishu:${accountId}:${chatId}`;
    let isChatFallback = false;
    if (sequentialKey === chatKey && isFeishuGroupChatType(event.message.chat_type)) {
      const feishuCfg = resolveFeishuAccount({ cfg: config, accountId }).config;
      const scope = resolveConfiguredFeishuGroupSessionScope({
        feishuCfg,
        groupConfig: resolveFeishuGroupConfig({ cfg: feishuCfg, groupId: chatId }),
      });
      isChatFallback = scope === "group_topic" || scope === "group_topic_sender";
    }
    if (isChatFallback || sequentialKey.startsWith(`${chatKey}:topic:`)) {
      // Reserve before buffering so quiet-period extensions cannot let later
      // topics overtake a missing-thread event or its earlier predecessors.
      const pending = pendingChatTasks.get(chatKey) ?? new Set<Promise<void>>();
      pendingChatTasks.set(chatKey, pending);
      const ready = isChatFallback
        ? Promise.all(pending).then(() => {})
        : chatBarriers.get(chatKey);
      const settled = createDeferred<void>();
      pending.add(settled.promise);
      if (isChatFallback) {
        chatBarriers.set(chatKey, settled.promise);
      }
      let released = false;
      debounceEntry.topicOrder = {
        key: sequentialKey,
        ready,
        fallback: isChatFallback,
        release: () => {
          debounceEntry.topicOrder?.stopDeferredHeartbeat?.();
          if (released) {
            return;
          }
          released = true;
          // An abandoned barrier must still preserve its predecessors.
          void Promise.resolve(ready).then(() => {
            settled.resolve();
            pending.delete(settled.promise);
            if (pending.size === 0) {
              pendingChatTasks.delete(chatKey);
            }
            if (chatBarriers.get(chatKey) === settled.promise) {
              chatBarriers.delete(chatKey);
            }
          });
        },
      };
    }
    if (claim.kind === "claimed" && turnAdoptionLifecycle) {
      // The durable drain can abandon before the debounce timer flushes. Tie
      // the logical claim and queued entry to that earlier lifecycle.
      turnAdoptionLifecycle.onBeforeAbandon = () => {
        debounceEntry.abandoned = true;
        debounceEntry.topicOrder?.stopDeferredHeartbeat?.();
        if (!debounceEntry.flushing) {
          debounceEntry.topicOrder?.release();
        }
        claim.handle.release({ error: new Error("feishu-ingress-abandoned-before-flush") });
      };
    }
    if (turnAdoptionLifecycle) {
      try {
        if (debounceEntry.topicOrder) {
          // Keep durable custody alive while debounce, barriers, or earlier runs wait.
          // Execution takes over the watchdog when its queue slot starts.
          turnAdoptionLifecycle.onDeferred();
          const intervalMs = turnAdoptionLifecycle.deferredHeartbeatIntervalMs;
          if (intervalMs !== undefined) {
            const heartbeat = setInterval(
              () => turnAdoptionLifecycle.onDeferredHeartbeat?.(),
              intervalMs,
            );
            heartbeat.unref();
            const stop = () => {
              clearInterval(heartbeat);
              turnAdoptionLifecycle.abortSignal.removeEventListener("abort", stop);
            };
            debounceEntry.topicOrder.stopDeferredHeartbeat = stop;
            turnAdoptionLifecycle.abortSignal.addEventListener("abort", stop, { once: true });
            if (turnAdoptionLifecycle.abortSignal.aborted) {
              stop();
            }
          }
        }
        const processing = inboundDebouncer.enqueue(debounceEntry);
        if (debounceEntry.topicOrder) {
          const settled = processing.catch(async (err: unknown) => {
            debounceEntry.topicOrder?.release();
            if (claim.kind === "claimed") {
              claim.handle.release({ error: err });
            }
            try {
              await turnAdoptionLifecycle.onAbandoned();
            } catch (abandonError) {
              error(
                `feishu[${accountId}]: failed to abandon deferred topic: ${String(abandonError)}`,
              );
            }
            error(`feishu[${accountId}]: error handling deferred topic: ${String(err)}`);
          });
          trackTask?.(settled);
        } else {
          await processing;
        }
        return { kind: "deferred" };
      } catch (err) {
        debounceEntry.topicOrder?.release();
        if (claim.kind === "claimed") {
          claim.handle.release({ error: err });
        }
        return { kind: "failed-retryable", error: err };
      }
    }
    const processing = inboundDebouncer.enqueue(debounceEntry).catch((err: unknown) => {
      debounceEntry.topicOrder?.release();
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
