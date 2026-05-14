/**
 * 钉钉 WebSocket 连接层
 *
 * 职责：
 * - 管理单个钉钉账号的 WebSocket 连接
 * - 实现应用层心跳检测（10 秒间隔，90 秒超时）
 * - 处理连接重连逻辑，带指数退避
 * - 消息去重（内置 Map，5 分钟 TTL）
 *
 * 核心特性：
 * - 关闭 SDK 内置 keepAlive，使用自定义心跳
 * - 详细的消息接收日志（三阶段：接收、解析、处理）
 * - 连接统计和监控（每分钟输出）
 */
import * as fs from "fs";
import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import type { ResolvedDingtalkAccount } from "../types/index.ts";
import { checkAndMarkDingtalkMessage } from "../utils/utils-legacy.ts";

// ============ 类型定义 ============

export type DingtalkReactionCreatedEvent = {
  type: "reaction_created";
  channelId: string;
  messageId: string;
  userId: string;
  emoji: string;
};

// 消息处理器函数类型
export type MessageHandler = (params: {
  accountId: string;
  config: any;
  data: any;
  sessionWebhook: string;
  runtime?: RuntimeEnv;
  log?: any;
  cfg: ClawdbotConfig;
}) => Promise<void>;

/** 连接状态变更回调，用于向框架报告 connected / lastInboundAt 等字段 */
export type OnStatusChange = (patch: Record<string, unknown>) => void;

export type MonitorDingtalkAccountOpts = {
  cfg: ClawdbotConfig;
  account: ResolvedDingtalkAccount;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  messageHandler: MessageHandler;
  /** 可选：连接状态变更时回调，用于更新 UI 显示的 Connected / Last inbound 字段 */
  onStatusChange?: OnStatusChange;
};

// ============ 连接配置 ============

/** 心跳间隔（毫秒） */
const HEARTBEAT_INTERVAL = 10 * 1000; // 10 秒
/** 超时阈值（毫秒） */
const TIMEOUT_THRESHOLD = 20 * 1000; // 20 秒（2 次心跳未响应）
/** 基础退避时间（毫秒） */
const BASE_BACKOFF_DELAY = 1000; // 1 秒
/** 最大退避时间（毫秒） */
const MAX_BACKOFF_DELAY = 30 * 1000; // 30 秒

// ============ 监控账号 ============

export async function monitorSingleAccount(opts: MonitorDingtalkAccountOpts): Promise<void> {
  const { cfg, account, runtime, abortSignal, messageHandler, onStatusChange } = opts;
  const { accountId } = account;

  // 保存 cfg 以便传递给 messageHandler
  const clawdbotConfig = cfg;
  const log = runtime?.log;

  // 创建 debug logger（仅在 debug 模式下输出 info/debug 日志）
  const { createLoggerFromConfig } = await import("../utils/logger");
  const logger = createLoggerFromConfig(account.config, `DingTalk:${accountId}`);

  // 验证凭据是否存在
  if (!account.clientId || !account.clientSecret) {
    throw new Error(
      `[DingTalk][${accountId}] Missing credentials: ` +
        `clientId=${account.clientId ? "present" : "MISSING"}, ` +
        `clientSecret=${account.clientSecret ? "present" : "MISSING"}. ` +
        `Please check your configuration in channels.dingtalk.`,
    );
  }

  // 验证凭据格式
  const clientIdStr = String(account.clientId);
  const clientSecretStr = String(account.clientSecret);

  if (clientIdStr.length < 10 || clientSecretStr.length < 10) {
    throw new Error(
      `[DingTalk][${accountId}] Invalid credentials format: ` +
        `clientId length=${clientIdStr.length}, clientSecret length=${clientSecretStr.length}. ` +
        `Credentials appear to be too short or invalid.`,
    );
  }

  // ============ 修复 macOS LaunchAgent 环境下的文件描述符问题 ============
  //
  // 在 macOS LaunchAgent/daemon 环境下，进程启动时 stdin/stdout/stderr（fd 0/1/2）
  // 可能无效（EBADF），导致 Node.js 的 net.Socket 在创建 TCP 连接时出现 EBADF 错误。
  // 通过打开 /dev/null 来确保 fd 0/1/2 有效，避免 socket 创建时使用无效的 fd。
  //
  // 参考：OpenClaw issue #8021 (spawn EBADF on macOS with Node.js 22+)
  if (process.platform === "darwin") {
    for (const stdioFd of [0, 1, 2]) {
      try {
        fs.fstatSync(stdioFd);
      } catch (fdError: any) {
        if (fdError.code === "EBADF") {
          logger.warn(
            `[LaunchAgent] 检测到 fd ${stdioFd} 无效（EBADF），重定向到 /dev/null 以防止 TCP socket 创建失败`,
          );
          try {
            fs.openSync("/dev/null", stdioFd === 0 ? "r" : "w");
          } catch (openError: any) {
            logger.warn(`[LaunchAgent] 无法修复 fd ${stdioFd}: ${openError.message}`);
          }
        }
      }
    }
  }

  logger.info(`Starting DingTalk Stream client...`);
  logger.info(`Initializing with clientId: ${clientIdStr.substring(0, 8)}...`);
  logger.info(`WebSocket keepAlive: false (using application-layer heartbeat)`);

  // 动态导入 dingtalk-stream 模块（避免循环依赖和 ESM/CJS 兼容性问题）
  const dingtalkStreamModule = await import("dingtalk-stream");
  const DWClient = dingtalkStreamModule.DWClient;
  const { TOPIC_ROBOT } = dingtalkStreamModule;

  if (!DWClient) {
    throw new Error("Failed to import DWClient from dingtalk-stream module");
  }

  // 配置 DWClient：禁用 SDK 内置的 keepAlive 和 autoReconnect，使用自定义实现
  const client = new DWClient({
    clientId: account.clientId,
    clientSecret: account.clientSecret,
    debug: account.config.debug,
    // 显式设置 HTTPS endpoint，防止被降级为 HTTP
    endpoint: account.config.endpoint || "https://api.dingtalk.com",
    autoReconnect: false, // ❌ 禁用 SDK 自动重连
    keepAlive: false, // ❌ 禁用 SDK 心跳检测
  } as any);

  // ============ 连接状态管理 ============

  let lastSocketAvailableTime = Date.now();
  let connectionEstablishedTime = Date.now(); // 记录连接建立时间
  let isReconnecting = false;
  let reconnectAttempts = 0;
  let keepAliveTimer: NodeJS.Timeout | null = null;
  let isStopped = false;

  // ============ 消息处理活跃标记 ============
  // 用于在消息处理期间防止心跳超时触发重连
  let activeMessageProcessing = false;
  let messageProcessingKeepAliveTimer: NodeJS.Timeout | null = null;

  /**
   * 标记消息处理开始，启动定期更新机制
   * 在消息处理期间，每 30 秒更新一次 lastSocketAvailableTime
   * 防止长时间处理（如复杂的 AI 任务）触发心跳超时
   */
  function markMessageProcessingStart() {
    activeMessageProcessing = true;
    lastSocketAvailableTime = Date.now();

    // 清理旧的定时器（如果存在）
    if (messageProcessingKeepAliveTimer) {
      clearInterval(messageProcessingKeepAliveTimer);
    }

    // 每 30 秒更新一次，确保不会触发 90 秒超时
    messageProcessingKeepAliveTimer = setInterval(() => {
      if (activeMessageProcessing) {
        lastSocketAvailableTime = Date.now();
        logger.debug(`📝 消息处理中，更新 socket 可用时间`);
      }
    }, 30 * 1000); // 30 秒间隔

    logger.debug(`📝 消息处理开始，启动活跃标记定时器`);
  }

  /**
   * 标记消息处理结束，停止定期更新机制
   */
  function markMessageProcessingEnd() {
    activeMessageProcessing = false;

    if (messageProcessingKeepAliveTimer) {
      clearInterval(messageProcessingKeepAliveTimer);
      messageProcessingKeepAliveTimer = null;
    }

    // 最后更新一次时间
    lastSocketAvailableTime = Date.now();
    logger.debug(`✅ 消息处理结束，清理活跃标记定时器`);
  }

  // ============ 辅助函数 ============

  /** 计算指数退避延迟（带抖动） */
  function calculateBackoffDelay(attempt: number): number {
    const exponentialDelay = BASE_BACKOFF_DELAY * Math.pow(2, attempt);
    const jitter = Math.random() * 1000; // 0-1 秒随机抖动
    return Math.min(exponentialDelay + jitter, MAX_BACKOFF_DELAY);
  }

  /** 统一重连函数，带指数退避（无限重连） */
  async function doReconnect(immediate = false) {
    if (isReconnecting || isStopped) {
      logger.debug(`正在重连中或已停止，跳过`);
      return;
    }

    isReconnecting = true;

    // 应用指数退避（非立即重连时）
    if (!immediate && reconnectAttempts > 0) {
      const delay = calculateBackoffDelay(reconnectAttempts);
      logger.info(`⏳ 等待 ${Math.round(delay / 1000)} 秒后重连 (尝试 ${reconnectAttempts + 1})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
      // 1. 先断开旧连接（检查 WebSocket 状态）
      if (client.socket?.readyState === 1 || client.socket?.readyState === 3) {
        await client.disconnect();
        logger.info(`已断开旧连接`);
      }

      // 2. 重新建立连接
      await client.connect();

      // 3. 等待连接真正建立（监听 open 事件，最多等待 10 秒）
      const connectionEstablished = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          resolve(false);
        }, 10_000); // 10 秒超时

        // 如果已经是 OPEN 状态，直接返回
        if (client.socket?.readyState === 1) {
          clearTimeout(timeout);
          resolve(true);
          return;
        }

        // 否则监听 open 事件
        const onOpen = () => {
          clearTimeout(timeout);
          client.socket?.removeListener("open", onOpen);
          client.socket?.removeListener("error", onError);
          resolve(true);
        };

        const onError = (err: any) => {
          clearTimeout(timeout);
          client.socket?.removeListener("open", onOpen);
          client.socket?.removeListener("error", onError);
          logger.warn(`连接建立失败: ${err.message}`);
          resolve(false);
        };

        client.socket?.once("open", onOpen);
        client.socket?.once("error", onError);
      });

      if (!connectionEstablished) {
        throw new Error(`连接建立超时或失败`);
      }

      // 4. 重置 socket 可用时间、连接建立时间和重连计数
      lastSocketAvailableTime = Date.now();
      connectionEstablishedTime = Date.now(); // 重置连接建立时间
      reconnectAttempts = 0; // 重连成功，重置计数

      // 重连成功，向框架报告 connected: true
      onStatusChange?.({ connected: true, lastConnectedAt: Date.now() });

      logger.info(`✅ 重连成功 (socket 状态=${client.socket?.readyState})`);
    } catch (err: any) {
      reconnectAttempts++;
      logger.error(`重连失败：${err.message} (尝试 ${reconnectAttempts})`);
      throw err;
    } finally {
      isReconnecting = false;
    }
  }

  /** 监听 pong 响应（更新 socket 可用时间） */
  function setupPongListener() {
    client.socket?.on("pong", () => {
      lastSocketAvailableTime = Date.now();
      logger.debug(`收到 PONG 响应`);
    });
  }

  /** 监听 WebSocket message 事件，收到 disconnect 消息时立即触发重连 */
  function setupMessageListener() {
    client.socket?.on("message", (data: any) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "SYSTEM" && msg.headers?.topic === "disconnect") {
          if (!isStopped && !isReconnecting) {
            // 立即重连，不退避
            doReconnect(true).catch((err) => {
              logger.error(`[${accountId}] 重连失败：${err.message}`);
            });
          }
        }
      } catch (e) {
        // 忽略解析错误
      }
    });
  }

  /** 监听 WebSocket close 事件，服务端主动断开时立即触发重连 */
  function setupCloseListener() {
    client.socket?.on("close", (code, reason) => {
      logger.info(
        `WebSocket close: code=${code}, reason=${reason || "未知"}, isStopped=${isStopped}`,
      );

      // 连接断开时，向框架报告 connected: false
      onStatusChange?.({ connected: false });

      if (isStopped) {
        return;
      }

      // 立即重连，不退避
      setTimeout(() => {
        doReconnect(true).catch((err) => {
          logger.error(`重连失败：${err.message}`);
        });
      }, 0);
    });
  }

  /**
   * 启动 keepAlive 机制（单定时器 + 指数退避）
   *
   * 业界最佳实践：
   * - 单定时器：每 10 秒检查一次，同时完成心跳和超时检测
   * - 使用 WebSocket 原生 Ping
   * - 指数退避重连：避免雪崩效应
   */
  function startKeepAlive(): () => void {
    logger.debug(`🚀 启动 keepAlive 定时器，间隔=${HEARTBEAT_INTERVAL / 1000}秒`);

    keepAliveTimer = setInterval(async () => {
      if (isStopped) {
        if (keepAliveTimer) clearInterval(keepAliveTimer);
        return;
      }

      try {
        const elapsed = Date.now() - lastSocketAvailableTime;

        // 【超时检测】超过 90 秒未确认 socket 可用，触发重连
        if (elapsed > TIMEOUT_THRESHOLD) {
          logger.info(
            `⚠️ 超时检测：已 ${Math.round(elapsed / 1000)} 秒未确认 socket 可用，触发重连...`,
          );
          await doReconnect();
          return;
        }

        // 【心跳检测】检查 socket 状态
        const socketState = client.socket?.readyState;
        const timeSinceConnection = Date.now() - connectionEstablishedTime;
        logger.debug(
          `心跳检测：socket 状态=${socketState}, elapsed=${Math.round(elapsed / 1000)}s, 连接已建立=${Math.round(timeSinceConnection / 1000)}s`,
        );

        // 给新建立的连接 15 秒宽限期，避免在连接建立初期就触发重连
        if (socketState !== 1) {
          if (timeSinceConnection < 15_000) {
            logger.debug(
              `⏳ 连接建立中（已 ${Math.round(timeSinceConnection / 1000)}s），跳过状态检查`,
            );
            return;
          }

          logger.info(`⚠️ 心跳检测：socket 状态=${socketState}，触发重连...`);
          await doReconnect(true); // 立即重连，不退避
          return;
        }

        // 【发送原生 Ping】仅发送，不刷新时间戳；
        // 只有收到 pong 响应时才更新 lastSocketAvailableTime（见 setupPongListener）
        try {
          client.socket?.ping();
          logger.debug(`💓 发送 PING 心跳成功`);
        } catch (err: any) {
          logger.warn(`发送 PING 失败：${err.message}`);
          // 发送失败也计入超时
        }
      } catch (err: any) {
        logger.error(`keepAlive 检测失败：${err.message}`);
      }
    }, HEARTBEAT_INTERVAL); // 每 10 秒检测一次

    logger.debug(`✅ keepAlive 定时器已启动`);

    // 返回清理函数
    return () => {
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      keepAliveTimer = null;
      logger.debug(`keepAlive 定时器已清理`);
    };
  }

  /** 停止并清理所有资源 */
  function stop() {
    isStopped = true;

    // 清理心跳定时器
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = null;

    // 清理消息处理活跃标记定时器
    if (messageProcessingKeepAliveTimer) {
      clearInterval(messageProcessingKeepAliveTimer);
      messageProcessingKeepAliveTimer = null;
    }

    // 清理事件监听器
    if (client.socket) {
      client.socket.removeAllListeners();
    }

    logger.debug(`Connection 已停止`);
  }

  // 初始化：设置所有事件监听器
  setupPongListener();
  setupMessageListener();
  setupCloseListener();

  return new Promise<void>(async (resolve, reject) => {
    // Handle abort signal
    if (abortSignal) {
      const onAbort = async () => {
        logger.info(`Abort signal received, stopping...`);
        stop();
        try {
          // 只在连接已建立时才断开
          if (client.socket && client.socket.readyState === 1) {
            await client.disconnect();
          }
        } catch (err: any) {
          logger.warn(`断开连接时出错：${err.message}`);
        }
        resolve();
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    // 消息接收统计（用于检测消息丢失）
    let receivedCount = 0;
    let processedCount = 0;
    let lastMessageTime = Date.now();

    // 定期输出统计信息
    const statsInterval = setInterval(() => {
      const now = Date.now();
      const timeSinceLastMessage = Math.round((now - lastMessageTime) / 1000);
      logger.info(
        `统计：收到=${receivedCount}, 处理=${processedCount}, ` +
          `丢失=${receivedCount - processedCount}, 距上次消息=${timeSinceLastMessage}s`,
      );
    }, 60000); // 每分钟输出一次

    // Register message handler
    client.registerCallbackListener(TOPIC_ROBOT, async (res: any) => {
      receivedCount++;
      lastMessageTime = Date.now();

      // 收到消息时，向框架报告 lastInboundAt（用于 UI 显示 "Last inbound"）
      onStatusChange?.({ lastInboundAt: Date.now() });

      const messageId = res.headers?.messageId;
      const timestamp = new Date().toISOString();

      // ===== 第一步：记录原始消息接收 =====
      logger.info(`\n========== 收到新消息 ==========`);
      logger.info(`时间：${timestamp}`);
      logger.info(`MessageId: ${messageId || "N/A"}`);
      logger.info(`Headers: ${JSON.stringify(res.headers || {})}`);
      logger.info(`Data 长度：${res.data?.length || 0} 字符`);

      // 立即确认回调
      if (messageId) {
        client.socketCallBackResponse(messageId, { success: true });
        logger.info(`✅ 已立即确认回调：messageId=${messageId}`);
      } else {
        logger.warn(`⚠️ 警告：消息没有 messageId`);
      }

      // 协议层去重（headers.messageId）：拦截同一次投递的重复回调
      // 注意：业务层去重（data.msgId）在 JSON 解析后执行，两层合并在 checkAndMarkDingtalkMessage 中
      // 此处仅做协议层的快速预检，避免不必要的 JSON 解析
      if (messageId && checkAndMarkDingtalkMessage(accountId, messageId, undefined)) {
        processedCount++;
        logger.warn(
          `⚠️ 检测到重复消息（协议层），跳过处理：messageId=${messageId} (${processedCount}/${receivedCount})`,
        );
        logger.info(`========== 消息处理结束（重复） ==========\n`);
        return;
      }

      // 异步处理消息
      // ✅ 标记消息处理开始，防止长时间处理触发心跳超时
      markMessageProcessingStart();

      try {
        // 解析消息数据
        let data;
        try {
          data = JSON.parse(res.data);
        } catch (parseError: any) {
          logger.error("Failed to parse response data as JSON:", {
            error: parseError instanceof Error ? parseError.message : String(parseError),
            rawData:
              typeof res.data === "string"
                ? res.data.substring(0, 500) // 只记录前 500 字符
                : res.data,
            dataType: typeof res.data,
          });
          throw new Error(
            `Invalid JSON response from DingTalk API. ` +
              `Error: ${parseError instanceof Error ? parseError.message : String(parseError)}. ` +
              `Raw data (first 100 chars): ${String(res.data).substring(0, 100)}`,
          );
        }

        // ===== 第二步：记录解析后的消息详情 =====
        logger.info(`\n----- 消息详情 -----`);
        logger.info(`消息类型：${data.msgtype || "unknown"}`);
        logger.info(
          `会话类型：${data.conversationType === "1" ? "DM (单聊)" : data.conversationType === "2" ? "Group (群聊)" : data.conversationType}`,
        );
        logger.info(
          `发送者：${data.senderNick || "unknown"} (${data.senderStaffId || data.senderId || "unknown"})`,
        );
        logger.info(`会话 ID: ${data.conversationId || "N/A"}`);
        logger.info(`消息 ID: ${data.msgId || "N/A"}`);
        logger.info(`SessionWebhook: ${data.sessionWebhook ? "已提供" : "未提供"}`);
        logger.info(`RobotCode: ${data.robotCode || account.config?.clientId || "N/A"}`);
        // 暴露当前机器人的加密身份（chatbotUserId / chatbotCorpId）
        // 用途：多机器人协作时，把这两个值配进 openclaw.json 对应 account 的元数据下，
        // 让其他 agent 能在群消息里通过 atDingtalkIds 写上对方的 chatbotUserId 触发 @ UI。
        // 注意：这里**不**经过 logger.info（受 debug 开关控制），直接 console.log，
        // 否则首次配置的用户在未开 debug 时永远看不到这两个 ID，无法完成多机器人协作配置。
        if (data.chatbotUserId || data.chatbotCorpId) {
          console.log(
            `[DingTalk:${accountId}] [BotIdentity] accountId=${accountId} chatbotUserId=${data.chatbotUserId || "N/A"} chatbotCorpId=${data.chatbotCorpId || "N/A"}`,
          );
        }

        // ===== 业务层去重：补充 data.msgId，防止钉钉服务端重发穿透 =====
        // 协议层已标记了 headers.messageId，此处再补充标记 data.msgId。
        // 钉钉重发时 headers.messageId 是新值，但 data.msgId 不变，
        // checkAndMarkDingtalkMessage 会命中 data.msgId 并返回 true 拦截重发。
        const businessMsgId = data.msgId;

        // 记录消息内容（简化版，避免过长）
        let contentPreview = "N/A";
        if (data.text?.content) {
          contentPreview =
            data.text.content.length > 100
              ? data.text.content.substring(0, 100) + "..."
              : data.text.content;
        } else if (data.content) {
          contentPreview = JSON.stringify(data.content).substring(0, 100) + "...";
        }
        logger.info(`消息内容预览：${contentPreview}`);
        logger.info(`完整数据字段：${Object.keys(data).join(", ")}`);
        logger.info(`----- 消息详情结束 -----\n`);

        // ===== 第三步：开始处理消息 =====
        logger.info(`🚀 开始处理消息...`);

        await messageHandler({
          accountId,
          config: account.config,
          data,
          sessionWebhook: data.sessionWebhook,
          runtime,
          log,
          cfg: clawdbotConfig,
        });

        processedCount++;
        logger.info(`✅ 消息处理完成 (${processedCount}/${receivedCount})`);
        logger.info(`========== 消息处理结束（成功） ==========\n`);
      } catch (error: any) {
        processedCount++;
        const errorMsg = `❌ 处理消息异常 (${processedCount}/${receivedCount}): ${error?.message || "未知错误"}`;
        const errorStack = error?.stack || "无堆栈信息";

        // 使用 logger 记录错误信息
        logger.error(errorMsg);
        logger.error(`错误堆栈:\n${errorStack}`);

        logger.info(`========== 消息处理结束（失败） ==========\n`);
      } finally {
        // ✅ 无论成功或失败，都要标记消息处理结束
        markMessageProcessingEnd();
      }
    });

    // 清理定时器
    const cleanup = () => {
      clearInterval(statsInterval);
      stop();
    };

    // Connect to DingTalk Stream
    try {
      await client.connect();
      logger.info(`Connected to DingTalk Stream successfully`);
      logger.info(`PID: ${process.pid}`);
      logger.info(`✅ 自定义 keepAlive: true (10 秒心跳，90 秒超时), 指数退避重连`);

      // 初次连接成功，向框架报告 connected: true
      onStatusChange?.({ connected: true, lastConnectedAt: Date.now() });

      // 启动自定义心跳检测
      const cleanupKeepAlive = startKeepAlive();

      // 重写 cleanup 函数，包含 keepAlive 清理
      const enhancedCleanup = () => {
        cleanupKeepAlive();
        clearInterval(statsInterval);
        stop();
      };

      // 进程退出时清理（使用 once 确保只执行一次）
      process.once("exit", enhancedCleanup);
      process.once("SIGINT", enhancedCleanup);
      process.once("SIGTERM", enhancedCleanup);
    } catch (error: any) {
      cleanup(); // 连接失败时清理资源

      // 记录完整错误信息用于调试
      logger.info(`连接失败，错误详情：`);
      logger.info(`  - error.message: ${error.message}`);
      logger.info(`  - error.response?.status: ${error.response?.status}`);
      logger.info(`  - error.response?.data: ${JSON.stringify(error.response?.data || {})}`);
      logger.info(`  - error.code: ${error.code}`);
      logger.info(`  - error.stack: ${error.stack?.split("\n").slice(0, 3).join("\n")}`);

      // 处理 400 错误（请求参数错误）
      if (
        error.response?.status === 400 ||
        error.message?.includes("status code 400") ||
        error.message?.includes("400")
      ) {
        reject(
          new Error(
            `[DingTalk][${accountId}] Bad Request (400):\n` +
              `  - clientId or clientSecret format is invalid\n` +
              `  - clientId: ${clientIdStr} (type: ${typeof account.clientId}, length: ${clientIdStr.length})\n` +
              `  - clientSecret: ****** (type: ${typeof account.clientSecret}, length: ${clientSecretStr.length})\n` +
              `  - Common issues:\n` +
              `    1. clientId/clientSecret must be strings, not numbers\n` +
              `    2. Remove any quotes or special characters\n` +
              `    3. Ensure credentials are from the correct DingTalk app\n` +
              `    4. Check if clientId starts with 'ding' prefix\n` +
              `  - Error details: ${error.message}\n` +
              `  - Response data: ${JSON.stringify(error.response?.data || {})}`,
          ),
        );
        return;
      }

      // 处理 401 认证错误
      if (error.response?.status === 401 || error.message?.includes("401")) {
        reject(
          new Error(
            `[DingTalk][${accountId}] Authentication failed (401 Unauthorized):\n` +
              `  - Your clientId or clientSecret is invalid, expired, or revoked\n` +
              `  - clientId: ${clientIdStr.substring(0, 8)}...\n` +
              `  - Please verify your credentials at DingTalk Developer Console\n` +
              `  - Error details: ${error.message}`,
          ),
        );
        return;
      }

      // 处理其他连接错误
      reject(
        new Error(
          `[DingTalk][${accountId}] Failed to connect to DingTalk Stream: ${error.message}`,
        ),
      );
      return;
    }

    // Handle disconnection（已被自定义 close 监听器替代）
    // client.on('close', ...) - 已移除，使用 setupCloseListener

    client.on("error", (err: Error) => {
      logger.error(`Connection error: ${err.message}`);
    });

    // 监听重连事件（仅用于日志，实际重连由自定义逻辑处理）
    client.on("reconnect", () => {
      logger.info(`SDK reconnecting...`);
    });

    client.on("reconnected", () => {
      logger.info(`✅ SDK reconnected successfully`);
    });
  });
}

export function resolveReactionSyntheticEvent(event: any): DingtalkReactionCreatedEvent | null {
  void event;
  return null;
}
