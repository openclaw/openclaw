/**
 * 企业微信 WebSocket 监控器主模块
 *
 * 负责：
 * - 建立和管理 WebSocket 连接
 * - 协调消息处理流程（解析→策略检查→下载图片→路由回复）
 * - 资源生命周期管理
 *
 * 子模块：
 * - message-parser.ts  : 消息内容解析
 * - message-sender.ts  : 消息发送（带超时保护）
 * - media-handler.ts   : 图片下载和保存（带超时保护）
 * - group-policy.ts    : 群组访问控制
 * - dm-policy.ts       : 私聊访问控制
 * - state-manager.ts   : 全局状态管理（带 TTL 清理）
 * - timeout.ts         : 超时工具
 */

import { WSClient, generateReqId } from "@wecom/aibot-node-sdk";
import type { WsFrame, Logger } from "@wecom/aibot-node-sdk";
import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import {
  CHANNEL_ID,
  THINKING_MESSAGE,
  MEDIA_IMAGE_PLACEHOLDER,
  MEDIA_DOCUMENT_PLACEHOLDER,
  MESSAGE_PROCESS_TIMEOUT_MS,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_MAX_RECONNECT_ATTEMPTS,
} from "./const.ts";
import { checkDmPolicy } from "./dm-policy.ts";
import { checkGroupPolicy } from "./group-policy.ts";
import type { WeComMonitorOptions, MessageState } from "./interface.ts";
import { downloadAndSaveImages, downloadAndSaveFiles } from "./media-handler.ts";
import { parseMessageContent, type MessageBody } from "./message-parser.ts";
import { sendWeComReply } from "./message-sender.ts";
import { getWeComRuntime } from "./runtime.ts";
import {
  setWeComWebSocket,
  setMessageState,
  deleteMessageState,
  setReqIdForChat,
  warmupReqIdStore,
  startMessageStateCleanup,
  stopMessageStateCleanup,
  cleanupAccount,
} from "./state-manager.ts";
import { withTimeout } from "./timeout.ts";
import type { ResolvedWeComAccount } from "./utils.ts";

// ============================================================================
// 重新导出（保持向后兼容）
// ============================================================================

export type { WeComMonitorOptions } from "./interface.ts";
export { WeComCommand } from "./const.ts";
export {
  getWeComWebSocket,
  setReqIdForChat,
  getReqIdForChatAsync,
  getReqIdForChat,
  deleteReqIdForChat,
  warmupReqIdStore,
  flushReqIdStore,
} from "./state-manager.ts";
export { sendWeComReply } from "./message-sender.ts";

// ============================================================================
// 消息上下文构建
// ============================================================================

/**
 * 构建消息上下文
 */
function buildMessageContext(
  frame: WsFrame,
  account: ResolvedWeComAccount,
  config: OpenClawConfig,
  text: string,
  mediaList: Array<{ path: string; contentType?: string }>,
  quoteContent?: string,
) {
  const core = getWeComRuntime();
  const body = frame.body as MessageBody;
  const chatId = body.chatid || body.from.userid;
  const chatType = body.chattype === "group" ? "group" : "direct";

  // 解析路由信息
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: chatType,
      id: chatId,
    },
  });

  // 构建会话标签
  const fromLabel = chatType === "group" ? `group:${chatId}` : `user:${body.from.userid}`;

  // 当只有媒体没有文本时，使用占位符标识媒体类型
  const hasImages = mediaList.some((m) => m.contentType?.startsWith("image/"));
  const messageBody =
    text ||
    (mediaList.length > 0
      ? hasImages
        ? MEDIA_IMAGE_PLACEHOLDER
        : MEDIA_DOCUMENT_PLACEHOLDER
      : "");

  // 构建多媒体数组
  const mediaPaths = mediaList.length > 0 ? mediaList.map((m) => m.path) : undefined;
  const mediaTypes =
    mediaList.length > 0
      ? (mediaList.map((m) => m.contentType).filter(Boolean) as string[])
      : undefined;

  // 构建标准消息上下文
  return core.channel.reply.finalizeInboundContext({
    Body: messageBody,
    RawBody: messageBody,
    CommandBody: messageBody,

    MessageSid: body.msgid,

    From:
      chatType === "group" ? `${CHANNEL_ID}:group:${chatId}` : `${CHANNEL_ID}:${body.from.userid}`,
    To: `${CHANNEL_ID}:${chatId}`,
    SenderId: body.from.userid,

    SessionKey: route.sessionKey,
    AccountId: account.accountId,

    ChatType: chatType,
    ConversationLabel: fromLabel,

    Timestamp: Date.now(),

    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,

    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `${CHANNEL_ID}:${chatId}`,

    CommandAuthorized: true,

    ResponseUrl: body.response_url,
    ReqId: frame.headers.req_id,
    WeComFrame: frame,

    MediaPath: mediaList[0]?.path,
    MediaType: mediaList[0]?.contentType,
    MediaPaths: mediaPaths,
    MediaTypes: mediaTypes,
    MediaUrls: mediaPaths,

    QuoteContent: quoteContent,
  });
}

// ============================================================================
// 消息处理和回复
// ============================================================================

/**
 * 发送"思考中"消息
 */
async function sendThinkingReply(params: {
  wsClient: WSClient;
  frame: WsFrame;
  streamId: string;
  runtime: RuntimeEnv;
}): Promise<void> {
  const { wsClient, frame, streamId, runtime } = params;
  runtime.log?.(`[WeCom] Sending thinking message`);
  try {
    await sendWeComReply({
      wsClient,
      frame,
      text: THINKING_MESSAGE,
      runtime,
      finish: false,
      streamId,
    });
  } catch (err) {
    runtime.error?.(`[WeCom] Failed to send thinking message: ${String(err)}`);
  }
}

/**
 * 路由消息到核心处理流程并处理回复
 */
async function routeAndDispatchMessage(params: {
  ctxPayload: ReturnType<typeof buildMessageContext>;
  config: OpenClawConfig;
  wsClient: WSClient;
  frame: WsFrame;
  state: MessageState;
  runtime: RuntimeEnv;
  onCleanup: () => void;
}): Promise<void> {
  const { ctxPayload, config, wsClient, frame, state, runtime, onCleanup } = params;
  const core = getWeComRuntime();

  // 防止 onCleanup 被多次调用（onError 回调与 catch 块可能重复触发）
  let cleanedUp = false;
  const safeCleanup = () => {
    if (!cleanedUp) {
      cleanedUp = true;
      onCleanup();
    }
  };

  try {
    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: config,
      dispatcherOptions: {
        deliver: async (payload, info) => {
          state.accumulatedText += payload.text;

          if (info.kind !== "final") {
            await sendWeComReply({
              wsClient,
              frame,
              text: state.accumulatedText,
              runtime,
              finish: false,
              streamId: state.streamId,
            });
          }
        },
        onError: (err, info) => {
          runtime.error?.(`[WeCom] ${info.kind} reply failed: ${String(err)}`);
          // 仅记录错误，不立即 cleanup，让外层 try/catch 统一处理最终回复和 cleanup
        },
      },
    });

    // 发送最终消息
    if (state.accumulatedText) {
      await sendWeComReply({
        wsClient,
        frame,
        text: state.accumulatedText,
        runtime,
        finish: true,
        streamId: state.streamId,
      });
    }

    safeCleanup();
  } catch (err) {
    runtime.error?.(`[WeCom] Failed to process message: ${String(err)}`);
    safeCleanup();
  }
}

/**
 * 处理企业微信消息（主函数）
 *
 * 处理流程：
 * 1. 解析消息内容（文本、图片、引用）
 * 2. 群组策略检查（仅群聊）
 * 3. DM Policy 访问控制检查（仅私聊）
 * 4. 下载并保存图片
 * 5. 初始化消息状态
 * 6. 发送"思考中"消息
 * 7. 路由消息到核心处理流程
 *
 * 整体带超时保护，防止单条消息处理阻塞过久
 */
async function processWeComMessage(params: {
  frame: WsFrame;
  account: ResolvedWeComAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  wsClient: WSClient;
}): Promise<void> {
  const { frame, account, config, runtime, wsClient } = params;
  const body = frame.body as MessageBody;
  const chatId = body.chatid || body.from.userid;
  const chatType = body.chattype === "group" ? "group" : "direct";
  const messageId = body.msgid;
  const reqId = frame.headers.req_id;

  // Step 1: 解析消息内容
  const { textParts, imageUrls, imageAesKeys, fileUrls, fileAesKeys, quoteContent } =
    parseMessageContent(body);
  let text = textParts.join("\n").trim();

  // 群聊中移除 @机器人 的提及标记
  if (body.chattype === "group") {
    text = text.replace(/@\S+/g, "").trim();
  }

  // 如果文本为空但存在引用消息，使用引用消息内容
  if (!text && quoteContent) {
    text = quoteContent;
    runtime.log?.("[WeCom] Using quote content as message body (user only mentioned bot)");
  }

  // 如果既没有文本也没有图片也没有文件也没有引用内容，则跳过
  if (!text && imageUrls.length === 0 && fileUrls.length === 0) {
    runtime.log?.("[WeCom] Skipping empty message (no text, image, file or quote)");
    return;
  }

  runtime.log?.(
    `[WeCom] Processing ${chatType} message from chat: ${chatId} user: ${body.from.userid} reqId: ${reqId}${imageUrls.length > 0 ? ` (with ${imageUrls.length} image(s))` : ""}${fileUrls.length > 0 ? ` (with ${fileUrls.length} file(s))` : ""}${quoteContent ? ` (with quote)` : ""}`,
  );

  // Step 2: 群组策略检查（仅群聊）
  if (chatType === "group") {
    const groupPolicyResult = checkGroupPolicy({
      chatId,
      senderId: body.from.userid,
      account,
      config,
      runtime,
    });

    if (!groupPolicyResult.allowed) {
      return;
    }
  }

  // Step 3: DM Policy 访问控制检查（仅私聊）
  const dmPolicyResult = await checkDmPolicy({
    senderId: body.from.userid,
    isGroup: chatType === "group",
    account,
    wsClient,
    frame,
    runtime,
  });

  if (!dmPolicyResult.allowed) {
    return;
  }

  // Step 4: 下载并保存图片和文件
  const [imageMediaList, fileMediaList] = await Promise.all([
    downloadAndSaveImages({
      imageUrls,
      imageAesKeys,
      account,
      config,
      runtime,
      wsClient,
    }),
    downloadAndSaveFiles({
      fileUrls,
      fileAesKeys,
      account,
      config,
      runtime,
      wsClient,
    }),
  ]);
  const mediaList = [...imageMediaList, ...fileMediaList];

  // Step 5: 初始化消息状态
  setReqIdForChat(chatId, reqId, account.accountId);

  const streamId = generateReqId("stream");
  const state: MessageState = { accumulatedText: "", streamId };
  setMessageState(messageId, state);

  const cleanupState = () => {
    deleteMessageState(messageId);
  };

  // Step 6: 发送"思考中"消息
  const shouldSendThinking = account.sendThinkingMessage ?? true;
  if (shouldSendThinking) {
    await sendThinkingReply({ wsClient, frame, streamId, runtime });
  }

  // Step 7: 构建上下文并路由到核心处理流程（带整体超时保护）
  const ctxPayload = buildMessageContext(frame, account, config, text, mediaList, quoteContent);

  try {
    await withTimeout(
      routeAndDispatchMessage({
        ctxPayload,
        config,
        wsClient,
        frame,
        state,
        runtime,
        onCleanup: cleanupState,
      }),
      MESSAGE_PROCESS_TIMEOUT_MS,
      `Message processing timed out (msgId=${messageId})`,
    );
  } catch (err) {
    runtime.error?.(`[WeCom] Message processing failed or timed out: ${String(err)}`);
    cleanupState();
  }
}

// ============================================================================
// 创建 SDK Logger 适配器
// ============================================================================

/**
 * 创建适配 RuntimeEnv 的 Logger
 */
function createSdkLogger(runtime: RuntimeEnv, accountId: string): Logger {
  return {
    debug: (message: string, ...args: any[]) => {
      runtime.log?.(`[${accountId}] ${message}`, ...args);
    },
    info: (message: string, ...args: any[]) => {
      runtime.log?.(`[${accountId}] ${message}`, ...args);
    },
    warn: (message: string, ...args: any[]) => {
      runtime.log?.(`[${accountId}] WARN: ${message}`, ...args);
    },
    error: (message: string, ...args: any[]) => {
      runtime.error?.(`[${accountId}] ${message}`, ...args);
    },
  };
}

// ============================================================================
// 主函数
// ============================================================================

/**
 * 监听企业微信 WebSocket 连接
 * 使用 aibot-node-sdk 简化连接管理
 */
export async function monitorWeComProvider(options: WeComMonitorOptions): Promise<void> {
  const { account, config, runtime, abortSignal } = options;

  runtime.log?.(`[${account.accountId}] Initializing WSClient with SDK...`);

  // 启动消息状态定期清理
  startMessageStateCleanup();

  return new Promise((resolve, reject) => {
    const logger = createSdkLogger(runtime, account.accountId);

    const wsClient = new WSClient({
      botId: account.botId,
      secret: account.secret,
      wsUrl: account.websocketUrl,
      logger,
      heartbeatInterval: WS_HEARTBEAT_INTERVAL_MS,
      maxReconnectAttempts: WS_MAX_RECONNECT_ATTEMPTS,
    });

    // 清理函数：确保所有资源被释放
    const cleanup = async () => {
      stopMessageStateCleanup();
      await cleanupAccount(account.accountId);
    };

    // 处理中止信号
    if (abortSignal) {
      abortSignal.addEventListener("abort", async () => {
        runtime.log?.(`[${account.accountId}] Connection aborted`);
        await cleanup();
        resolve();
      });
    }

    // 监听连接事件
    wsClient.on("connected", () => {
      runtime.log?.(`[${account.accountId}] WebSocket connected`);
    });

    // 监听认证成功事件
    wsClient.on("authenticated", () => {
      runtime.log?.(`[${account.accountId}] Authentication successful`);
      setWeComWebSocket(account.accountId, wsClient);
    });

    // 监听断开事件
    wsClient.on("disconnected", (reason) => {
      runtime.log?.(`[${account.accountId}] WebSocket disconnected: ${reason}`);
    });

    // 监听重连事件
    wsClient.on("reconnecting", (attempt) => {
      runtime.log?.(`[${account.accountId}] Reconnecting attempt ${attempt}...`);
    });

    // 监听错误事件
    wsClient.on("error", (error) => {
      runtime.error?.(`[${account.accountId}] WebSocket error: ${error.message}`);
      // 认证失败时拒绝 Promise
      if (error.message.includes("Authentication failed")) {
        cleanup().finally(() => reject(error));
      }
    });

    // 监听所有消息
    wsClient.on("message", async (frame: WsFrame) => {
      try {
        await processWeComMessage({
          frame,
          account,
          config,
          runtime,
          wsClient,
        });
      } catch (err) {
        runtime.error?.(`[${account.accountId}] Failed to process message: ${String(err)}`);
      }
    });

    // 启动前预热 reqId 缓存，确保完成后再建立连接，避免 getSync 在预热完成前返回 undefined
    warmupReqIdStore(account.accountId, (...args) => runtime.log?.(...args))
      .then((count) => {
        runtime.log?.(`[${account.accountId}] Warmed up ${count} reqId entries from disk`);
      })
      .catch((err) => {
        runtime.error?.(`[${account.accountId}] Failed to warmup reqId store: ${String(err)}`);
      })
      .finally(() => {
        // 无论预热成功或失败，都建立连接
        wsClient.connect();
      });
  });
}
