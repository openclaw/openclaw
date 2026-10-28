import * as crypto from "node:crypto";
import type * as Lark from "@larksuiteoapi/node-sdk";
import { resolveGatewayPort } from "openclaw/plugin-sdk/gateway-config-runtime";
import {
  isRecord,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  readStringValue as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ClawdbotConfig, PluginRuntime, RuntimeEnv, HistoryEntry } from "../runtime-api.js";
import { raceWithTimeoutAndAbort } from "./async.js";
import {
  handleFeishuMessage,
  parseFeishuMessageEvent,
  type FeishuMessageEvent,
  type FeishuBotAddedEvent,
} from "./bot.js";
import { handleFeishuCardAction, type FeishuCardActionEvent } from "./card-action.js";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import { FEISHU_APPROVAL_REQUEST_ACTION } from "./card-ux-approval.js";
import {
  buildFeishuActionCard,
  buildFeishuCardButton,
  buildFeishuCardInteractionContext,
} from "./card-ux-shared.js";
import { createEventDispatcher } from "./client.js";
import {
  claimUnprocessedFeishuMessage,
  hasProcessedFeishuMessage,
  warmupDedupFromPluginState,
} from "./dedup.js";
import { createFeishuDurableIngress } from "./feishu-ingress.js";
import { applyBotIdentityState, startBotIdentityRecovery } from "./monitor.bot-identity.js";
import { createFeishuDriveCommentNoticeHandler } from "./monitor.comment-notice-handler.js";
import type { FeishuStatusSink } from "./monitor.js";
import { createFeishuMessageReceiveHandler } from "./monitor.message-handler.js";
import { fetchBotIdentityForMonitor } from "./monitor.startup.js";
import { botOpenIds } from "./monitor.state.js";
import { monitorWebhook, monitorWebSocket } from "./monitor.transport.js";
import { createFeishuVcMeetingInvitedHandler } from "./monitor.vc-meeting-invited-handler.js";
import { getFeishuRuntime } from "./runtime.js";
import { getMessageFeishu, sendCardFeishu } from "./send.js";
import { getFeishuSequentialKey } from "./sequential-key.js";
import { createFeishuThreadBindingManager } from "./thread-bindings.js";
import { normalizeFeishuEventChatType, type ResolvedFeishuAccount } from "./types.js";

const FEISHU_QUICK_ACTION_CARD_TTL_MS = 10 * 60_000;

const QUICK_ACTION_MENU_KEYS = new Set(["quick-actions", "quick_actions", "launcher"]);

const FEISHU_REACTION_VERIFY_TIMEOUT_MS = 1_500;

export type FeishuReactionCreatedEvent = {
  message_id: string;
  chat_id?: string;
  chat_type?: string;
  reaction_type?: { emoji_type?: string };
  operator_type?: string;
  user_id?: { open_id?: string; user_id?: string };
  action_time?: string;
};

type ResolveReactionSyntheticEventParams = {
  cfg: ClawdbotConfig;
  accountId: string;
  event: FeishuReactionCreatedEvent;
  botOpenId?: string;
  logger?: (message: string) => void;
  action?: "created" | "deleted";
};

export async function resolveReactionSyntheticEvent(
  params: ResolveReactionSyntheticEventParams,
): Promise<FeishuMessageEvent | null> {
  const { cfg, accountId, event, botOpenId, logger, action = "created" } = params;

  const emoji = event.reaction_type?.emoji_type;
  const messageId = event.message_id;
  const senderOpenId = event.user_id?.open_id?.trim();
  const senderUserId = event.user_id?.user_id?.trim();
  const senderId = senderOpenId || senderUserId;
  if (!emoji || !messageId || !senderId) {
    return null;
  }

  const { resolveFeishuAccount } = await import("./accounts.js");
  const account = resolveFeishuAccount({ cfg, accountId });
  const reactionNotifications = account.config.reactionNotifications;
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

  const reactedMsg = await raceWithTimeoutAndAbort(
    getMessageFeishu({ cfg, messageId, accountId }),
    {
      timeoutMs: FEISHU_REACTION_VERIFY_TIMEOUT_MS,
    },
  )
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

  const resolvedChatType = normalizeFeishuEventChatType(event.chat_type) ?? reactedMsg.chatType;
  if (!resolvedChatType) {
    logger?.(
      `feishu[${accountId}]: skipping reaction ${emoji} on ${messageId} without chat type context`,
    );
    return null;
  }

  const syntheticChatIdRaw = event.chat_id ?? reactedMsg.chatId;
  const syntheticChatId = syntheticChatIdRaw?.trim() ? syntheticChatIdRaw : `p2p:${senderId}`;
  return {
    sender: {
      sender_id: {
        ...(senderOpenId ? { open_id: senderOpenId } : {}),
        ...(senderUserId ? { user_id: senderUserId } : {}),
      },
      sender_type: "user",
    },
    message: {
      message_id: `${messageId}:reaction:${emoji}:${crypto.randomUUID()}`,
      // Synthetic IDs are local-only; replies and topic routing must retain the real message facts.
      reply_target_message_id: messageId,
      typing_target_message_id: messageId,
      ...(reactedMsg.rootId ? { root_id: reactedMsg.rootId } : {}),
      ...(reactedMsg.threadId ? { thread_id: reactedMsg.threadId } : {}),
      chat_id: syntheticChatId,
      chat_type: resolvedChatType,
      message_type: "text",
      content: JSON.stringify({
        text:
          action === "deleted"
            ? `[removed reaction ${emoji} from message ${messageId}]`
            : `[reacted with ${emoji} to message ${messageId}]`,
      }),
    },
  };
}

function parseFeishuBotAddedEventPayload(value: unknown): FeishuBotAddedEvent | null {
  if (!isRecord(value) || !readString(value.chat_id) || !isRecord(value.operator_id)) {
    return null;
  }
  return value as FeishuBotAddedEvent;
}

function parseFeishuBotRemovedChatId(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  return readString(value.chat_id) ?? null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const trimmed = normalizeOptionalString(value);
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function parseFeishuCardActionEventPayload(value: unknown): FeishuCardActionEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const operator = isRecord(value.operator) ? value.operator : {};
  const action = value.action;
  const context = isRecord(value.context) ? value.context : {};
  if (!isRecord(action)) {
    return null;
  }
  const operatorUserId = isRecord(operator.user_id) ? operator.user_id : undefined;
  const token = readString(value.token);
  const openId = firstString(
    operator.open_id,
    operatorUserId?.open_id,
    value.open_id,
    context.open_id,
  );
  const userId = firstString(
    operator.user_id,
    operatorUserId?.user_id,
    value.user_id,
    context.user_id,
  );
  const unionId = firstString(operator.union_id, operatorUserId?.union_id);
  const tag = readString(action.tag);
  const actionValue = action.value;
  // Prefer context.open_message_id (original card message) over value.open_message_id
  // which may be a temporary card-action-c-* ID that is not a valid Feishu message ID.
  const openMessageId = firstString(context.open_message_id, value.open_message_id);
  const contextOpenId = firstString(context.open_id, openId);
  const contextUserId = firstString(context.user_id, userId);
  const chatId = firstString(context.chat_id, context.open_chat_id);
  if (!token || !openId || !tag || !isRecord(actionValue)) {
    return null;
  }
  return {
    operator: {
      open_id: openId,
      ...(userId ? { user_id: userId } : {}),
      ...(unionId ? { union_id: unionId } : {}),
    },
    token,
    action: {
      value: actionValue,
      tag,
    },
    ...(openMessageId ? { open_message_id: openMessageId } : {}),
    context: {
      ...(openMessageId ? { open_message_id: openMessageId } : {}),
      ...(contextOpenId ? { open_id: contextOpenId } : {}),
      ...(contextUserId ? { user_id: contextUserId } : {}),
      ...(chatId ? { chat_id: chatId } : {}),
    },
  };
}

type BotOpenIdSource =
  | {
      kind: "prefetched";
      botOpenId?: string;
      source?: "provider" | "cache";
    }
  | { kind: "fetch" };

type MonitorSingleAccountParams = {
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
  channelRuntime?: PluginRuntime["channel"];
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  botOpenIdSource?: BotOpenIdSource;
  fireAndForget?: boolean;
  /**
   * Optional status sink for Feishu channel health. When provided, it is
   * propagated to the event dispatcher for message recency and the transport
   * layer for lifecycle status.
   */
  statusSink?: FeishuStatusSink;
};

export async function monitorSingleAccount(params: MonitorSingleAccountParams): Promise<void> {
  const { cfg, account, runtime, abortSignal } = params;
  const { accountId } = account;
  const log = runtime?.log ?? console.log;

  const botOpenIdSource = params.botOpenIdSource ?? { kind: "fetch" };
  const botIdentity =
    botOpenIdSource.kind === "prefetched"
      ? {
          botOpenId: botOpenIdSource.botOpenId,
          source: botOpenIdSource.source,
        }
      : await fetchBotIdentityForMonitor(account, { runtime, abortSignal });
  const botOpenId = applyBotIdentityState(accountId, botIdentity);
  log(`feishu[${accountId}]: bot open_id resolved: ${botOpenId ?? "unknown"}`);

  if ((!botOpenId || botIdentity.source === "cache") && !abortSignal?.aborted) {
    startBotIdentityRecovery({
      account,
      accountId,
      runtime,
      abortSignal,
      currentSource: botIdentity.source,
    });
  }

  const connectionMode = account.config.connectionMode;
  if (connectionMode === "webhook" && !account.verificationToken?.trim()) {
    throw new Error(`Feishu account "${accountId}" webhook mode requires verificationToken`);
  }
  if (connectionMode === "webhook" && !account.encryptKey?.trim()) {
    throw new Error(`Feishu account "${accountId}" webhook mode requires encryptKey`);
  }

  const warmupCount = await warmupDedupFromPluginState(accountId, log);
  if (abortSignal?.aborted) {
    return;
  }
  if (warmupCount > 0) {
    log(`feishu[${accountId}]: dedup warmup loaded ${warmupCount} entries from plugin state`);
  }

  let threadBindingManager: ReturnType<typeof createFeishuThreadBindingManager> | null | undefined;
  const accountStopped = new AbortController();
  const accountAbortSignal = abortSignal
    ? AbortSignal.any([abortSignal, accountStopped.signal])
    : accountStopped.signal;
  const pendingTasks = new Set<Promise<void>>();
  const trackTask = (task: Promise<void>) => {
    pendingTasks.add(task);
    void task.then(
      () => pendingTasks.delete(task),
      () => pendingTasks.delete(task),
    );
  };
  try {
    const eventDispatcher = createEventDispatcher(account);
    const durableIngress = createFeishuDurableIngress({
      accountId,
      dispatcher: eventDispatcher,
      ...(account.encryptKey ? { encryptKey: account.encryptKey } : {}),
      runtime: runtime ?? {},
    });
    const durableEventDispatcher = Object.assign(Object.create(eventDispatcher), {
      invoke: durableIngress.invoke,
    }) as Lark.EventDispatcher;
    const chatHistories = new Map<string, HistoryEntry[]>();
    threadBindingManager = createFeishuThreadBindingManager({ accountId, cfg });
    const channelRuntime = params.channelRuntime?.inbound
      ? params.channelRuntime
      : getFeishuRuntime().channel;

    const context = {
      cfg,
      accountId,
      channelRuntime,
      runtime,
      chatHistories,
      fireAndForget: params.fireAndForget ?? true,
      isAccountActive: () => !accountAbortSignal.aborted,
      trackTask,
      vcAutoJoin: account.config.vcAutoJoin === true,
      abortSignal: accountAbortSignal,
      resolveIngressLifecycle: durableIngress.resolveLifecycle,
      ...(params.statusSink ? { statusSink: params.statusSink } : {}),
    };
    const fireAndForget = context.fireAndForget;
    const eventLog = runtime?.log ?? console.log;
    const error = runtime?.error ?? console.error;
    const runFeishuHandler = async (operation: {
      task: () => Promise<void>;
      errorMessage: string;
    }) => {
      if (!context.isAccountActive()) {
        return;
      }
      const task = operation.task();
      context.trackTask(task);
      const handled = task.catch((err: unknown) => {
        error(`${operation.errorMessage}: ${String(err)}`);
      });
      if (!fireAndForget) {
        await handled;
      }
    };

    const handleReaction = (data: unknown, action: "created" | "deleted") =>
      runFeishuHandler({
        errorMessage: `feishu[${accountId}]: error handling reaction ${action === "deleted" ? "removal event" : "event"}`,
        task: async () => {
          const myBotId = botOpenIds.get(accountId);
          const syntheticEvent = await resolveReactionSyntheticEvent({
            cfg,
            accountId,
            event: data as FeishuReactionCreatedEvent,
            botOpenId: myBotId,
            logger: eventLog,
            action,
          });
          if (!syntheticEvent || !context.isAccountActive()) {
            return;
          }
          await handleFeishuMessage({
            trackTask: context.trackTask,
            cfg,
            event: syntheticEvent,
            botOpenId: myBotId,
            runtime,
            channelRuntime,
            chatHistories,
            accountId,
          });
        },
      });

    const handleBotMembership = async (data: unknown, action: "added" | "removed") => {
      try {
        const chatId =
          action === "added"
            ? parseFeishuBotAddedEventPayload(data)?.chat_id
            : parseFeishuBotRemovedChatId(data);
        if (chatId) {
          eventLog(
            `feishu[${accountId}]: bot ${action === "added" ? "added to" : "removed from"} chat ${chatId}`,
          );
        }
      } catch (err) {
        error(`feishu[${accountId}]: error handling bot ${action} event: ${String(err)}`);
      }
    };

    const handleBotMenu = async (data: unknown) => {
      try {
        if (!context.isAccountActive()) {
          return;
        }
        if (!isRecord(data) || !isRecord(data.operator) || !isRecord(data.operator.operator_id)) {
          return;
        }
        const operatorId = data.operator.operator_id;
        const operatorOpenId = readString(operatorId.open_id)?.trim();
        const eventKey = readString(data.event_key)?.trim();
        if (!operatorOpenId || !eventKey) {
          return;
        }
        const syntheticEvent: FeishuMessageEvent = {
          sender: {
            sender_id: {
              open_id: operatorOpenId,
              user_id: readString(operatorId.user_id),
              union_id: readString(operatorId.union_id),
            },
            sender_type: "user",
          },
          message: {
            message_id: `bot-menu:${eventKey}:${typeof data.timestamp === "string" || typeof data.timestamp === "number" ? data.timestamp : Date.now()}`,
            suppress_reply_target: true,
            chat_id: `p2p:${operatorOpenId}`,
            chat_type: "p2p",
            message_type: "text",
            content: JSON.stringify({
              text: `/menu ${eventKey}`,
            }),
          },
        };
        const syntheticMessageId = syntheticEvent.message.message_id;
        const claim = await claimUnprocessedFeishuMessage({
          messageId: syntheticMessageId,
          namespace: accountId,
          log: eventLog,
        });
        if (!context.isAccountActive()) {
          if (claim.kind === "claimed") {
            claim.handle.release({
              error: new Error("feishu account stopped before menu dispatch"),
            });
          }
          return;
        }
        if (claim.kind === "duplicate") {
          return;
        }
        if (claim.kind === "inflight") {
          return;
        }
        const handleLegacyMenu = () =>
          handleFeishuMessage({
            trackTask: context.trackTask,
            cfg,
            event: syntheticEvent,
            botOpenId: botOpenIds.get(accountId),
            runtime,
            channelRuntime,
            chatHistories,
            accountId,
            processingClaim: claim.kind === "claimed" ? claim.handle : undefined,
          });

        const promise = (async () => {
          let handledMenu = false;
          if (QUICK_ACTION_MENU_KEYS.has(normalizeOptionalLowercaseString(eventKey) ?? "")) {
            const expiresAt = Date.now() + FEISHU_QUICK_ACTION_CARD_TTL_MS;
            try {
              const launcherContext = buildFeishuCardInteractionContext({
                operatorOpenId,
                expiresAt,
                chatType: "p2p",
              });
              const approvalActions = [
                {
                  label: "New session",
                  type: "primary",
                  command: "/new",
                  prompt: "Start a fresh session? This will reset the current chat context.",
                },
                {
                  label: "Reset",
                  type: "danger",
                  command: "/reset",
                  prompt: "Reset this session now? Any active conversation state will be cleared.",
                },
              ] as const;
              await sendCardFeishu({
                cfg,
                to: `user:${operatorOpenId}`,
                card: buildFeishuActionCard({
                  title: "Quick actions",
                  template: "indigo",
                  content: "Run common actions without typing raw commands.",
                  actions: [
                    buildFeishuCardButton({
                      label: "Help",
                      value: createFeishuCardInteractionEnvelope({
                        k: "quick",
                        a: "feishu.quick_actions.help",
                        q: "/help",
                        c: launcherContext,
                      }),
                    }),
                    ...approvalActions.map(({ label, type, command, prompt }) =>
                      buildFeishuCardButton({
                        label,
                        type,
                        value: createFeishuCardInteractionEnvelope({
                          k: "meta",
                          a: FEISHU_APPROVAL_REQUEST_ACTION,
                          m: { command, prompt },
                          c: launcherContext,
                        }),
                      }),
                    ),
                  ],
                }),
                accountId,
              });
              handledMenu = true;
            } catch (err) {
              runtime?.log(
                `feishu[${accountId ?? "default"}]: failed to open quick-action launcher for ${operatorOpenId}: ${String(err)}`,
              );
            }
          }
          if (handledMenu) {
            runtime?.log(
              `feishu[${accountId ?? "default"}]: opened quick-action launcher for ${operatorOpenId}`,
            );
            if (claim.kind === "claimed") {
              await claim.handle.commit();
            }
            return;
          }
          if (!context.isAccountActive()) {
            if (claim.kind === "claimed") {
              claim.handle.release({
                error: new Error("feishu account stopped before menu dispatch"),
              });
            }
            return;
          }
          return handleLegacyMenu();
        })().catch(async (err: unknown) => {
          if (claim.kind === "claimed") {
            await claim.handle.commit();
          }
          throw err;
        });
        context.trackTask(promise);
        if (fireAndForget) {
          promise.catch((err: unknown) => {
            error(`feishu[${accountId}]: error handling bot menu event: ${String(err)}`);
          });
          return;
        }
        await promise;
      } catch (err) {
        error(`feishu[${accountId}]: error handling bot menu event: ${String(err)}`);
      }
    };

    eventDispatcher.register({
      "im.message.receive_v1": createFeishuMessageReceiveHandler({
        ...context,
        handleMessage: handleFeishuMessage,
        resolveDebounceText: ({ event, botOpenId: messageBotOpenId }) =>
          parseFeishuMessageEvent(event, messageBotOpenId).content,
        hasProcessedMessage: hasProcessedFeishuMessage,
        getBotOpenId: (id) => botOpenIds.get(id),
        resolveSequentialKey: getFeishuSequentialKey,
      }),
      "im.message.message_read_v1": async () => {
        // Ignore read receipts
      },
      "im.chat.access_event.bot_p2p_chat_entered_v1": async () => {
        // Ignore p2p chat entry notifications — no action needed
      },
      "im.chat.member.bot.added_v1": (data) => handleBotMembership(data, "added"),
      "im.chat.member.bot.deleted_v1": (data) => handleBotMembership(data, "removed"),
      "drive.notice.comment_add_v1": createFeishuDriveCommentNoticeHandler(context),
      "vc.bot.meeting_invited_v1": createFeishuVcMeetingInvitedHandler({
        ...context,
        autoJoin: context.vcAutoJoin,
      }),
      "im.message.reaction.created_v1": (data) => handleReaction(data, "created"),
      "im.message.reaction.deleted_v1": (data) => handleReaction(data, "deleted"),
      "application.bot.menu_v6": (data: unknown) => {
        const task = handleBotMenu(data);
        context.trackTask(task);
        return task;
      },
      "card.action.trigger": async (data: unknown) => {
        await runFeishuHandler({
          errorMessage: `feishu[${accountId}]: error handling card action`,
          task: async () => {
            const event = parseFeishuCardActionEventPayload(data);
            if (!event) {
              error(`feishu[${accountId}]: ignoring malformed card action payload`);
              return;
            }
            await handleFeishuCardAction({
              cfg,
              event,
              botOpenId: botOpenIds.get(accountId),
              runtime,
              channelRuntime,
              accountId,
              trackTask: context.trackTask,
            });
          },
        });
      },
    });

    try {
      durableIngress.start();
      if (connectionMode === "webhook") {
        return await monitorWebhook({
          gatewayPort: resolveGatewayPort(cfg),
          account,
          accountId,
          runtime,
          abortSignal,
          eventDispatcher: durableEventDispatcher,
          invokeWebhookEvent: durableIngress.invokeWebhook,
          ...(params.statusSink ? { statusSink: params.statusSink } : {}),
        });
      }
      return await monitorWebSocket({
        account,
        accountId,
        runtime,
        abortSignal,
        eventDispatcher: durableEventDispatcher,
        setSocketTerminator: durableIngress.setSocketTerminator,
        ...(params.statusSink ? { statusSink: params.statusSink } : {}),
      });
    } finally {
      accountStopped.abort(new Error("Feishu account stopped"));
      try {
        await durableIngress.stop();
      } finally {
        // A claim can register its detached settlement while the account is closing.
        while (pendingTasks.size > 0) {
          await Promise.allSettled(pendingTasks);
        }
      }
    }
  } finally {
    threadBindingManager?.stop();
  }
}
