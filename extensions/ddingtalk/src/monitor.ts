import { DWClient, TOPIC_ROBOT, type DWClientDownStream } from "dingtalk-stream";
import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import type { DingTalkMessageData } from "./types.js";
import { replyViaWebhook } from "./client.js";
import { resolveDingTalkAccount } from "./accounts.js";
import { getDingTalkRuntime } from "./runtime.js";
import { logger } from "./logger.js";
import { PLUGIN_ID } from "./constants.js";
import type { InboundMediaContext } from "./media.js";
import { generateMediaPlaceholder, buildMediaContextFields, getErrorMessage } from "./media.js";
import { getMessageHandler } from "./handlers.js";

export interface MonitorOptions {
  clientId: string;
  clientSecret: string;
  accountId: string;
  config: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
}

export interface MonitorResult {
  account: ReturnType<typeof resolveDingTalkAccount>;
  stop: () => void;
}

// Track runtime state in memory
const runtimeState = new Map<
  string,
  {
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    lastInboundAt?: number | null;
    lastOutboundAt?: number | null;
  }
>();

function recordDingTalkRuntimeState(params: {
  channel: string;
  accountId: string;
  state: Partial<{
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    lastInboundAt: number | null;
    lastOutboundAt: number | null;
  }>;
}): void {
  const key = `${params.channel}:${params.accountId}`;
  const existing = runtimeState.get(key) ?? {
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  };
  runtimeState.set(key, { ...existing, ...params.state });
}

export function getDingTalkRuntimeState(accountId: string) {
  return runtimeState.get(`${PLUGIN_ID}:${accountId}`);
}

/** 通过 webhook 发送错误回复（静默失败） */
function replyError(webhook: string | undefined, message: string | undefined): void {
  if (!webhook || !message) return;
  replyViaWebhook(webhook, message).catch((err) => {
    logger.error("回复错误提示失败:", err);
  });
}

/**
 * 启动钉钉 Stream 监听器
 */
export function monitorDingTalkProvider(options: MonitorOptions): MonitorResult {
  const { clientId, clientSecret, accountId, config, abortSignal } = options;
  const pluginRuntime = getDingTalkRuntime();

  const account = resolveDingTalkAccount({ cfg: config, accountId });

  /** 检查发送者是否在 allowFrom 白名单中 */
  const isSenderAllowed = (senderId: string): boolean => {
    const allowList = account.allowFrom.map((entry) => String(entry).trim()).filter(Boolean);
    if (allowList.length === 0 || allowList.includes("*")) {
      return true;
    }
    const prefixPattern = new RegExp(`^${PLUGIN_ID}:(?:user:)?`, "i");
    return allowList
      .map((entry) => entry.replace(prefixPattern, ""))
      .includes(senderId);
  };

  // Record starting state
  recordDingTalkRuntimeState({
    channel: PLUGIN_ID,
    accountId,
    state: {
      running: true,
      lastStartAt: Date.now(),
    },
  });

  // 创建钉钉 Stream 客户端
  const client = new DWClient({
    clientId,
    clientSecret,
    debug: false,
  });

  // ============================================================================
  // 消息处理核心逻辑
  // ============================================================================

  /** 构建发送者信息 */
  const buildSenderInfo = (data: DingTalkMessageData) => {
    const senderId = data.senderStaffId;
    const senderName = data.senderNick;
    const chatId = senderId; // 单聊用 senderId 作为 chatId

    return {
      senderId,
      senderName,
      chatId,
      fromAddress: `${PLUGIN_ID}:${senderId}`,
      toAddress: `${PLUGIN_ID}:${senderId}`,
      label: senderName || senderId,
    };
  };

  /** 构建消息体内容 */
  const buildMessageBody = (data: DingTalkMessageData, media?: InboundMediaContext) => {
    const textContent = data.text?.content?.trim() ?? "";
    const mediaPlaceholder = media ? generateMediaPlaceholder(media) : "";

    // 优先使用文本内容，如果没有则使用媒体占位符
    const rawBody = textContent || mediaPlaceholder;

    return { textContent, rawBody };
  };

  /** 构建入站消息上下文 */
  const buildInboundContext = (
    data: DingTalkMessageData,
    sender: ReturnType<typeof buildSenderInfo>,
    rawBody: string,
    media?: InboundMediaContext
  ) => {
    // 解析路由
    const route = pluginRuntime.channel.routing.resolveAgentRoute({
      cfg: config,
      channel: PLUGIN_ID,
      accountId,
      peer: { kind: "dm", id: sender.chatId },
    });

    // 格式化入站消息体
    const envelopeOptions = pluginRuntime.channel.reply.resolveEnvelopeFormatOptions(config);
    const body = pluginRuntime.channel.reply.formatInboundEnvelope({
      channel: "DingTalk",
      from: sender.label,
      timestamp: parseInt(data.createAt),
      body: rawBody,
      chatType: "direct",
      sender: {
        id: sender.senderId,
        name: sender.senderName,
      },
      envelope: envelopeOptions,
    });

    // 构建基础上下文
    const baseContext = {
      Body: body,
      RawBody: rawBody,
      CommandBody: rawBody,
      From: sender.fromAddress,
      To: sender.toAddress,
      SessionKey: route.sessionKey,
      AccountId: accountId,
      ChatType: "direct" as const,
      ConversationLabel: sender.label,
      SenderId: sender.senderId,
      SenderName: sender.senderName,
      Provider: PLUGIN_ID,
      Surface: PLUGIN_ID,
      MessageSid: data.msgId,
      Timestamp: parseInt(data.createAt),
      WasMentioned: data.isInAtList,
      OriginatingChannel: PLUGIN_ID,
      OriginatingTo: sender.toAddress,
      CommandAuthorized: isSenderAllowed(sender.senderId),
    };

    // 合并媒体字段
    const mediaFields = buildMediaContextFields(media);

    return pluginRuntime.channel.reply.finalizeInboundContext({
      ...baseContext,
      ...mediaFields,
    });
  };

  /** 创建回复分发器 */
  const createReplyDispatcher = (data: DingTalkMessageData) => ({
    deliver: async (payload: { text?: string }) => {
      const replyText = payload.text ?? "";
      if (!replyText) return;

      if (data.sessionWebhook) {
        const result = await replyViaWebhook(data.sessionWebhook, replyText);
        if (result.errcode !== 0) {
          throw new Error(`回复失败: ${result.errmsg}`);
        }
      } else {
        logger.warn("sessionWebhook 不存在，无法回复消息");
      }

      recordDingTalkRuntimeState({
        channel: PLUGIN_ID,
        accountId,
        state: { lastOutboundAt: Date.now() },
      });
    },
    onError: (err: unknown, info: { kind: string }) => {
      logger.error(`${info.kind} reply failed:`, err);
    },
  });

  /** 异步处理消息（不阻塞钉钉响应） */
  const processMessageAsync = async (
    data: DingTalkMessageData,
    media?: InboundMediaContext
  ) => {
    try {
      // 1. 构建发送者信息
      const sender = buildSenderInfo(data);

      // 2. 构建消息体
      const { rawBody } = buildMessageBody(data, media);

      // 3. 构建入站上下文
      const ctxPayload = buildInboundContext(data, sender, rawBody, media);

      // 4. 分发消息给 OpenClaw
      const { queuedFinal } = await pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: config,
        dispatcherOptions: createReplyDispatcher(data),
        replyOptions: {},
      });

      if (!queuedFinal) {
        logger.log(`no response generated for message from ${sender.label}`);
      }
    } catch (error) {
      logger.error("处理消息出错:", error);
      recordDingTalkRuntimeState({
        channel: PLUGIN_ID,
        accountId,
        state: {
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
    }
  };

  // 处理消息的回调函数（立即返回成功，异步处理）
  const handleMessage = async (message: DWClientDownStream) => {
    try {
      const data = JSON.parse(message.data) as DingTalkMessageData;

      // 只处理单聊消息
      if (data.conversationType === "2") {
        logger.log(`收到群聊消息，暂不支持群聊，忽略`);
        client.socketCallBackResponse(message.headers.messageId, { status: "SUCCESS" });
        return;
      }

      // 获取消息处理器
      const handler = getMessageHandler(data);

      // 打印收到的消息信息（单行格式）
      const preview = handler.getPreview(data);
      logger.log(`收到消息 | 单聊 | ${data.senderNick}(${data.senderStaffId}) | ${preview}`);

      // 记录入站活动
      recordDingTalkRuntimeState({
        channel: PLUGIN_ID,
        accountId,
        state: { lastInboundAt: Date.now() },
      });

      // 立即返回成功响应给钉钉服务器，避免超时
      client.socketCallBackResponse(message.headers.messageId, { status: "SUCCESS" });

      // 校验消息
      const validation = handler.validate(data);
      if (!validation.valid) {
        replyError(data.sessionWebhook, validation.errorMessage);
        return;
      }

      // 异步处理消息
      handler.handle(data, account)
        .then((result) => {
          if (!result.success) {
            replyError(data.sessionWebhook, result.errorMessage);
            return;
          }
          if (result.skipProcessing) {
            return;
          }
          // 分发消息给 OpenClaw
          return processMessageAsync(data, result.media);
        })
        .catch((err) => {
          const errMsg = getErrorMessage(err);
          logger.error(`处理 ${data.msgtype} 消息失败:`, err); // 保留完整错误对象用于日志
          replyError(data.sessionWebhook, `消息处理失败：${errMsg}`);
        });
    } catch (error) {
      const errMsg = getErrorMessage(error);
      logger.error("解析消息出错:", error); // 保留完整错误对象用于日志
      recordDingTalkRuntimeState({
        channel: PLUGIN_ID,
        accountId,
        state: {
          lastError: errMsg,
        },
      });
      client.socketCallBackResponse(message.headers.messageId, { status: "FAILURE" });
    }
  };

  // 注册消息监听器
  client.registerCallbackListener(TOPIC_ROBOT, handleMessage);

  // 注册连接事件
  client.on("open", () => {
    logger.log(`[${accountId}] Stream 连接已建立`);
  });

  client.on("close", () => {
    logger.log(`[${accountId}] Stream 连接已关闭`);
    recordDingTalkRuntimeState({
      channel: PLUGIN_ID,
      accountId,
      state: {
        running: false,
        lastStopAt: Date.now(),
      },
    });
  });

  client.on("error", (error: Error) => {
    logger.error(`[${accountId}] Stream 连接错误:`, error);
    recordDingTalkRuntimeState({
      channel: PLUGIN_ID,
      accountId,
      state: {
        lastError: error.message,
      },
    });
  });

  // 启动连接 — 包装 connect 方法，确保所有调用（含 DWClient 内部自动重连）都不会产生 unhandled rejection
  const originalConnect = client.connect.bind(client);
  client.connect = () =>
    originalConnect().catch((err: unknown) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[${accountId}] DingTalk Stream 连接失败: ${errMsg}`);
      recordDingTalkRuntimeState({
        channel: PLUGIN_ID,
        accountId,
        state: {
          running: false,
          lastStopAt: Date.now(),
          lastError: errMsg,
        },
      });
    });

  client.connect();

  // 处理中止信号
  const stopHandler = () => {
    logger.log(`[${accountId}] 停止 provider`);
    client.disconnect();
    recordDingTalkRuntimeState({
      channel: PLUGIN_ID,
      accountId,
      state: {
        running: false,
        lastStopAt: Date.now(),
      },
    });
  };

  if (abortSignal) {
    abortSignal.addEventListener("abort", stopHandler);
  }

  return {
    account,
    stop: () => {
      stopHandler();
      abortSignal?.removeEventListener("abort", stopHandler);
    },
  };
}
