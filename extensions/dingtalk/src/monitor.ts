/**
 * 钉钉 Stream 连接管理
 *
 * 使用 dingtalk-stream SDK 建立持久连接接收消息
 *
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DWClient, TOPIC_ROBOT } from "dingtalk-stream";
import { handleDingtalkMessage } from "./bot.js";
import { createDingtalkClientFromConfig } from "./client.js";
import type { DingtalkConfig } from "./config.js";
import {
  handleCardCallback,
  isCardCallbackEvent,
  parseCardCallbackData,
} from "./jarvis-card-callback.js";
import { createLogger, type Logger } from "./logger.js";
import type { DingtalkRawMessage } from "./types.js";

/**
 * Monitor 配置选项
 */
export interface MonitorDingtalkOpts {
  /** 钉钉渠道配置 */
  config?: {
    channels?: {
      dingtalk?: DingtalkConfig;
    };
  };
  /** 运行时环境 */
  runtime?: {
    log?: (msg: string) => void;
    error?: (msg: string) => void;
  };
  /** 中断信号，用于优雅关闭 */
  abortSignal?: AbortSignal;
  /** 账户 ID */
  accountId?: string;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

async function ensureGatewayHttpEnabled(params: {
  dingtalkCfg?: DingtalkConfig;
  logger: Logger;
}): Promise<void> {
  const { dingtalkCfg, logger } = params;
  if (!dingtalkCfg?.enableAICard) return;

  const home = os.homedir();
  const candidates = [
    path.join(home, ".openclaw", "openclaw.json"),
    path.join(home, ".openclaw", "config.json"),
  ];

  for (const filePath of candidates) {
    try {
      await fs.access(filePath);
    } catch {
      continue;
    }

    try {
      const raw = await fs.readFile(filePath, "utf8");
      const cleaned = raw.replace(/^\uFEFF/, "").trim();
      if (!cleaned) continue;

      const cfg = JSON.parse(cleaned) as Record<string, unknown>;
      const gateway = toRecord(cfg.gateway);
      const http = toRecord(gateway.http);
      const endpoints = toRecord(http.endpoints);
      const chatCompletions = toRecord(endpoints.chatCompletions);

      if (chatCompletions.enabled === true) {
        logger.debug(`[gateway] chatCompletions already enabled in ${filePath}`);
        return;
      }

      chatCompletions.enabled = true;
      endpoints.chatCompletions = chatCompletions;
      http.endpoints = endpoints;
      gateway.http = http;
      cfg.gateway = gateway;

      const output = JSON.stringify(cfg, null, 2);
      await fs.writeFile(filePath, `${output}\n`, "utf8");
      logger.info(`[gateway] enabled http.endpoints.chatCompletions in ${filePath}`);
      logger.info("[gateway] restart OpenClaw gateway to apply HTTP endpoint change");
      return;
    } catch (err) {
      logger.warn(`[gateway] failed to update ${filePath}: ${String(err)}`);
    }
  }

  logger.warn("[gateway] openclaw config not found; cannot auto-enable http endpoint");
}

/** 当前活跃的 Stream 客户端 */
let currentClient: DWClient | null = null;

/** 当前活跃连接的账户 ID */
let currentAccountId: string | null = null;

/** 当前 Monitor Promise */
let currentPromise: Promise<void> | null = null;

/** 停止当前 Monitor */
let currentStop: (() => void) | null = null;

/** 消息去重缓存：streamMessageId -> 处理时间戳 */
const processedMessages = new Map<string, number>();

/** 内容指纹去重缓存：fingerprint -> 处理时间戳 */
const processedFingerprints = new Map<string, number>();

/** 去重缓存过期时间（毫秒） */
const MESSAGE_DEDUP_TTL_MS = 60000;

/** 内容指纹去重时间窗口（毫秒）— 同一用户在同一会话中发送相同内容的消息在此窗口内视为重复。
 * 设为 10 秒以覆盖慢任务场景下钉钉 Stream 的延迟重推。 */
const CONTENT_DEDUP_WINDOW_MS = 10_000;

/**
 * 启动钉钉 Stream 连接监控
 *
 * 使用 DWClient 建立 Stream 连接，注册 TOPIC_ROBOT 回调处理消息。
 * 支持 abortSignal 进行优雅关闭。
 *
 * @param opts 监控配置选项
 * @returns Promise<void> 连接关闭时 resolve
 * @throws Error 如果凭证未配置
 */
export async function monitorDingtalkProvider(opts: MonitorDingtalkOpts = {}): Promise<void> {
  const { config, runtime, abortSignal, accountId = "default" } = opts;

  const logger: Logger = createLogger("dingtalk", {
    log: runtime?.log,
    error: runtime?.error,
  });

  // Single-account: only one active connection allowed.
  if (currentClient) {
    if (currentAccountId && currentAccountId !== accountId) {
      throw new Error(`DingTalk already running for account ${currentAccountId}`);
    }
    logger.debug(`existing connection for account ${accountId} is active, reusing monitor`);
    if (currentPromise) {
      return currentPromise;
    }
    throw new Error("DingTalk monitor state invalid: active client without promise");
  }

  // Get DingTalk config.
  const dingtalkCfg = config?.channels?.dingtalk;
  if (!dingtalkCfg) {
    throw new Error("DingTalk configuration not found");
  }

  await ensureGatewayHttpEnabled({ dingtalkCfg, logger });

  // Create Stream client.
  let client: DWClient;
  try {
    client = createDingtalkClientFromConfig(dingtalkCfg);
  } catch (err) {
    logger.error(`failed to create client: ${String(err)}`);
    throw err;
  }

  currentClient = client;
  currentAccountId = accountId;

  logger.info(`starting Stream connection for account ${accountId}...`);

  currentPromise = new Promise<void>((resolve, reject) => {
    let stopped = false;

    // Cleanup state and disconnect the client.
    const cleanup = () => {
      if (currentClient === client) {
        currentClient = null;
        currentAccountId = null;
        currentStop = null;
        currentPromise = null;
      }
      try {
        client.disconnect();
      } catch (err) {
        logger.error(`failed to disconnect client: ${String(err)}`);
      }
    };

    const finalizeResolve = () => {
      if (stopped) return;
      stopped = true;
      abortSignal?.removeEventListener("abort", handleAbort);
      cleanup();
      resolve();
    };

    const finalizeReject = (err: unknown) => {
      if (stopped) return;
      stopped = true;
      abortSignal?.removeEventListener("abort", handleAbort);
      cleanup();
      reject(err);
    };

    // Handle abort signal.
    const handleAbort = () => {
      logger.info("abort signal received, stopping Stream client");
      finalizeResolve();
    };

    // Expose a stop hook for manual shutdown.
    currentStop = () => {
      logger.info("stop requested, stopping Stream client");
      finalizeResolve();
    };

    // If already aborted, resolve immediately.
    if (abortSignal?.aborted) {
      finalizeResolve();
      return;
    }

    // Register abort handler.
    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    try {
      // Register TOPIC_ROBOT callback.
      client.registerCallbackListener(TOPIC_ROBOT, (res) => {
        const streamMessageId = res?.headers?.messageId;

        // 立即显式 ACK，防止钉钉重发消息
        if (streamMessageId) {
          try {
            client.socketCallBackResponse(streamMessageId, { success: true });
          } catch (ackErr) {
            logger.error(`failed to ACK message ${streamMessageId}: ${String(ackErr)}`);
          }
        }

        // 消息去重检查
        if (streamMessageId) {
          const now = Date.now();
          const lastProcessed = processedMessages.get(streamMessageId);
          if (lastProcessed && now - lastProcessed < MESSAGE_DEDUP_TTL_MS) {
            logger.debug(`duplicate message ignored: ${streamMessageId}`);
            return;
          }
          processedMessages.set(streamMessageId, now);

          // 清理过期条目（每次处理时清理，避免内存泄漏）
          for (const [id, time] of processedMessages) {
            if (now - time > MESSAGE_DEDUP_TTL_MS) {
              processedMessages.delete(id);
            }
          }
        }

        try {
          // Parse message payload.
          const rawMessage = JSON.parse(res.data) as DingtalkRawMessage;
          if (streamMessageId) {
            rawMessage.streamMessageId = streamMessageId;
          }

          // 关键业务日志：收到消息
          // content 可能是字符串或对象，需要处理
          let contentText = "";
          if (rawMessage.msgtype === "text" && rawMessage.text?.content) {
            contentText = rawMessage.text.content;
          } else if (rawMessage.content) {
            const contentObj =
              typeof rawMessage.content === "string"
                ? (() => {
                    try {
                      return JSON.parse(rawMessage.content);
                    } catch {
                      return null;
                    }
                  })()
                : rawMessage.content;
            if (
              contentObj &&
              typeof contentObj === "object" &&
              "recognition" in contentObj &&
              typeof contentObj.recognition === "string"
            ) {
              contentText = contentObj.recognition;
            }
          }
          const contentTrimmed = contentText.trim();
          const senderName = rawMessage.senderNick ?? rawMessage.senderId;
          const textPreview = contentTrimmed.slice(0, 50);
          logger.info(
            `Inbound: from=${senderName} text="${textPreview}${contentTrimmed.length > 50 ? "..." : ""}"`,
          );
          logger.debug(`streamId=${streamMessageId ?? "none"} convo=${rawMessage.conversationId}`);

          // 内容指纹去重：同一用户在同一会话中短时间内发送相同内容视为重复推送
          const senderId = rawMessage.senderId ?? rawMessage.senderStaffId ?? "";
          const conversationId = rawMessage.conversationId ?? "";
          if (senderId && conversationId && contentTrimmed) {
            const fingerprint = `${senderId}:${conversationId}:${contentTrimmed}`;
            const now = Date.now();
            const lastSeen = processedFingerprints.get(fingerprint);
            if (lastSeen && now - lastSeen < CONTENT_DEDUP_WINDOW_MS) {
              logger.debug(
                `duplicate content ignored (fingerprint dedup): sender=${senderId} text="${textPreview}"`,
              );
              return;
            }
            processedFingerprints.set(fingerprint, now);

            // Evict expired fingerprints to prevent memory leaks
            for (const [key, timestamp] of processedFingerprints) {
              if (now - timestamp > CONTENT_DEDUP_WINDOW_MS) {
                processedFingerprints.delete(key);
              }
            }
          }

          // 异步处理消息（ACK 已在前面发送）
          void handleDingtalkMessage({
            cfg: config,
            raw: rawMessage,
            accountId,
            log: (msg: string) => logger.info(msg.replace(/^\[dingtalk\]\s*/, "")),
            error: (msg: string) => logger.error(msg.replace(/^\[dingtalk\]\s*/, "")),
            enableAICard: dingtalkCfg?.enableAICard ?? true,
          }).catch((err) => {
            logger.error(`error handling message: ${String(err)}`);
          });
        } catch (err) {
          logger.error(`error parsing message: ${String(err)}`);
        }
      });

      // Register card callback listener for interactive button clicks.
      const CARD_CALLBACK_TOPIC = "/v1.0/card/instances/callback";
      client.registerCallbackListener(CARD_CALLBACK_TOPIC, (res) => {
        const streamMessageId = res?.headers?.messageId;

        // ACK immediately to prevent DingTalk retries
        if (streamMessageId) {
          try {
            client.socketCallBackResponse(streamMessageId, { success: true });
          } catch (ackErr) {
            logger.error(`failed to ACK card callback ${streamMessageId}: ${String(ackErr)}`);
          }
        }

        const topic = res?.headers?.topic ?? "";
        if (!isCardCallbackEvent(topic) && !isCardCallbackEvent(CARD_CALLBACK_TOPIC)) {
          logger.debug(`ignoring non-card callback topic: ${topic}`);
          return;
        }

        const payload = parseCardCallbackData(res.data);
        if (!payload) {
          logger.warn("failed to parse card callback payload");
          return;
        }

        logger.debug(
          `Card callback: outTrackId=${payload.outTrackId} userId=${payload.userId ?? "unknown"}`,
        );

        void handleCardCallback(payload, {
          logger: {
            debug: (msg: string) => logger.debug(msg),
            info: (msg: string) => logger.info(msg),
            warn: (msg: string) => logger.warn(msg),
            error: (msg: string) => logger.error(msg),
          } as import("./shared/index.js").Logger,
        }).catch((err) => {
          logger.error(`error handling card callback: ${String(err)}`);
        });
      });

      // Start Stream connection.
      client.connect();

      logger.info("Stream client connected");
    } catch (err) {
      logger.error(`failed to start Stream connection: ${String(err)}`);
      finalizeReject(err);
    }
  });

  return currentPromise;
}

/**
 * 停止钉钉 Monitor
 */
export function stopDingtalkMonitor(): void {
  processedMessages.clear();
  processedFingerprints.clear();

  if (currentStop) {
    currentStop();
    return;
  }
  if (currentClient) {
    try {
      currentClient.disconnect();
    } catch (err) {
      console.error(`[dingtalk] failed to disconnect client: ${String(err)}`);
    } finally {
      currentClient = null;
      currentAccountId = null;
      currentPromise = null;
      currentStop = null;
    }
  }
}

/**
 * 获取当前 Stream 客户端状态
 */
export function isMonitorActive(): boolean {
  return currentClient !== null;
}

/**
 * 获取当前活跃连接的账户 ID
 */
export function getCurrentAccountId(): string | null {
  return currentAccountId;
}
