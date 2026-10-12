import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { isRecord, readStringValue as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ClawdbotConfig, HistoryEntry, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import { raceWithTimeoutAndAbort } from "./async.js";
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
import type { FeishuProcessingMessage, FeishuProcessingTarget } from "./processing-indicator.js";
import { getMessageFeishu } from "./send.js";
import { getFeishuSequentialKey } from "./sequential-key.js";
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
  processingIndicator?: {
    receive: (target: FeishuProcessingTarget) => FeishuProcessingMessage;
  };
  handleMessage: typeof handleFeishuMessage;
  resolveDebounceText: (params: { event: FeishuMessageEvent; botOpenId?: string }) => string;
  hasProcessedMessage: typeof hasProcessedFeishuMessage;
  getBotOpenId?: (accountId: string) => string | undefined;
  resolveSequentialKey?: typeof getFeishuSequentialKey;
  fetchMessage?: typeof getMessageFeishu;
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
  processingStatus?: FeishuProcessingMessage;
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

export function createFeishuMessageReceiveHandler({
  cfg,
  channelRuntime,
  accountId,
  runtime,
  chatHistories,
  fireAndForget,
  isAccountActive = () => true,
  trackTask,
  processingIndicator,
  handleMessage,
  resolveDebounceText: resolveText,
  hasProcessedMessage,
  getBotOpenId = () => undefined,
  resolveSequentialKey = getFeishuSequentialKey,
  fetchMessage = getMessageFeishu,
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
  // The ingress watchdog owns stalled admission. A channel timeout must not
  // bypass unfinished media/preparation and admit later same-session input first.
  const enqueue = createSequentialQueue({ taskTimeoutMs: 0 });
  const prepareReceipt = createSequentialQueue({ taskTimeoutMs: 0 });

  const dispatchFeishuMessage = async (
    event: FeishuMessageEvent,
    messageDedupeKey?: string,
    processingClaim?: FeishuMessageProcessingClaim,
    turnAdoptionLifecycle?: FeishuIngressLifecycle,
    preparedContent?: string,
    processingStatus?: FeishuProcessingMessage,
  ) => {
    const sequentialKey = resolveSequentialKey({
      cfg: readConfig(),
      accountId,
      event,
      preparedContent,
      botOpenId: getBotOpenId(accountId),
    });
    const admitted = createDeferred<void>();
    const completed = createDeferred<void>();
    const aborted = createDeferred<void>();
    void aborted.promise.catch(() => undefined);
    const onAbort = () => {
      void Promise.resolve(turnAdoptionLifecycle?.onAbandoned()).then(() => {
        aborted.resolve();
        completed.resolve();
      }, aborted.reject);
    };
    if (turnAdoptionLifecycle) {
      turnAdoptionLifecycle.abortSignal.addEventListener("abort", onAbort, { once: true });
    }
    const lifecycle = turnAdoptionLifecycle
      ? {
          ...turnAdoptionLifecycle,
          onAdopted: async () => {
            await turnAdoptionLifecycle.onAdopted();
            admitted.resolve();
          },
          onDeferred: () => {
            const accepted = turnAdoptionLifecycle.onDeferred();
            if (accepted !== false) {
              admitted.resolve();
            }
            return accepted;
          },
        }
      : undefined;
    const lane = enqueue(sequentialKey, async () => {
      try {
        if (lifecycle?.abortSignal.aborted) {
          await lifecycle.onAbandoned();
          completed.resolve();
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
          turnAdoptionLifecycle: lifecycle,
          processingStatus,
        });
        trackTask?.(handling);
        void handling.then(completed.resolve, completed.reject);
        // Only ingress preparation/admission is FIFO. Core owns the active run
        // and steering/followup; full completion still owns reply and error cleanup.
        await Promise.race([admitted.promise, handling, aborted.promise]);
      } catch (err) {
        completed.reject(err);
        throw err;
      } finally {
        turnAdoptionLifecycle?.abortSignal.removeEventListener("abort", onAbort);
      }
    });
    void lane.catch(completed.reject);
    await completed.promise;
  };

  const resolveSenderDebounceId = (event: FeishuMessageEvent): string | undefined => {
    const senderId =
      event.sender.sender_id.open_id?.trim() || event.sender.sender_id.user_id?.trim();
    return senderId || undefined;
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
        const senderId = resolveSenderDebounceId(event);
        if (!chatId || !senderId) {
          return null;
        }
        const conversationKey = resolveSequentialKey({
          cfg: readConfig(),
          accountId,
          event,
          botOpenId: getBotOpenId(accountId),
        });
        return conversationKey;
      },
      canAppend: ({ event }, pending) =>
        resolveSenderDebounceId(event) === resolveSenderDebounceId(pending[0]?.event ?? event),
      serializeImmediate: true,
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
              await admissionLifecycle.onAbandoned();
              return;
            }
            try {
              if (activeEntries.length === 1) {
                await dispatchFeishuMessage(
                  last.event,
                  last.messageDedupeKey,
                  last.processingClaim,
                  admissionLifecycle,
                  undefined,
                  last.processingStatus,
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
              for (const entry of activeEntries) {
                if (entry !== dispatchEntry) {
                  entry.processingStatus?.settled();
                }
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
                  ...dispatchEntry.event,
                  message: {
                    ...dispatchEntry.event.message,
                    mentions: mergedMentions ?? dispatchEntry.event.message.mentions,
                  },
                },
                dispatchDedupeKey,
                dispatchEntry.processingClaim,
                admissionLifecycle,
                combinedText,
                dispatchEntry.processingStatus,
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
          entry.processingStatus?.abandoned();
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
      log(`feishu[${accountId}]: dropping self-authored message ${messageId ?? "unknown"}`);
      await completeSuppressedIngress();
      return undefined;
    }
    let processing: Promise<void> | undefined;
    let processingClaim: FeishuMessageProcessingClaim | undefined;
    let admissionResult:
      | { kind: "deferred" }
      | { kind: "failed-retryable"; error: unknown }
      | void = undefined;
    try {
      // Reserve receipt order before any asynchronous dedupe/hydration work.
      // The handoff does not await debounce admission or the complete agent run.
      await prepareReceipt(event.message.chat_id, async () => {
        const prepare = (async () => {
          if (!isAccountActive() || turnAdoptionLifecycle?.abortSignal.aborted) {
            await turnAdoptionLifecycle?.onAbandoned();
            return {
              kind: "failed-retryable" as const,
              error: new Error("feishu account stopped before message admission"),
            };
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
            await turnAdoptionLifecycle?.onAbandoned();
            return { kind: "failed-retryable" as const, error: stoppedError };
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

          processingClaim = claim.kind === "claimed" ? claim.handle : undefined;
          if (!isAccountActive() || turnAdoptionLifecycle?.abortSignal.aborted) {
            throw new Error("Feishu account stopped before topic preparation");
          }
          if (event.message.chat_type === "topic_group" && !event.message.thread_id?.trim()) {
            const currentCfg = readConfig();
            const feishuCfg = resolveFeishuAccount({ cfg: currentCfg, accountId }).config;
            const scope = resolveConfiguredFeishuGroupSessionScope({
              feishuCfg,
              groupConfig: resolveFeishuGroupConfig({
                cfg: feishuCfg,
                groupId: event.message.chat_id,
              }),
            });
            if (scope === "group_topic" || scope === "group_topic_sender") {
              const hydrationMessageId =
                event.message.reply_target_message_id?.trim() || event.message.message_id;
              const result = await raceWithTimeoutAndAbort(
                fetchMessage({ cfg: currentCfg, accountId, messageId: hydrationMessageId }),
                { timeoutMs: 10_000, abortSignal: turnAdoptionLifecycle?.abortSignal },
              );
              const info = result.status === "resolved" ? result.value : null;
              const threadId = info?.threadId?.trim();
              if (
                !threadId ||
                info?.chatId !== event.message.chat_id ||
                info.messageId !== hydrationMessageId
              ) {
                throw new Error("Feishu topic identity unavailable before ordered admission");
              }
              debounceEntry.event = {
                ...event,
                message: { ...event.message, thread_id: threadId },
              };
            }
          }
          if (!isAccountActive() || turnAdoptionLifecycle?.abortSignal.aborted) {
            throw new Error("Feishu account stopped before ordered admission");
          }
          if (event.sender.sender_type === "user" && processingIndicator) {
            try {
              const admittedEvent = debounceEntry.event;
              const topicId =
                admittedEvent.message.chat_type === "topic_group"
                  ? (admittedEvent.message.thread_id ?? admittedEvent.message.root_id)
                  : (admittedEvent.message.root_id ?? admittedEvent.message.thread_id);
              const status = processingIndicator.receive({
                messageCreateTimeMs: parseStrictNonNegativeInteger(event.message.create_time),
                messageId: event.message.message_id,
                chatId: event.message.chat_id,
                topicId,
                routeKey: JSON.stringify([accountId, event.message.chat_id, topicId ?? ""]),
              });
              debounceEntry.processingStatus = status;
              turnAdoptionLifecycle?.registerAbandonHandler?.(status.abandoned);
            } catch (indicatorError) {
              error(`feishu[${accountId}]: processing indicator failed: ${String(indicatorError)}`);
            }
          }
          processing = inboundDebouncer.enqueue(debounceEntry);
          void processing.catch(() => undefined);
          return { kind: "deferred" as const };
        })();
        trackTask?.(
          prepare.then(
            () => {},
            () => {},
          ),
        );
        const prepared = await raceWithTimeoutAndAbort(prepare, {
          abortSignal: turnAdoptionLifecycle?.abortSignal,
        });
        if (prepared.status === "resolved") {
          admissionResult = prepared.value;
        } else {
          await turnAdoptionLifecycle?.onAbandoned();
          admissionResult = {
            kind: "failed-retryable",
            error: new Error("feishu account stopped during message preparation"),
          };
        }
      });
      if (!processing) {
        return admissionResult;
      }
      if (turnAdoptionLifecycle || !fireAndForget) {
        await processing;
      } else {
        void processing.catch((err: unknown) => {
          processingClaim?.release({ error: err });
          error(`feishu[${accountId}]: error handling message: ${String(err)}`);
        });
      }
      return turnAdoptionLifecycle ? { kind: "deferred" } : undefined;
    } catch (err) {
      processingClaim?.release({ error: err });
      if (turnAdoptionLifecycle) {
        return { kind: "failed-retryable", error: err };
      }
      error(`feishu[${accountId}]: error handling message: ${String(err)}`);
    }

    return undefined;
  };
}
