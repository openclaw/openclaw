import * as crypto from "crypto";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { ClawdbotConfig, RuntimeEnv, HistoryEntry } from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { raceWithTimeoutAndAbort } from "./async.js";
import {
  handleFeishuMessage,
  parseFeishuMessageEvent,
  type FeishuMessageEvent,
  type FeishuBotAddedEvent,
} from "./bot.js";
import { handleFeishuCardAction, type FeishuCardActionEvent } from "./card-action.js";
import { createEventDispatcher } from "./client.js";
import {
  hasProcessedFeishuMessage,
  recordProcessedFeishuMessage,
  releaseFeishuMessageProcessing,
  tryBeginFeishuMessageProcessing,
  tryRecordMessage,
  tryRecordMessagePersistent,
  warmupDedupFromDisk,
} from "./dedup.js";
import { isMentionForwardRequest } from "./mention.js";
import { fetchBotIdentityForMonitor } from "./monitor.startup.js";
import { botNames, botOpenIds } from "./monitor.state.js";
import { monitorWebhook, monitorWebSocket } from "./monitor.transport.js";
import { getFeishuRuntime } from "./runtime.js";
import { getMessageFeishu } from "./send.js";
import type { FeishuChatType, ResolvedFeishuAccount } from "./types.js";

const FEISHU_REACTION_VERIFY_TIMEOUT_MS = 1_500;

export type FeishuReactionCreatedEvent = {
  message_id: string;
  chat_id?: string;
  chat_type?: string;
  reaction_type?: { emoji_type?: string };
  operator_type?: string;
  user_id?: { open_id?: string };
  action_time?: string;
};

type ResolveReactionSyntheticEventParams = {
  cfg: ClawdbotConfig;
  accountId: string;
  event: FeishuReactionCreatedEvent;
  botOpenId?: string;
  fetchMessage?: typeof getMessageFeishu;
  verificationTimeoutMs?: number;
  logger?: (message: string) => void;
  uuid?: () => string;
};

export async function resolveReactionSyntheticEvent(
  params: ResolveReactionSyntheticEventParams,
): Promise<FeishuMessageEvent | null> {
  const {
    cfg,
    accountId,
    event,
    botOpenId,
    fetchMessage = getMessageFeishu,
    verificationTimeoutMs = FEISHU_REACTION_VERIFY_TIMEOUT_MS,
    logger,
    uuid = () => crypto.randomUUID(),
  } = params;

  const emoji = event.reaction_type?.emoji_type;
  const messageId = event.message_id;
  const senderId = event.user_id?.open_id;
  if (!emoji || !messageId || !senderId) {
    return null;
  }

  const account = resolveFeishuAccount({ cfg, accountId });
  const reactionNotifications = account.config.reactionNotifications ?? "own";
  if (reactionNotifications === "off") {
    return null;
  }

  if (event.operator_type === "app" || senderId === botOpenId) {
    return null;
  }

  if (emoji === "Typing") {
    return null;
  }

  if (reactionNotifications === "own" && !botOpenId) {
    logger?.(
      `feishu[${accountId}]: bot open_id unavailable, skipping reaction ${emoji} on ${messageId}`,
    );
    return null;
  }

  const reactedMsg = await raceWithTimeoutAndAbort(fetchMessage({ cfg, messageId, accountId }), {
    timeoutMs: verificationTimeoutMs,
  })
    .then((result) => (result.status === "resolved" ? result.value : null))
    .catch(() => null);
  const isBotMessage = reactedMsg?.senderType === "app" || reactedMsg?.senderOpenId === botOpenId;
  if (!reactedMsg || (reactionNotifications === "own" && !isBotMessage)) {
    logger?.(
      `feishu[${accountId}]: ignoring reaction on non-bot/unverified message ${messageId} ` +
        `(sender: ${reactedMsg?.senderOpenId ?? "unknown"})`,
    );
    return null;
  }

  const fallbackChatType = reactedMsg.chatType;
  const normalizedEventChatType = normalizeFeishuChatType(event.chat_type);
  const resolvedChatType = normalizedEventChatType ?? fallbackChatType;
  if (!resolvedChatType) {
    logger?.(
      `feishu[${accountId}]: skipping reaction ${emoji} on ${messageId} without chat type context`,
    );
    return null;
  }

  const syntheticChatIdRaw = event.chat_id ?? reactedMsg.chatId;
  const syntheticChatId = syntheticChatIdRaw?.trim() ? syntheticChatIdRaw : `p2p:${senderId}`;
  const syntheticChatType: FeishuChatType = resolvedChatType;
  return {
    sender: {
      sender_id: { open_id: senderId },
      sender_type: "user",
    },
    message: {
      message_id: `${messageId}:reaction:${emoji}:${uuid()}`,
      chat_id: syntheticChatId,
      chat_type: syntheticChatType,
      message_type: "text",
      content: JSON.stringify({
        text: `[reacted with ${emoji} to message ${messageId}]`,
      }),
    },
  };
}

function normalizeFeishuChatType(value: unknown): FeishuChatType | undefined {
  return value === "group" || value === "private" || value === "p2p" ? value : undefined;
}

type RegisterEventHandlersContext = {
  cfg: ClawdbotConfig;
  accountId: string;
  runtime?: RuntimeEnv;
  chatHistories: Map<string, HistoryEntry[]>;
  fireAndForget?: boolean;
};

/**
 * Per-chat serial queue that ensures messages from the same chat are processed
 * in arrival order while allowing different chats to run concurrently.
 */
function createChatQueue() {
  const queues = new Map<string, Promise<void>>();
  return (chatId: string, task: () => Promise<void>): Promise<void> => {
    const prev = queues.get(chatId) ?? Promise.resolve();
    const next = prev.then(task, task);
    queues.set(chatId, next);
    void next.finally(() => {
      if (queues.get(chatId) === next) {
        queues.delete(chatId);
      }
    });
    return next;
  };
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
  if (merged.size === 0) {
    return undefined;
  }
  return Array.from(merged.values());
}

function dedupeFeishuDebounceEntriesByMessageId(
  entries: FeishuMessageEvent[],
): FeishuMessageEvent[] {
  const seen = new Set<string>();
  const deduped: FeishuMessageEvent[] = [];
  for (const entry of entries) {
    const messageId = entry.message.message_id?.trim();
    if (!messageId) {
      deduped.push(entry);
      continue;
    }
    if (seen.has(messageId)) {
      continue;
    }
    seen.add(messageId);
    deduped.push(entry);
  }
  return deduped;
}

function resolveFeishuDebounceMentions(params: {
  entries: FeishuMessageEvent[];
  botOpenId?: string;
}): FeishuMessageEvent["message"]["mentions"] | undefined {
  const { entries, botOpenId } = params;
  if (entries.length === 0) {
    return undefined;
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (isMentionForwardRequest(entry, botOpenId)) {
      // Keep mention-forward semantics scoped to a single source message.
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

/** Max age (ms) for a message to be considered fresh in a debounce batch.
 * Messages older than this relative to the newest message in the batch are
 * dropped and their IDs recorded in dedup so Feishu retries are permanently
 * ignored. Matches TYPING_INDICATOR_MAX_AGE_MS from reply-dispatcher. */
const MESSAGE_STALE_AGE_MS = 2 * 60_000;
const MS_EPOCH_FLOOR = 1_000_000_000_000;

function parseCreateTimeMs(event: FeishuMessageEvent): number | undefined {
  const raw = event.message.create_time;
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // Feishu may send seconds or milliseconds — normalise to ms
  return n < MS_EPOCH_FLOOR ? n * 1000 : n;
}

/** Common abort trigger words recognised across languages.
 * Mirrors the ABORT_TRIGGERS set in auto-reply/reply/abort.ts so we can
 * detect them in the feishu extension without importing core internals. */
const FEISHU_ABORT_TRIGGERS = new Set([
  "stop",
  "/stop",
  "esc",
  "abort",
  "wait",
  "exit",
  "interrupt",
  "\u505c\u6b62",
  "\u505c",
  "\u53d6\u6d88",
  "\u3084\u3081\u3066",
  "\u6b62\u3081\u3066",
  "\u0441\u0442\u043e\u043f",
  "\u062a\u0648\u0642\u0641",
]);
const TRAILING_PUNCT_RE =
  /[.!?\u2026,\uff0c\u3002;\uff1b:\uff1a'"\u2018\u2019\u201c\u201d\uff09)\]\}]+$/u;

function isFeishuAbortTrigger(text: string | undefined): boolean {
  if (!text) return false;
  const normalized = text.trim().toLowerCase().replace(TRAILING_PUNCT_RE, "").trim();
  return FEISHU_ABORT_TRIGGERS.has(normalized);
}

function registerEventHandlers(
  eventDispatcher: Lark.EventDispatcher,
  context: RegisterEventHandlersContext,
): void {
  const { cfg, accountId, runtime, chatHistories, fireAndForget } = context;
  const core = getFeishuRuntime();
  const inboundDebounceMs = core.channel.debounce.resolveInboundDebounceMs({
    cfg,
    channel: "feishu",
  });
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;
  const enqueue = createChatQueue();

  /** Message IDs that were recalled.  Populated synchronously by the recall
   *  handler so the chatQueue pre-dispatch check can skip them even when the
   *  dedup cache entry hasn't been written yet (microtask-priority race). */
  const recalledMessageIds = new Set<string>();
  const RECALLED_ID_TTL_MS = 5 * 60_000;

  /** Normal dispatch - enters per-chat serial queue. */
  const dispatchFeishuMessage = async (event: FeishuMessageEvent, sourceMessageIds?: string[]) => {
    const chatId = event.message.chat_id?.trim() || "unknown";
    const task = async () => {
      // Yield to the event loop so pending recall events (macrotasks from
      // WebSocket) are processed before we check.  Without this yield, the
      // chatQueue's Promise .then() microtask drains first and the dedup /
      // recalledMessageIds entries written by the recall handler are not
      // visible yet.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      // Check if any source message in this dispatch was recalled while queued.
      const idsToCheck = sourceMessageIds?.length
        ? sourceMessageIds
        : [event.message.message_id?.trim()].filter((id): id is string => Boolean(id));
      for (const id of idsToCheck) {
        if (recalledMessageIds.has(id)) {
          log(`feishu[${accountId}]: skipping queued message — source message ${id} was recalled`);
          return;
        }
      }

      await handleFeishuMessage({
        cfg,
        event,
        botOpenId: botOpenIds.get(accountId),
        botName: botNames.get(accountId),
        runtime,
        chatHistories,
        accountId,
        processingClaimHeld: true,
      });
    };
    await enqueue(chatId, task);
  };

  /** Fast-path dispatch for abort commands - bypasses chatQueue so the abort
   *  is processed immediately even while a previous message is mid-flight.
   *  dispatchReplyFromConfig -> tryFastAbortFromMessage will detect the abort
   *  text and call abortEmbeddedPiRun + clearSessionQueues. */
  const dispatchFeishuMessageDirect = async (event: FeishuMessageEvent) => {
    log(`feishu[${accountId}]: fast-abort bypass - dispatching stop command directly (skip queue)`);
    try {
      await handleFeishuMessage({
        cfg,
        event,
        botOpenId: botOpenIds.get(accountId),
        botName: botNames.get(accountId),
        runtime,
        chatHistories,
        accountId,
      });
    } catch (err) {
      error(`feishu[${accountId}]: fast-abort dispatch failed: ${String(err)}`);
    }
  };
  const resolveSenderDebounceId = (event: FeishuMessageEvent): string | undefined => {
    const senderId =
      event.sender.sender_id.open_id?.trim() || event.sender.sender_id.user_id?.trim();
    return senderId || undefined;
  };
  const resolveDebounceText = (event: FeishuMessageEvent): string => {
    const botOpenId = botOpenIds.get(accountId);
    const parsed = parseFeishuMessageEvent(event, botOpenId, botNames.get(accountId));
    return parsed.content.trim();
  };
  const recordSuppressedMessageIds = async (
    entries: FeishuMessageEvent[],
    dispatchMessageId?: string,
  ) => {
    const keepMessageId = dispatchMessageId?.trim();
    const suppressedIds = new Set(
      entries
        .map((entry) => entry.message.message_id?.trim())
        .filter((id): id is string => Boolean(id) && (!keepMessageId || id !== keepMessageId)),
    );
    if (suppressedIds.size === 0) {
      return;
    }
    for (const messageId of suppressedIds) {
      try {
        await recordProcessedFeishuMessage(messageId, accountId, log);
      } catch (err) {
        error(
          `feishu[${accountId}]: failed to record merged dedupe id ${messageId}: ${String(err)}`,
        );
      }
    }
  };
  const isMessageAlreadyProcessed = async (entry: FeishuMessageEvent): Promise<boolean> => {
    return await hasProcessedFeishuMessage(entry.message.message_id, accountId, log);
  };
  const inboundDebouncer = core.channel.debounce.createInboundDebouncer<FeishuMessageEvent>({
    debounceMs: inboundDebounceMs,
    buildKey: (event) => {
      const chatId = event.message.chat_id?.trim();
      const senderId = resolveSenderDebounceId(event);
      if (!chatId || !senderId) {
        return null;
      }
      const rootId = event.message.root_id?.trim();
      const threadKey = rootId ? `thread:${rootId}` : "chat";
      return `feishu:${accountId}:${chatId}:${threadKey}:${senderId}`;
    },
    shouldDebounce: (event) => {
      if (event.message.message_type !== "text") {
        return false;
      }
      const text = resolveDebounceText(event);
      if (!text) {
        return false;
      }
      return !core.channel.text.hasControlCommand(text, cfg) && !isFeishuAbortTrigger(text);
    },
    onFlush: async (entries) => {
      // --- Fast abort check: if a single abort trigger, bypass queue ---
      if (entries.length === 1) {
        const text = resolveDebounceText(entries[0]);
        if (isFeishuAbortTrigger(text)) {
          await dispatchFeishuMessageDirect(entries[0]);
          return;
        }
      }

      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await dispatchFeishuMessage(last);
        return;
      }
      const dedupedEntries = dedupeFeishuDebounceEntriesByMessageId(entries);
      const freshEntries: FeishuMessageEvent[] = [];
      for (const entry of dedupedEntries) {
        // Skip messages recalled between debounce-enqueue and flush.
        const entryMsgId = entry.message.message_id?.trim();
        if (entryMsgId && recalledMessageIds.has(entryMsgId)) {
          log(`feishu[${accountId}]: filtering recalled message ${entryMsgId} from debounce batch`);
          tryRecordMessage(`${accountId}:${entryMsgId}`);
          continue;
        }
        if (!(await isMessageAlreadyProcessed(entry))) {
          freshEntries.push(entry);
        }
      }

      // --- Stale message filtering ---
      // When the batch contains messages with a large time gap (e.g. network
      // drop followed by reconnect), drop old messages and record their IDs
      // in dedup so future Feishu retries are permanently ignored.
      if (freshEntries.length > 1) {
        const newestTime = Math.max(...freshEntries.map((e) => parseCreateTimeMs(e) ?? 0));
        if (newestTime > 0) {
          const staleEntries = freshEntries.filter((e) => {
            const ct = parseCreateTimeMs(e);
            return ct !== undefined && newestTime - ct > MESSAGE_STALE_AGE_MS;
          });
          if (staleEntries.length > 0 && staleEntries.length < freshEntries.length) {
            const staleIds = new Set(
              staleEntries.map((e) => e.message.message_id?.trim()).filter(Boolean),
            );
            log(
              `feishu[${accountId}]: dropping ${staleEntries.length} stale message(s) ` +
                `superseded by newer messages in debounce batch`,
            );
            // Record stale IDs in dedup so Feishu retries are permanently rejected
            await recordSuppressedMessageIds(staleEntries);
            // Remove stale entries from the batch
            for (let i = freshEntries.length - 1; i >= 0; i--) {
              const mid = freshEntries[i].message.message_id?.trim();
              if (mid && staleIds.has(mid)) {
                freshEntries.splice(i, 1);
              }
            }
          }
        }
      }

      const dispatchEntry = freshEntries.at(-1);
      if (!dispatchEntry) {
        return;
      }
      await recordSuppressedMessageIds(dedupedEntries, dispatchEntry.message.message_id);
      // Collect all source message IDs so the chatQueue pre-dispatch check
      // can skip the merged message if any source was recalled while queued.
      const sourceMessageIds = freshEntries
        .map((e) => e.message.message_id?.trim())
        .filter((id): id is string => Boolean(id));
      const combinedText = freshEntries
        .map((entry) => resolveDebounceText(entry))
        .filter(Boolean)
        .join("\n");
      const mergedMentions = resolveFeishuDebounceMentions({
        entries: freshEntries,
        botOpenId: botOpenIds.get(accountId),
      });
      if (!combinedText.trim()) {
        await dispatchFeishuMessage(
          {
            ...dispatchEntry,
            message: {
              ...dispatchEntry.message,
              mentions: mergedMentions ?? dispatchEntry.message.mentions,
            },
          },
          sourceMessageIds,
        );
        return;
      }
      await dispatchFeishuMessage(
        {
          ...dispatchEntry,
          message: {
            ...dispatchEntry.message,
            message_type: "text",
            content: JSON.stringify({ text: combinedText }),
            mentions: mergedMentions ?? dispatchEntry.message.mentions,
          },
        },
        sourceMessageIds,
      );
    },
    onError: (err, entries) => {
      for (const entry of entries) {
        releaseFeishuMessageProcessing(entry.message.message_id, accountId);
      }
      error(`feishu[${accountId}]: inbound debounce flush failed: ${String(err)}`);
    },
  });

  eventDispatcher.register({
    "im.message.receive_v1": async (data) => {
      const event = data as unknown as FeishuMessageEvent;
      const messageId = event.message?.message_id?.trim();
      if (!tryBeginFeishuMessageProcessing(messageId, accountId)) {
        log(`feishu[${accountId}]: dropping duplicate event for message ${messageId}`);
        return;
      }
      const processMessage = async () => {
        await inboundDebouncer.enqueue(event);
      };
      if (fireAndForget) {
        void processMessage().catch((err) => {
          releaseFeishuMessageProcessing(messageId, accountId);
          error(`feishu[${accountId}]: error handling message: ${String(err)}`);
        });
        return;
      }
      try {
        await processMessage();
      } catch (err) {
        releaseFeishuMessageProcessing(messageId, accountId);
        error(`feishu[${accountId}]: error handling message: ${String(err)}`);
      }
    },
    "im.message.recalled_v1": async (data) => {
      try {
        const event = data as unknown as {
          message_id: string;
          chat_id: string;
          chat_type?: string;
          operator_id?: { open_id?: string; user_id?: string };
        };
        const recalledMessageId = event.message_id?.trim();
        if (!recalledMessageId) return;
        log(`feishu[${accountId}]: message recalled: ${recalledMessageId}`);
        recalledMessageIds.add(recalledMessageId);
        const recallCleanupTimer = setTimeout(
          () => recalledMessageIds.delete(recalledMessageId),
          RECALLED_ID_TTL_MS,
        );
        recallCleanupTimer.unref?.();

        // Layer 1: Remove from debounce buffer (message not yet dispatched)
        const removedCount = inboundDebouncer.removeFromBuffer(
          (entry) => entry.message.message_id?.trim() === recalledMessageId,
        );
        if (removedCount > 0) {
          log(`feishu[${accountId}]: removed recalled message from debounce buffer`);
        }

        // Record in dedup so future retries are permanently ignored
        tryRecordMessage(`${accountId}:${recalledMessageId}`);
        try {
          await tryRecordMessagePersistent(recalledMessageId, accountId, log);
        } catch (err) {
          error(`feishu[${accountId}]: failed to record recalled message dedup: ${String(err)}`);
        }

        // Layer 2+3: Synthesize a /stop command from the recaller to abort any
        // in-flight processing. dispatchFeishuMessageDirect bypasses the queue
        // and tryFastAbortFromMessage will detect "/stop" and call
        // abortEmbeddedPiRun + clearSessionQueues.
        const chatId = event.chat_id?.trim();
        const operatorOpenId = event.operator_id?.open_id?.trim();
        if (chatId && operatorOpenId) {
          const syntheticStopEvent: FeishuMessageEvent = {
            sender: {
              sender_id: {
                open_id: operatorOpenId,
                user_id: event.operator_id?.user_id?.trim() ?? "",
                union_id: "",
              },
              sender_type: "user",
            },
            message: {
              message_id: `recall-stop-${recalledMessageId}`,
              chat_id: chatId,
              chat_type: (event.chat_type ?? "p2p") as "p2p" | "group",
              message_type: "text",
              content: JSON.stringify({ text: "/stop" }),
              create_time: String(Date.now()),
            },
          };
          log(`feishu[${accountId}]: dispatching synthetic /stop for recalled message`);
          await dispatchFeishuMessageDirect(syntheticStopEvent);
        }
      } catch (err) {
        error(`feishu[${accountId}]: error handling recall event: ${String(err)}`);
      }
    },
    "im.message.message_read_v1": async () => {
      // Ignore read receipts
    },
    "im.chat.member.bot.added_v1": async (data) => {
      try {
        const event = data as unknown as FeishuBotAddedEvent;
        log(`feishu[${accountId}]: bot added to chat ${event.chat_id}`);
      } catch (err) {
        error(`feishu[${accountId}]: error handling bot added event: ${String(err)}`);
      }
    },
    "im.chat.member.bot.deleted_v1": async (data) => {
      try {
        const event = data as unknown as { chat_id: string };
        log(`feishu[${accountId}]: bot removed from chat ${event.chat_id}`);
      } catch (err) {
        error(`feishu[${accountId}]: error handling bot removed event: ${String(err)}`);
      }
    },
    "im.message.reaction.created_v1": async (data) => {
      const processReaction = async () => {
        const event = data as FeishuReactionCreatedEvent;
        const myBotId = botOpenIds.get(accountId);
        const syntheticEvent = await resolveReactionSyntheticEvent({
          cfg,
          accountId,
          event,
          botOpenId: myBotId,
          logger: log,
        });
        if (!syntheticEvent) {
          return;
        }
        const promise = handleFeishuMessage({
          cfg,
          event: syntheticEvent,
          botOpenId: myBotId,
          botName: botNames.get(accountId),
          runtime,
          chatHistories,
          accountId,
        });
        if (fireAndForget) {
          promise.catch((err) => {
            error(`feishu[${accountId}]: error handling reaction: ${String(err)}`);
          });
          return;
        }
        await promise;
      };

      if (fireAndForget) {
        void processReaction().catch((err) => {
          error(`feishu[${accountId}]: error handling reaction event: ${String(err)}`);
        });
        return;
      }

      try {
        await processReaction();
      } catch (err) {
        error(`feishu[${accountId}]: error handling reaction event: ${String(err)}`);
      }
    },
    "im.message.reaction.deleted_v1": async () => {
      // Ignore reaction removals
    },
    "card.action.trigger": async (data: unknown) => {
      try {
        const event = data as unknown as FeishuCardActionEvent;
        const promise = handleFeishuCardAction({
          cfg,
          event,
          botOpenId: botOpenIds.get(accountId),
          runtime,
          accountId,
        });
        if (fireAndForget) {
          promise.catch((err) => {
            error(`feishu[${accountId}]: error handling card action: ${String(err)}`);
          });
        } else {
          await promise;
        }
      } catch (err) {
        error(`feishu[${accountId}]: error handling card action: ${String(err)}`);
      }
    },
  });
}

export type BotOpenIdSource =
  | { kind: "prefetched"; botOpenId?: string; botName?: string }
  | { kind: "fetch" };

export type MonitorSingleAccountParams = {
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  botOpenIdSource?: BotOpenIdSource;
};

export async function monitorSingleAccount(params: MonitorSingleAccountParams): Promise<void> {
  const { cfg, account, runtime, abortSignal } = params;
  const { accountId } = account;
  const log = runtime?.log ?? console.log;

  const botOpenIdSource = params.botOpenIdSource ?? { kind: "fetch" };
  const botIdentity =
    botOpenIdSource.kind === "prefetched"
      ? { botOpenId: botOpenIdSource.botOpenId, botName: botOpenIdSource.botName }
      : await fetchBotIdentityForMonitor(account, { runtime, abortSignal });
  const botOpenId = botIdentity.botOpenId;
  const botName = botIdentity.botName?.trim();
  botOpenIds.set(accountId, botOpenId ?? "");
  if (botName) {
    botNames.set(accountId, botName);
  } else {
    botNames.delete(accountId);
  }
  log(`feishu[${accountId}]: bot open_id resolved: ${botOpenId ?? "unknown"}`);

  const connectionMode = account.config.connectionMode ?? "websocket";
  if (connectionMode === "webhook" && !account.verificationToken?.trim()) {
    throw new Error(`Feishu account "${accountId}" webhook mode requires verificationToken`);
  }
  if (connectionMode === "webhook" && !account.encryptKey?.trim()) {
    throw new Error(`Feishu account "${accountId}" webhook mode requires encryptKey`);
  }

  const warmupCount = await warmupDedupFromDisk(accountId, log);
  if (warmupCount > 0) {
    log(`feishu[${accountId}]: dedup warmup loaded ${warmupCount} entries from disk`);
  }

  const eventDispatcher = createEventDispatcher(account);
  const chatHistories = new Map<string, HistoryEntry[]>();

  registerEventHandlers(eventDispatcher, {
    cfg,
    accountId,
    runtime,
    chatHistories,
    fireAndForget: true,
  });

  if (connectionMode === "webhook") {
    return monitorWebhook({ account, accountId, runtime, abortSignal, eventDispatcher });
  }
  return monitorWebSocket({ account, accountId, runtime, abortSignal, eventDispatcher });
}
