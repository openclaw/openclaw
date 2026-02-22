import * as http from "http";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  type ClawdbotConfig,
  type RuntimeEnv,
  type HistoryEntry,
  installRequestBodyLimitGuard,
} from "openclaw/plugin-sdk";
import { resolveFeishuAccount, listEnabledFeishuAccounts } from "./accounts.js";
import { handleFeishuMessage, type FeishuMessageEvent, type FeishuBotAddedEvent } from "./bot.js";
import { createFeishuWSClient, createEventDispatcher } from "./client.js";
import { probeFeishu } from "./probe.js";
import type { ResolvedFeishuAccount } from "./types.js";
import { addReactionFeishu } from "./reactions.js";

export type MonitorFeishuOpts = {
  config?: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
};

// Per-account WebSocket clients, HTTP servers, and bot info
const wsClients = new Map<string, Lark.WSClient>();
const httpServers = new Map<string, http.Server>();
const botOpenIds = new Map<string, string>();
const FEISHU_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const FEISHU_WEBHOOK_BODY_TIMEOUT_MS = 30_000;

async function fetchBotOpenId(account: ResolvedFeishuAccount): Promise<string | undefined> {
  try {
    const result = await probeFeishu(account);
    return result.ok ? result.botOpenId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Register common event handlers on an EventDispatcher.
 * When fireAndForget is true (webhook mode), message handling is not awaited
 * to avoid blocking the HTTP response (Lark requires <3s response).
 */
function registerEventHandlers(
  eventDispatcher: Lark.EventDispatcher,
  context: {
    cfg: ClawdbotConfig;
    accountId: string;
    runtime?: RuntimeEnv;
    chatHistories: Map<string, HistoryEntry[]>;
    fireAndForget?: boolean;
  },
) {
  const { cfg, accountId, runtime, chatHistories, fireAndForget } = context;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  eventDispatcher.register({
    "im.message.receive_v1": async (data) => {
      try {
        const event = data as unknown as FeishuMessageEvent;
        const promise = handleFeishuMessage({
          cfg,
          event,
          botOpenId: botOpenIds.get(accountId),
          runtime,
          chatHistories,
          accountId,
        });
        if (fireAndForget) {
          promise.catch((err) => {
            error(`feishu[${accountId}]: error handling message: ${String(err)}`);
          });
        } else {
          await promise;
        }
      } catch (err) {
        error(`feishu[${accountId}]: error handling message: ${String(err)}`);
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
    // Reaction 事件：收到用户 emoji 时随机回一个
    "im.message.reaction.created_v1": async (data) => {
      try {
        const event = data as {
          message_id: string;
          reaction_type?: { emoji_type: string };
          operator_type?: string;
          user_id?: { open_id?: string; user_id?: string; union_id?: string };
        };
        const emoji = event.reaction_type?.emoji_type || "UNKNOWN";
        const reactorOpenId = event.user_id?.open_id || "";
        const myBotOpenId = botOpenIds.get(accountId) || "";

        // 过滤：忽略机器人自己的 reaction，避免无限循环
        const operatorType = event.operator_type || "";
        if (reactorOpenId === myBotOpenId || !reactorOpenId || operatorType === "app") {
          return;
        }

        log(`feishu[${accountId}]: reaction ${emoji} on message ${event.message_id} from ${reactorOpenId}`);

        // 智能回复：根据收到的 emoji 回复相关的 emoji
        const emojiPool: Record<string, string[]> = {
          THUMBSUP: ["FINGERHEART", "HEART", "SMILE", "CLAP"],
          HEART: ["FINGERHEART", "SMILE", "THUMBSUP"],
          FINGERHEART: ["HEART", "SMILE", "THUMBSUP"],
          SMILE: ["HEART", "FINGERHEART", "THUMBSUP"],
          CLAP: ["HEART", "FIRE", "THUMBSUP"],
          FIRE: ["PARTY", "CLAP", "THUMBSUP"],
          CRY: ["HEART", "FINGERHEART"],
        };
        const candidates = emojiPool[emoji] || ["HEART", "FINGERHEART", "SMILE"];
        const replyEmoji = candidates[Math.floor(Math.random() * candidates.length)];

        await addReactionFeishu({
          cfg,
          messageId: event.message_id,
          emojiType: replyEmoji,
          accountId,
        });
        log(`feishu[${accountId}]: auto-reacted ${replyEmoji} to ${event.message_id}`);
      } catch (err) {
        error(`feishu[${accountId}]: error handling reaction event: ${String(err)}`);
      }
    },
  });
}

type MonitorAccountParams = {
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
};

/**
 * Monitor a single Feishu account.
 */
async function monitorSingleAccount(params: MonitorAccountParams): Promise<void> {
  const { cfg, account, runtime, abortSignal } = params;
  const { accountId } = account;
  const log = runtime?.log ?? console.log;

  // Fetch bot open_id
  const botOpenId = await fetchBotOpenId(account);
  botOpenIds.set(accountId, botOpenId ?? "");
  log(`feishu[${accountId}]: bot open_id resolved: ${botOpenId ?? "unknown"}`);

  const connectionMode = account.config.connectionMode ?? "websocket";
  const eventDispatcher = createEventDispatcher(account);
  const chatHistories = new Map<string, HistoryEntry[]>();

  registerEventHandlers(eventDispatcher, {
    cfg,
    accountId,
    runtime,
    chatHistories,
    fireAndForget: connectionMode === "webhook",
  });

  if (connectionMode === "webhook") {
    return monitorWebhook({ params, accountId, eventDispatcher });
  }

  return monitorWebSocket({ params, accountId, eventDispatcher });
}

type ConnectionParams = {
  params: MonitorAccountParams;
  accountId: string;
  eventDispatcher: Lark.EventDispatcher;
};

async function monitorWebSocket({
  params,
  accountId,
  eventDispatcher,
}: ConnectionParams): Promise<void> {
  const { account, runtime, abortSignal } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  log(`feishu[${accountId}]: starting WebSocket connection...`);

  const wsClient = createFeishuWSClient(account);
  wsClients.set(accountId, wsClient);

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      wsClients.delete(accountId);
      botOpenIds.delete(accountId);
    };

    const handleAbort = () => {
      log(`feishu[${accountId}]: abort signal received, stopping`);
      cleanup();
      resolve();
    };

    if (abortSignal?.aborted) {
      cleanup();
      resolve();
      return;
    }

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    try {
      wsClient.start({ eventDispatcher });
      log(`feishu[${accountId}]: WebSocket client started`);
    } catch (err) {
      cleanup();
      abortSignal?.removeEventListener("abort", handleAbort);
      reject(err);
    }
  });
}

async function monitorWebhook({
  params,
  accountId,
  eventDispatcher,
}: ConnectionParams): Promise<void> {
  const { account, runtime, abortSignal } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const port = account.config.webhookPort ?? 3000;
  const path = account.config.webhookPath ?? "/feishu/events";

  log(`feishu[${accountId}]: starting Webhook server on port ${port}, path ${path}...`);

  const server = http.createServer();
  const webhookHandler = Lark.adaptDefault(path, eventDispatcher, { autoChallenge: true });
  server.on("request", (req, res) => {
    const guard = installRequestBodyLimitGuard(req, res, {
      maxBytes: FEISHU_WEBHOOK_MAX_BODY_BYTES,
      timeoutMs: FEISHU_WEBHOOK_BODY_TIMEOUT_MS,
      responseFormat: "text",
    });
    if (guard.isTripped()) {
      return;
    }
    void Promise.resolve(webhookHandler(req, res))
      .catch((err) => {
        if (!guard.isTripped()) {
          error(`feishu[${accountId}]: webhook handler error: ${String(err)}`);
        }
      })
      .finally(() => {
        guard.dispose();
      });
  });
  httpServers.set(accountId, server);

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.close();
      httpServers.delete(accountId);
      botOpenIds.delete(accountId);
    };

    const handleAbort = () => {
      log(`feishu[${accountId}]: abort signal received, stopping Webhook server`);
      cleanup();
      resolve();
    };

    if (abortSignal?.aborted) {
      cleanup();
      resolve();
      return;
    }

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    server.listen(port, () => {
      log(`feishu[${accountId}]: Webhook server listening on port ${port}`);
    });

    server.on("error", (err) => {
      error(`feishu[${accountId}]: Webhook server error: ${err}`);
      abortSignal?.removeEventListener("abort", handleAbort);
      reject(err);
    });
  });
}

/**
 * Main entry: start monitoring for all enabled accounts.
 */
export async function monitorFeishuProvider(opts: MonitorFeishuOpts = {}): Promise<void> {
  const cfg = opts.config;
  if (!cfg) {
    throw new Error("Config is required for Feishu monitor");
  }

  const log = opts.runtime?.log ?? console.log;

  // If accountId is specified, only monitor that account
  if (opts.accountId) {
    const account = resolveFeishuAccount({ cfg, accountId: opts.accountId });
    if (!account.enabled || !account.configured) {
      throw new Error(`Feishu account "${opts.accountId}" not configured or disabled`);
    }
    return monitorSingleAccount({
      cfg,
      account,
      runtime: opts.runtime,
      abortSignal: opts.abortSignal,
    });
  }

  // Otherwise, start all enabled accounts
  const accounts = listEnabledFeishuAccounts(cfg);
  if (accounts.length === 0) {
    throw new Error("No enabled Feishu accounts configured");
  }

  log(
    `feishu: starting ${accounts.length} account(s): ${accounts.map((a) => a.accountId).join(", ")}`,
  );

  // Start all accounts in parallel
  await Promise.all(
    accounts.map((account) =>
      monitorSingleAccount({
        cfg,
        account,
        runtime: opts.runtime,
        abortSignal: opts.abortSignal,
      }),
    ),
  );
}

/**
 * Stop monitoring for a specific account or all accounts.
 */
export function stopFeishuMonitor(accountId?: string): void {
  if (accountId) {
    wsClients.delete(accountId);
    const server = httpServers.get(accountId);
    if (server) {
      server.close();
      httpServers.delete(accountId);
    }
    botOpenIds.delete(accountId);
  } else {
    wsClients.clear();
    for (const server of httpServers.values()) {
      server.close();
    }
    httpServers.clear();
    botOpenIds.clear();
  }
}
