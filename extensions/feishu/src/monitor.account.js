import * as crypto from "crypto";
import { resolveFeishuAccount } from "./accounts.js";
import { raceWithTimeoutAndAbort } from "./async.js";
import {
  handleFeishuMessage,
  parseFeishuMessageEvent
} from "./bot.js";
import { handleFeishuCardAction } from "./card-action.js";
import { createEventDispatcher } from "./client.js";
import {
  hasProcessedFeishuMessage,
  recordProcessedFeishuMessage,
  releaseFeishuMessageProcessing,
  tryBeginFeishuMessageProcessing,
  warmupDedupFromDisk
} from "./dedup.js";
import { isMentionForwardRequest } from "./mention.js";
import { fetchBotIdentityForMonitor } from "./monitor.startup.js";
import { botNames, botOpenIds } from "./monitor.state.js";
import { monitorWebhook, monitorWebSocket } from "./monitor.transport.js";
import { getFeishuRuntime } from "./runtime.js";
import { getMessageFeishu } from "./send.js";
const FEISHU_REACTION_VERIFY_TIMEOUT_MS = 1500;
async function resolveReactionSyntheticEvent(params) {
  const {
    cfg,
    accountId,
    event,
    botOpenId,
    fetchMessage = getMessageFeishu,
    verificationTimeoutMs = FEISHU_REACTION_VERIFY_TIMEOUT_MS,
    logger,
    uuid = () => crypto.randomUUID(),
    action = "created"
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
      `feishu[${accountId}]: bot open_id unavailable, skipping reaction ${emoji} on ${messageId}`
    );
    return null;
  }
  const reactedMsg = await raceWithTimeoutAndAbort(fetchMessage({ cfg, messageId, accountId }), {
    timeoutMs: verificationTimeoutMs
  }).then((result) => result.status === "resolved" ? result.value : null).catch(() => null);
  const isBotMessage = reactedMsg?.senderType === "app" || reactedMsg?.senderOpenId === botOpenId;
  if (!reactedMsg || reactionNotifications === "own" && !isBotMessage) {
    logger?.(
      `feishu[${accountId}]: ignoring reaction on non-bot/unverified message ${messageId} (sender: ${reactedMsg?.senderOpenId ?? "unknown"})`
    );
    return null;
  }
  const fallbackChatType = reactedMsg.chatType;
  const normalizedEventChatType = normalizeFeishuChatType(event.chat_type);
  const resolvedChatType = normalizedEventChatType ?? fallbackChatType;
  if (!resolvedChatType) {
    logger?.(
      `feishu[${accountId}]: skipping reaction ${emoji} on ${messageId} without chat type context`
    );
    return null;
  }
  const syntheticChatIdRaw = event.chat_id ?? reactedMsg.chatId;
  const syntheticChatId = syntheticChatIdRaw?.trim() ? syntheticChatIdRaw : `p2p:${senderId}`;
  const syntheticChatType = resolvedChatType;
  return {
    sender: {
      sender_id: { open_id: senderId },
      sender_type: "user"
    },
    message: {
      message_id: `${messageId}:reaction:${emoji}:${uuid()}`,
      chat_id: syntheticChatId,
      chat_type: syntheticChatType,
      message_type: "text",
      content: JSON.stringify({
        text: action === "deleted" ? `[removed reaction ${emoji} from message ${messageId}]` : `[reacted with ${emoji} to message ${messageId}]`
      })
    }
  };
}
function normalizeFeishuChatType(value) {
  return value === "group" || value === "private" || value === "p2p" ? value : void 0;
}
function createChatQueue() {
  const queues = /* @__PURE__ */ new Map();
  return (chatId, task) => {
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
function mergeFeishuDebounceMentions(entries) {
  const merged = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    for (const mention of entry.message.mentions ?? []) {
      const stableId = mention.id.open_id?.trim() || mention.id.user_id?.trim() || mention.id.union_id?.trim();
      const mentionName = mention.name?.trim();
      const mentionKey = mention.key?.trim();
      const fallback = mentionName && mentionKey ? `${mentionName}|${mentionKey}` : mentionName || mentionKey;
      const key = stableId || fallback;
      if (!key || merged.has(key)) {
        continue;
      }
      merged.set(key, mention);
    }
  }
  if (merged.size === 0) {
    return void 0;
  }
  return Array.from(merged.values());
}
function dedupeFeishuDebounceEntriesByMessageId(entries) {
  const seen = /* @__PURE__ */ new Set();
  const deduped = [];
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
function resolveFeishuDebounceMentions(params) {
  const { entries, botOpenId } = params;
  if (entries.length === 0) {
    return void 0;
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (isMentionForwardRequest(entry, botOpenId)) {
      return mergeFeishuDebounceMentions([entry]);
    }
  }
  const merged = mergeFeishuDebounceMentions(entries);
  if (!merged) {
    return void 0;
  }
  const normalizedBotOpenId = botOpenId?.trim();
  if (!normalizedBotOpenId) {
    return void 0;
  }
  const botMentions = merged.filter(
    (mention) => mention.id.open_id?.trim() === normalizedBotOpenId
  );
  return botMentions.length > 0 ? botMentions : void 0;
}
function registerEventHandlers(eventDispatcher, context) {
  const { cfg, accountId, runtime, chatHistories, fireAndForget } = context;
  const core = getFeishuRuntime();
  const inboundDebounceMs = core.channel.debounce.resolveInboundDebounceMs({
    cfg,
    channel: "feishu"
  });
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;
  const enqueue = createChatQueue();
  const runFeishuHandler = async (params) => {
    if (fireAndForget) {
      void params.task().catch((err) => {
        error(`${params.errorMessage}: ${String(err)}`);
      });
      return;
    }
    try {
      await params.task();
    } catch (err) {
      error(`${params.errorMessage}: ${String(err)}`);
    }
  };
  const dispatchFeishuMessage = async (event) => {
    const chatId = event.message.chat_id?.trim() || "unknown";
    const task = () => handleFeishuMessage({
      cfg,
      event,
      botOpenId: botOpenIds.get(accountId),
      botName: botNames.get(accountId),
      runtime,
      chatHistories,
      accountId,
      processingClaimHeld: true
    });
    await enqueue(chatId, task);
  };
  const resolveSenderDebounceId = (event) => {
    const senderId = event.sender.sender_id.open_id?.trim() || event.sender.sender_id.user_id?.trim();
    return senderId || void 0;
  };
  const resolveDebounceText = (event) => {
    const botOpenId = botOpenIds.get(accountId);
    const parsed = parseFeishuMessageEvent(event, botOpenId, botNames.get(accountId));
    return parsed.content.trim();
  };
  const recordSuppressedMessageIds = async (entries, dispatchMessageId) => {
    const keepMessageId = dispatchMessageId?.trim();
    const suppressedIds = new Set(
      entries.map((entry) => entry.message.message_id?.trim()).filter((id) => Boolean(id) && (!keepMessageId || id !== keepMessageId))
    );
    if (suppressedIds.size === 0) {
      return;
    }
    for (const messageId of suppressedIds) {
      try {
        await recordProcessedFeishuMessage(messageId, accountId, log);
      } catch (err) {
        error(
          `feishu[${accountId}]: failed to record merged dedupe id ${messageId}: ${String(err)}`
        );
      }
    }
  };
  const isMessageAlreadyProcessed = async (entry) => {
    return await hasProcessedFeishuMessage(entry.message.message_id, accountId, log);
  };
  const inboundDebouncer = core.channel.debounce.createInboundDebouncer({
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
      return !core.channel.text.hasControlCommand(text, cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await dispatchFeishuMessage(last);
        return;
      }
      const dedupedEntries = dedupeFeishuDebounceEntriesByMessageId(entries);
      const freshEntries = [];
      for (const entry of dedupedEntries) {
        if (!await isMessageAlreadyProcessed(entry)) {
          freshEntries.push(entry);
        }
      }
      const dispatchEntry = freshEntries.at(-1);
      if (!dispatchEntry) {
        return;
      }
      await recordSuppressedMessageIds(dedupedEntries, dispatchEntry.message.message_id);
      const combinedText = freshEntries.map((entry) => resolveDebounceText(entry)).filter(Boolean).join("\n");
      const mergedMentions = resolveFeishuDebounceMentions({
        entries: freshEntries,
        botOpenId: botOpenIds.get(accountId)
      });
      if (!combinedText.trim()) {
        await dispatchFeishuMessage({
          ...dispatchEntry,
          message: {
            ...dispatchEntry.message,
            mentions: mergedMentions ?? dispatchEntry.message.mentions
          }
        });
        return;
      }
      await dispatchFeishuMessage({
        ...dispatchEntry,
        message: {
          ...dispatchEntry.message,
          message_type: "text",
          content: JSON.stringify({ text: combinedText }),
          mentions: mergedMentions ?? dispatchEntry.message.mentions
        }
      });
    },
    onError: (err, entries) => {
      for (const entry of entries) {
        releaseFeishuMessageProcessing(entry.message.message_id, accountId);
      }
      error(`feishu[${accountId}]: inbound debounce flush failed: ${String(err)}`);
    }
  });
  eventDispatcher.register({
    "im.message.receive_v1": async (data) => {
      const event = data;
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
    "im.message.message_read_v1": async () => {
    },
    "im.chat.member.bot.added_v1": async (data) => {
      try {
        const event = data;
        log(`feishu[${accountId}]: bot added to chat ${event.chat_id}`);
      } catch (err) {
        error(`feishu[${accountId}]: error handling bot added event: ${String(err)}`);
      }
    },
    "im.chat.member.bot.deleted_v1": async (data) => {
      try {
        const event = data;
        log(`feishu[${accountId}]: bot removed from chat ${event.chat_id}`);
      } catch (err) {
        error(`feishu[${accountId}]: error handling bot removed event: ${String(err)}`);
      }
    },
    "im.message.reaction.created_v1": async (data) => {
      await runFeishuHandler({
        errorMessage: `feishu[${accountId}]: error handling reaction event`,
        task: async () => {
          const event = data;
          const myBotId = botOpenIds.get(accountId);
          const syntheticEvent = await resolveReactionSyntheticEvent({
            cfg,
            accountId,
            event,
            botOpenId: myBotId,
            logger: log
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
            accountId
          });
          await promise;
        }
      });
    },
    "im.message.reaction.deleted_v1": async (data) => {
      await runFeishuHandler({
        errorMessage: `feishu[${accountId}]: error handling reaction removal event`,
        task: async () => {
          const event = data;
          const myBotId = botOpenIds.get(accountId);
          const syntheticEvent = await resolveReactionSyntheticEvent({
            cfg,
            accountId,
            event,
            botOpenId: myBotId,
            logger: log,
            action: "deleted"
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
            accountId
          });
          await promise;
        }
      });
    },
    "application.bot.menu_v6": async (data) => {
      try {
        const event = data;
        const operatorOpenId = event.operator?.operator_id?.open_id?.trim();
        const eventKey = event.event_key?.trim();
        if (!operatorOpenId || !eventKey) {
          return;
        }
        const syntheticEvent = {
          sender: {
            sender_id: {
              open_id: operatorOpenId,
              user_id: event.operator?.operator_id?.user_id,
              union_id: event.operator?.operator_id?.union_id
            },
            sender_type: "user"
          },
          message: {
            message_id: `bot-menu:${eventKey}:${event.timestamp ?? Date.now()}`,
            chat_id: `p2p:${operatorOpenId}`,
            chat_type: "p2p",
            message_type: "text",
            content: JSON.stringify({
              text: `/menu ${eventKey}`
            })
          }
        };
        const promise = handleFeishuMessage({
          cfg,
          event: syntheticEvent,
          botOpenId: botOpenIds.get(accountId),
          botName: botNames.get(accountId),
          runtime,
          chatHistories,
          accountId
        });
        if (fireAndForget) {
          promise.catch((err) => {
            error(`feishu[${accountId}]: error handling bot menu event: ${String(err)}`);
          });
          return;
        }
        await promise;
      } catch (err) {
        error(`feishu[${accountId}]: error handling bot menu event: ${String(err)}`);
      }
    },
    "card.action.trigger": async (data) => {
      try {
        const event = data;
        const promise = handleFeishuCardAction({
          cfg,
          event,
          botOpenId: botOpenIds.get(accountId),
          runtime,
          accountId
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
    }
  });
}
async function monitorSingleAccount(params) {
  const { cfg, account, runtime, abortSignal } = params;
  const { accountId } = account;
  const log = runtime?.log ?? console.log;
  const botOpenIdSource = params.botOpenIdSource ?? { kind: "fetch" };
  const botIdentity = botOpenIdSource.kind === "prefetched" ? { botOpenId: botOpenIdSource.botOpenId, botName: botOpenIdSource.botName } : await fetchBotIdentityForMonitor(account, { runtime, abortSignal });
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
  const chatHistories = /* @__PURE__ */ new Map();
  registerEventHandlers(eventDispatcher, {
    cfg,
    accountId,
    runtime,
    chatHistories,
    fireAndForget: true
  });
  if (connectionMode === "webhook") {
    return monitorWebhook({ account, accountId, runtime, abortSignal, eventDispatcher });
  }
  return monitorWebSocket({ account, accountId, runtime, abortSignal, eventDispatcher });
}
export {
  monitorSingleAccount,
  resolveReactionSyntheticEvent
};
