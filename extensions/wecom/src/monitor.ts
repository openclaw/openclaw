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

import * as os from "os";
import * as path from "path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { WSClient, generateReqId, WSAuthFailureError, WSReconnectExhaustedError } from "@wecom/aibot-node-sdk";
import type { WsFrame, Logger } from "@wecom/aibot-node-sdk";
import { getWeComRuntime } from "./runtime.js";
import { getDefaultMediaLocalRoots, resolveStateDir } from "./openclaw-compat.js";
import type { ResolvedWeComAccount, WeComConfig } from "./utils.js";
import {
  CHANNEL_ID,
  THINKING_MESSAGE,
  MEDIA_IMAGE_PLACEHOLDER,
  MEDIA_DOCUMENT_PLACEHOLDER,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_MAX_RECONNECT_ATTEMPTS,
  WS_MAX_AUTH_FAILURE_ATTEMPTS,
  EVENT_ENTER_CHECK_UPDATE,
  CMD_ENTER_EVENT_REPLY,
  SCENE_WECOM_OPENCLAW,
} from "./const.js";
import type { WeComMonitorOptions, MessageState } from "./interface.js";
import { parseMessageContent, type MessageBody } from "./message-parser.js";
import { sendWeComReply, sendWeComReplyNonBlocking, StreamExpiredError } from "./message-sender.js";
import { downloadAndSaveImages, downloadAndSaveFiles } from "./media-handler.js";
import { uploadAndSendMedia } from "./media-uploader.js";
import { maskTemplateCardBlocks } from "./template-card-parser.js";
import {
  updateTemplateCardOnEvent,
  processTemplateCardsIfNeeded,
} from "./template-card-manager.js";
import { checkGroupPolicy } from "./group-policy.js";
import { checkDmPolicy } from "./dm-policy.js";
import {
  setWeComWebSocket,
  setMessageState,
  deleteMessageState,
  setReqIdForChat,
  warmupReqIdStore,
  startMessageStateCleanup,
  stopMessageStateCleanup,
  cleanupAccount,
} from "./state-manager.js";

import { PLUGIN_VERSION } from "./version.js";
import { processDynamicRouting } from "./dynamic-routing.js";

// ============================================================================
// 消息条目类型
// ============================================================================

/**
 * 消息条目：存储解析阶段（Step 1-4）的结果，
 * 传入串行队列后由处理阶段（Step 5-7）消费。
 */
interface WeComMessageEntry {
  frame: WsFrame;
  account: ResolvedWeComAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  wsClient: WSClient;
  /** 解析后的文本内容 */
  text: string;
  /** 下载后的媒体文件列表 */
  mediaList: Array<{ path: string; contentType?: string }>;
  /** 引用消息内容 */
  quoteContent?: string;
  /** 消息 ID */
  messageId: string;
  /** chatId（群组 ID 或用户 ID） */
  chatId: string;
  /** 请求 ID */
  reqId: string;
}

// ============================================================================
// 媒体本地路径白名单扩展
// ============================================================================

/**
 * 在 getDefaultMediaLocalRoots() 基础上，将 stateDir 本身也加入白名单，
 * 并合并用户在 WeComConfig 中配置的自定义 mediaLocalRoots。
 *
 * getDefaultMediaLocalRoots() 仅包含 stateDir 下的子目录（media/agents/workspace/sandboxes），
 * 但 agent 生成的文件可能直接放在 stateDir 根目录下（如 ~/.openclaw-dev/1.png），
 * 因此需要将 stateDir 本身也加入白名单以避免 LocalMediaAccessError。
 *
 * 用户可在 openclaw.json 中配置：
 * {
 *   "channels": {
 *     "wecom": {
 *       "mediaLocalRoots": ["~/Downloads", "~/Documents"]
 *     }
 *   }
 * }
 */
async function getExtendedMediaLocalRoots(config?: WeComConfig): Promise<string[]> {
  // 从兼容层获取默认白名单（内部已处理低版本 SDK 的 fallback）
  const defaults = await getDefaultMediaLocalRoots();
  const roots: string[] = [...defaults];

  const stateDir = path.resolve(resolveStateDir());
  if (!roots.includes(stateDir)) {
    roots.push(stateDir);
  }
  // 合并用户在 WeComConfig 中配置的自定义路径
  if (config?.mediaLocalRoots) {
    for (const r of config.mediaLocalRoots) {
      const resolved = path.resolve(r.replace(/^~(?=\/|$)/, os.homedir()));
      if (!roots.includes(resolved)) {
        roots.push(resolved);
      }
    }
  }
  return roots;
}

// ============================================================================
// 媒体发送错误提示
// ============================================================================

/**
 * 根据媒体发送结果生成纯文本错误摘要（用于替换 thinking 流式消息展示给用户）。
 *
 * 使用纯文本而非 markdown 格式，因为 replyStream 只支持纯文本。
 */
function buildMediaErrorSummary(
  mediaUrl: string,
  result: { rejectReason?: string; error?: string },
): string {
  if (result.error?.includes("LocalMediaAccessError")) {
    return `⚠️ 文件发送失败：没有权限访问路径 ${mediaUrl}\n请在 openclaw.json 的 mediaLocalRoots 中添加该路径的父目录后重启生效。`;
  }
  if (result.rejectReason) {
    return `⚠️ 文件发送失败：${result.rejectReason}`;
  }
  return `⚠️ 文件发送失败：无法处理文件 ${mediaUrl}，请稍后再试。`;
}

// ============================================================================
// 重新导出（保持向后兼容）
// ============================================================================

export type { WeComMonitorOptions } from "./interface.js";
export { WeComCommand } from "./const.js";
export {
  getWeComWebSocket,
  setReqIdForChat,
  getReqIdForChatAsync,
  getReqIdForChat,
  deleteReqIdForChat,
  warmupReqIdStore,
  flushReqIdStore,
} from "./state-manager.js";
export { sendWeComReply } from "./message-sender.js";

// ============================================================================
// 消息上下文构建
// ============================================================================

/**
 * 构建消息上下文
 * @returns 消息上下文对象
 */
function buildMessageContext(
  frame: WsFrame,
  account: ResolvedWeComAccount,
  config: OpenClawConfig,
  text: string,
  mediaList: Array<{ path: string; contentType?: string }>,
  quoteContent?: string,
  runtime?: RuntimeEnv,
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

  // ===== 动态 Agent 路由注入 =====
  const routingResult = processDynamicRouting({
    route,
    config,
    core,
    accountId: account.accountId,
    chatType: chatType === "group" ? "group" : "dm",
    chatId,
    senderId: body.from.userid,
    log: runtime?.log ? (...args: any[]) => runtime.log?.(...args) : undefined,
    error: runtime?.error ? (...args: any[]) => runtime.error?.(...args) : undefined,
  });

  // 应用动态路由结果
  if (routingResult.routeModified) {
    route.agentId = routingResult.finalAgentId;
    route.sessionKey = routingResult.finalSessionKey;
  }
  // ===== 动态 Agent 路由注入结束 =====

  // 构建会话标签
  const fromLabel = chatType === "group" ? `group:${chatId}` : `user:${body.from.userid}`;

  // 当只有媒体没有文本时，使用占位符标识媒体类型
  const hasImages = mediaList.some((m) => m.contentType?.startsWith("image/"));
  const messageBody = text || (mediaList.length > 0 ? (hasImages ? MEDIA_IMAGE_PLACEHOLDER : MEDIA_DOCUMENT_PLACEHOLDER) : "");

  // 构建多媒体数组
  const mediaPaths = mediaList.length > 0 ? mediaList.map((m) => m.path) : undefined;
  const mediaTypes = mediaList.length > 0
    ? (mediaList.map((m) => m.contentType).filter(Boolean) as string[])
    : undefined;

  // 使用 route.agentId 解析 storePath（多 agent 场景下 session 路径隔离）
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });

  // 构建标准消息上下文
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: messageBody,
    RawBody: messageBody,
    CommandBody: messageBody,

    MessageSid: body.msgid,

    From: chatType === "group" ? `${CHANNEL_ID}:group:${chatId}` : `${CHANNEL_ID}:${body.from.userid}`,
    To: `${CHANNEL_ID}:${chatId}`,
    SenderId: body.from.userid,

    SessionKey: route.sessionKey,
    AccountId: route.accountId,

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

    ReplyToBody: quoteContent,
  });

  return { ctxPayload, route, storePath, chatId, chatType };
}

// ============================================================================
// 消息处理和回复
// ============================================================================

/** deliver 回调所需的上下文 */
interface DeliverContext {
  wsClient: WSClient;
  frame: WsFrame;
  state: MessageState;
  account: ResolvedWeComAccount;
  runtime: RuntimeEnv;
}

/**
 * 发送"思考中"消息
 */
async function sendThinkingReply(params: {
  wsClient: WSClient;
  frame: WsFrame;
  streamId: string;
  runtime: RuntimeEnv;
  state?: MessageState;
}): Promise<void> {
  const { wsClient, frame, streamId, runtime, state } = params;
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
    if (err instanceof StreamExpiredError && state) {
      state.streamExpired = true;
      runtime.log?.(`[wecom] Stream expired during thinking reply, will fallback to proactive send`);
    } else {
      runtime.error?.(`[wecom] Failed to send thinking message: ${String(err)}`);
    }
  }
}

/**
 * 上传并发送一批媒体文件（统一走主动发送通道）
 *
 * replyMedia（被动回复）无法覆盖 replyStream 发出的 thinking 流式消息，
 * 因此所有媒体统一走 aibot_send_msg 主动发送。
 */
async function sendMediaBatch(
  ctx: DeliverContext,
  mediaUrls: string[],
): Promise<void> {
  const { wsClient, frame, state, account, runtime } = ctx;
  const body = frame.body as MessageBody;
  const chatId = body.chatid || body.from.userid;
  const mediaLocalRoots = await getExtendedMediaLocalRoots(account.config);

  runtime.log?.(`[wecom][debug] mediaLocalRoots=${JSON.stringify(mediaLocalRoots)}, mediaUrls=${JSON.stringify(mediaUrls)}`);

  for (const mediaUrl of mediaUrls) {
    const result = await uploadAndSendMedia({
      wsClient,
      mediaUrl,
      chatId,
      mediaLocalRoots,
      log: (...args: any[]) => runtime.log?.(...args),
      errorLog: (...args: any[]) => runtime.error?.(...args),
    });

    if (result.ok) {
      state.hasMedia = true;
    } else {
      state.hasMediaFailed = true;
      runtime.error?.(`[wecom] Media send failed: url=${mediaUrl}, reason=${result.rejectReason || result.error}`);
      // 收集错误摘要，后续在 finishThinkingStream 中直接替换 thinking 流展示给用户
      const summary = buildMediaErrorSummary(mediaUrl, result);
      state.mediaErrorSummary = state.mediaErrorSummary
        ? `${state.mediaErrorSummary}\n\n${summary}`
        : summary;
    }
  }
}

/**
 * 关闭 thinking 流（发送 finish=true 的流式消息）
 *
 * thinking 是通过 replyStream 用 streamId 发的流式消息，
 * 只有同一 streamId 的 replyStream(finish=true) 才能关闭它。
 *
 * ⚠️ 注意：企微会忽略空格等不可见内容，必须用有可见字符的文案才能真正
 *    替换掉 thinking 动画，否则 thinking 会一直残留。
 *
 * 关闭策略（按优先级）：
 * 1. 有可见文本 → 用完整文本关闭
 * 2. 有模板卡片发送成功 → "📋 卡片消息已发送。"
 * 3. 有媒体成功发送（通过 deliver 回调） → 用友好提示"文件已发送"
 * 4. 媒体发送失败 → 直接用错误摘要替换 thinking
 *
 * 降级策略：
 * - 当 streamExpired=true（errcode 846608）时，流式通道已不可用（>6分钟），
 *   改用 wsClient.sendMessage 主动发送完整文本。
 *
 * 注意：模板卡片的检测和发送已在 finishThinkingStream 之前由
 *       processTemplateCardsIfNeeded 完成，此处只关心最后的消息发送。
 */
async function finishThinkingStream(ctx: DeliverContext): Promise<void> {
  const { wsClient, frame, state, runtime } = ctx;
  const body = frame.body as MessageBody;
  const chatId = body.chatid || body.from.userid;
  const visibleText = state.accumulatedText;

  let finishText: string = state.accumulatedText;
  if (visibleText) {
    finishText = state.accumulatedText;
  } else if (state.hasTemplateCard) {
    finishText = "📋 卡片消息已发送。";
  } else if (state.hasMedia) {
    if (state.hasMediaFailed && state.mediaErrorSummary) {
      finishText = finishText ? `${finishText}\n\n${state.mediaErrorSummary}` : state.mediaErrorSummary;
    } else if (!finishText) {
      finishText = "📎 文件已发送，请查收。";
    }
  }

  if (finishText) {
    // 尝试流式发送；若已知过期或发送时发现过期，统一降级为主动发送
    let expired = state.streamExpired;
    if (!expired) {
      try {
        await sendWeComReply({wsClient, frame, text: finishText, runtime, finish: true, streamId: state.streamId});
      } catch (err) {
        if (err instanceof StreamExpiredError) {
          expired = true;
        } else {
          throw err;
        }
      }
    }
    if (expired) {
      runtime.log?.(`[wecom] Stream expired, sending final text via sendMessage (proactive)`);
      await wsClient.sendMessage(chatId, {
        msgtype: "markdown",
        markdown: { content: finishText },
      });
    }
  }
}

/**
 * 路由消息到核心处理流程并处理回复
 */
async function routeAndDispatchMessage(params: {
  ctxPayload: ReturnType<typeof buildMessageContext>["ctxPayload"];
  route: ReturnType<typeof buildMessageContext>["route"];
  storePath: string;
  chatId: string;
  chatType: string;
  config: OpenClawConfig;
  account: ResolvedWeComAccount;
  wsClient: WSClient;
  frame: WsFrame;
  state: MessageState;
  runtime: RuntimeEnv;
  onCleanup: () => void;
}): Promise<void> {
  const { ctxPayload, route, storePath, chatId, chatType, config, account, wsClient, frame, state, runtime, onCleanup } = params;
  const core = getWeComRuntime();
  const ctx: DeliverContext = { wsClient, frame, state, account, runtime };

  // 防止 onCleanup 被多次调用（onError 回调与 catch 块可能重复触发）
  let cleanedUp = false;
  const safeCleanup = () => {
    if (!cleanedUp) { cleanedUp = true; onCleanup(); }
  };

  let isShowThink = !(account.sendThinkingMessage ?? true);

  try {
    // 记录 inbound session 元数据（session 追踪）
    await core.channel.session.recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      updateLastRoute: chatType !== "group"
        ? {
            sessionKey: route.mainSessionKey,
            channel: CHANNEL_ID,
            to: `${CHANNEL_ID}:${chatId}`,
            accountId: route.accountId,
          }
        : undefined,
      onRecordError: (err) => {
        runtime.error?.(`[wecom] failed updating session meta: ${String(err)}`);
      },
    });

    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: config,
      dispatcherOptions: {
        onReplyStart: async () => {
          if (!isShowThink && state.streamId && !state.accumulatedText) {
            try {
              await sendThinkingReply({wsClient, frame, streamId: state.streamId, runtime, state})
            } catch (e) {
              runtime.error?.(`[wecom] sendThinkingReply threw err: ${String(e)}`);
            }
            isShowThink = true;
          }
        },
        deliver: async (payload, info) => {
          runtime.log?.(`[openclaw -> plugin] kind=${info.kind}, text=${payload.text ?? ''}, mediaUrl=${payload.mediaUrl ?? ''}, mediaUrls=${JSON.stringify(payload.mediaUrls ?? [])}`);

          // 累积文本
          if (payload.text) {
            state.accumulatedText += `${payload.text || ''}`;
          }

          // 发送媒体（统一走主动发送）
          const mediaUrls = payload.mediaUrls?.length ? payload.mediaUrls : payload.mediaUrl ? [payload.mediaUrl] : [];
          if (mediaUrls.length > 0) {
            try {
              await sendMediaBatch(ctx, mediaUrls);
            } catch (mediaErr) {
              // sendMediaBatch 内部异常（如 getDefaultMediaLocalRoots 不可用等）
              // 必须标记 state，否则 finishThinkingStream 会显示"处理完成"误导用户
              state.hasMediaFailed = true;
              const errMsg = String(mediaErr);
              const summary = `⚠️ 文件发送失败：内部处理异常，请升级 openclaw 到最新版本后重试。\n错误详情：${errMsg}`;
              state.mediaErrorSummary = state.mediaErrorSummary
                ? `${state.mediaErrorSummary}\n\n${summary}`
                : summary;
              runtime.error?.(`[wecom] sendMediaBatch threw: ${errMsg}`);
            }
          }

          // 中间帧：有可见文本时流式更新（流式过期后跳过，等 deliver 完成后主动发送）
          // 使用 maskTemplateCardBlocks 遮罩正在构建中的模板卡片代码块，
          // 避免 JSON 源码在流式输出过程中暴露给终端用户
          if (state.accumulatedText && !state.streamExpired) {
            try {
              const displayText = maskTemplateCardBlocks(state.accumulatedText, (...args: any[]) => runtime.log?.(...args));
              // if (displayText !== state.accumulatedText) {
              //   runtime.log?.(`[wecom][template-card] Mid-frame masked: original=${state.accumulatedText.length}chars, masked=${displayText.length}chars`);
              // }
              await sendWeComReply({ wsClient, frame, text: displayText, runtime, finish: false, streamId: state.streamId });
            } catch (err) {
              if (err instanceof StreamExpiredError) {
                state.streamExpired = true;
                runtime.log?.(`[wecom] Stream expired during intermediate reply, will fallback to proactive send`);
              } else {
                throw err;
              }
            }
          }
        },
        onError: (err, info) => {
          runtime.error?.(`[wecom] ${info.kind} reply failed: ${String(err)}`);
        },
      },
    });

    // 模板卡片检测与发送（在关闭 thinking 流之前独立处理）
    const cardResult = await processTemplateCardsIfNeeded({ wsClient, frame, state, account, runtime });
    if (cardResult) {
      // 卡片已发送，用剩余文本替换累积文本
      state.accumulatedText = cardResult.remainingText;
    }

    // 关闭 thinking 流
    await finishThinkingStream(ctx);
    safeCleanup();
  } catch (err) {
    runtime.error?.(`[wecom][plugin] Failed to process message: ${String(err)}`);
    // 即使 dispatch 抛异常，也需要处理卡片和关闭 thinking 流
    try {
      const cardResult = await processTemplateCardsIfNeeded({ wsClient, frame, state, account, runtime });
      if (cardResult) {
        state.accumulatedText = cardResult.remainingText;
      }
      await finishThinkingStream(ctx);
    } catch (finishErr) {
      runtime.error?.(`[wecom] Failed to finish thinking stream after dispatch error: ${String(finishErr)}`);
    }
    safeCleanup();
  }
}

/**
 * 解析并校验企业微信消息（防抖前阶段：Step 1-4）
 *
 * 执行消息解析、策略检查、媒体下载等前置操作，
 * 返回一个可用于防抖缓冲的 entry，或 null（消息被过滤/跳过时）。
 */
async function prepareWeComMessage(params: {
  frame: WsFrame;
  account: ResolvedWeComAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  wsClient: WSClient;
}): Promise<WeComMessageEntry | null> {
  const { frame, account, config, runtime, wsClient } = params;
  const body = frame.body as MessageBody;
  const chatId = body.chatid || body.from.userid;
  const chatType = body.chattype === "group" ? "group" : "direct";
  const messageId = body.msgid;
  const reqId = frame.headers.req_id;

  // Step 1: 解析消息内容
  const { textParts, imageUrls, imageAesKeys, fileUrls, fileAesKeys, quoteContent } = parseMessageContent(body);
  let text = textParts.join("\n").trim();

  // // 群聊中移除 @机器人 的提及标记
  // if (body.chattype === "group") {
  //   text = text.replace(/@\S+/g, "").trim();
  // }

  // 如果文本为空但存在引用消息，使用引用消息内容
  if (!text && quoteContent) {
    text = quoteContent;
    runtime.log?.("[wecom][plugin] Using quote content as message body (user only mentioned bot)");
  }

  // 如果既没有文本也没有图片也没有文件也没有引用内容，则跳过
  if (!text && imageUrls.length === 0 && fileUrls.length === 0) {
    runtime.log?.("[wecom][plugin] Skipping empty message (no text, image, file or quote)");
    return null;
  }

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
      return null;
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
    return null;
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

  return {
    frame,
    account,
    config,
    runtime,
    wsClient,
    text,
    mediaList,
    quoteContent,
    messageId,
    chatId,
    reqId,
  };
}

/**
 * 处理企业微信消息（Step 5-7）
 *
 * 接收解析后的消息数据，执行初始化状态、发送 thinking、路由到核心。
 * 同一会话中的消息通过串行队列保证按序执行。
 */
async function processWeComMessageNow(entry: WeComMessageEntry): Promise<void> {
  const { frame, account, config, runtime, wsClient, text, mediaList, quoteContent, messageId, chatId, reqId } = entry;

  // Step 5: 初始化消息状态
  setReqIdForChat(chatId, reqId, account.accountId);

  const streamId = generateReqId("stream");
  const state: MessageState = { accumulatedText: "", streamId };
  setMessageState(messageId, state);

  const cleanupState = () => {
    deleteMessageState(messageId);
  };

  // // Step 6: 发送"思考中"消息
  // const shouldSendThinking = account.sendThinkingMessage ?? true;
  // if (shouldSendThinking) {
  //   await sendThinkingReply({ wsClient, frame, streamId, runtime });
  // }

  // Step 7: 构建上下文并路由到核心处理流程（带整体超时保护）
  const { ctxPayload, route, storePath, chatId: resolvedChatId, chatType } = buildMessageContext(
    frame,
    account,
    config,
    text,
    mediaList,
    quoteContent,
    runtime,
  );
  // runtime.log?.(`[plugin -> openclaw] body=${text}, mediaPaths=${JSON.stringify(mediaList.map(m => m.path))}${quoteContent ? `, quote=${quoteContent}` : ''}`);

  try {
    await routeAndDispatchMessage({
      ctxPayload,
      route,
      storePath,
      chatId: resolvedChatId,
      chatType,
      config,
      account,
      wsClient,
      frame,
      state,
      runtime,
      onCleanup: cleanupState,
    });
  } catch (err) {
    runtime.error?.(`[wecom][plugin] Message processing failed: ${String(err)}`);
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
  const { account, config, runtime, abortSignal, setStatus } = options;

  runtime.log?.(`[${account.accountId}] [${PLUGIN_VERSION}] Initializing WSClient with SDK...`);

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
      maxAuthFailureAttempts: WS_MAX_AUTH_FAILURE_ATTEMPTS,
      scene: SCENE_WECOM_OPENCLAW,
      plug_version: PLUGIN_VERSION,
    });

    // 防止 cleanup 被多次调用（abort handler、error handler、disconnected_event 可能竞态触发）
    let cleanedUp = false;

    // 清理函数：确保所有资源被释放（幂等）
    const cleanup = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      stopMessageStateCleanup();
      await cleanupAccount(account.accountId);
    };

    // 处理中止信号（框架 stopChannel 会触发 abort）
    // resolve() 让 Promise settle → 框架清理 store.tasks/store.aborts
    if (abortSignal) {
      abortSignal.addEventListener("abort", async () => {
        runtime.log?.(`[${account.accountId}] Connection aborted`);
        wsClient.disconnect();
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


    // 监听被踢下线事件（服务端因新连接建立而主动断开旧连接）
    //
    // SDK 内部已设置 isManualClose=true 阻止 SDK 层自动重连，连接不会自行恢复。
    // **不 reject/resolve Promise**——保持 pending 以阻止框架层 auto-restart。
    //
    // 为什么不能 reject/resolve：
    //   - reject → 框架 auto-restart 介入 → 新连接建立 → 又被踢 → 两个实例互踢无限循环
    //   - resolve → 同上，框架 .then() 中的 auto-restart 也会触发
    //
    // Promise pending 的安全性：
    //   - store.tasks.has(id) = true → 阻止 Health Monitor 直接 startChannel（startChannel 检查 tasks.has）
    //   - 框架 stopChannel → abort() → abort handler 中 resolve() → tasks 正常清理
    //   - 用户修改配置 → config reload → stopChannel + startChannel → 正常恢复
    //
    // 显式调用 wsClient.disconnect() 确保 SDK 内部资源（定时器、队列等）完全释放。
    wsClient.on("event.disconnected_event", async () => {
      const errorMsg = `Kicked by server: a new connection was established elsewhere. Auto-restart is suppressed to avoid mutual kicking. Please check for duplicate instances.`;
      runtime.error?.(`[${account.accountId}] ${errorMsg}`);
      wsClient.disconnect();
      await cleanup();
      setStatus?.({
        accountId: account.accountId,
        running: false,
        lastError: errorMsg,
        lastStopAt: Date.now(),
      });
      // Promise 保持 pending，不触发 auto-restart
    });

    // 监听重连事件
    wsClient.on("reconnecting", (attempt) => {
      runtime.log?.(`[${account.accountId}] Reconnecting attempt ${attempt}...`);
    });

    // 监听错误事件
    wsClient.on("error", async (error) => {
      runtime.error?.(`[${account.accountId}] WebSocket error: ${error.message}`);

      if (error instanceof WSAuthFailureError) {
        // 认证失败重试次数用尽（SDK 层已重试 WS_MAX_AUTH_FAILURE_ATTEMPTS 次）。
        // 配置错误（如 botId/secret 无效），框架 auto-restart 也无法恢复。
        //
        // **不 reject/resolve Promise**——保持 pending 以阻止框架层 auto-restart。
        //
        // 为什么不能 reject/resolve：
        //   - reject/resolve → 框架 auto-restart（最多 10 次）× SDK 重试（5 次）= 60 次无意义尝试
        //   - 且 Health Monitor 每小时还会 resetRestartAttempts 再来一轮
        //
        // Promise pending 的安全性：同被踢下线场景
        //   - store.tasks.has(id) = true → 阻止 Health Monitor 直接 startChannel
        //   - 框架 stopChannel / config reload → abort handler 中 resolve() → 正常清理
        //   - 用户修改配置后框架通过 reload 机制重新启动
        const errorMsg = `Auth failure attempts exhausted (${WS_MAX_AUTH_FAILURE_ATTEMPTS} attempts). Please check botId/secret configuration.`;
        runtime.error?.(`[${account.accountId}] ${errorMsg}`);
        wsClient.disconnect();
        await cleanup();
        setStatus?.({
          accountId: account.accountId,
          running: false,
          lastError: errorMsg,
          lastStopAt: Date.now(),
        });
        return;
      }

      if (error instanceof WSReconnectExhaustedError) {
        // 网络断线重连次数用尽（SDK 层已重试 WS_MAX_RECONNECT_ATTEMPTS 次）。
        // 通常是网络/服务端问题，框架 auto-restart 可能恢复。
        //
        // reject Promise → 框架 auto-restart 介入（最多 MAX_RESTART_ATTEMPTS=10 次）
        // 总连接尝试次数 = (1 首次 + WS_MAX_RECONNECT_ATTEMPTS 重连) × (1 首轮 + 10 auto-restart)
        //                = 11 × 11 = 121 次
        //
        // 如果 Health Monitor 介入（每 5 分钟检查），会 resetRestartAttempts 重新计数，
        // 受限于 DEFAULT_MAX_RESTARTS_PER_HOUR=10，每小时最多额外 10 × 121 = 1210 次。
        // 但因网络断线通常是暂时性的，auto-restart + Health Monitor 的兜底机制是合理的。
        //
        // 显式调用 wsClient.disconnect() 确保 SDK 内部资源完全释放，
        // 避免旧实例的定时器/队列残留。
        wsClient.disconnect();
        cleanup().finally(() => reject(error));
        return;
      }
    });

    // 监听版本检查事件：收到 enter_check_update 时回复当前插件版本
    wsClient.on(EVENT_ENTER_CHECK_UPDATE as any, async (frame: WsFrame) => {
      try {
        // runtime.log?.(`[${account.accountId}] Received enter_check_update, replying with version=${PLUGIN_VERSION}`);
        await wsClient.reply(frame, { version: PLUGIN_VERSION }, CMD_ENTER_EVENT_REPLY);
      } catch (err) {
        // runtime.error?.(`[${account.accountId}] Failed to reply enter_check_update: ${String(err)}`);
      }
    });

    // 监听普通消息
    wsClient.on("message", async (frame: WsFrame) => {
      try {
        const entry = await prepareWeComMessage({
          frame,
          account,
          config,
          runtime,
          wsClient,
        });
        if (!entry) return;

        // 排队逻辑暂时关闭，直接处理消息
        // const { status } = enqueueWeComChatTask({
        //   accountId: entry.account.accountId,
        //   chatId: entry.chatId,
        //   task: () => processWeComMessageNow(entry),
        // });
        //
        // if (status === "queued") {
        //   runtime.log?.(`[wecom] Chat task queued for chat=${entry.chatId} (previous task still running)`);
        // }
        await processWeComMessageNow(entry);
      } catch (err) {
        runtime.error?.(`[${account.accountId}] Failed to process message: ${String(err)}`);
      }
    });

    // 监听所有事件回调（aibot_event_callback）。
    // 这里使用通用 event 监听，再按 eventtype 分发，兼容不同 SDK 版本在细分事件名上的差异。
    wsClient.on("event", async (frame: WsFrame) => {
      try {
        const eventBody = frame.body as MessageBody;
        const eventType = eventBody.event?.eventtype;
        runtime.log?.(
          `[${account.accountId}] Received event callback: eventtype=${eventType ?? ""}, msgid=${eventBody.msgid ?? ""}`,
        );

        if (eventType !== "template_card_event") {
          return;
        }

        const templateCardEvent = eventBody.event?.template_card_event;
        runtime.log?.(
          `[${account.accountId}] Received template_card_event: event_key=${templateCardEvent?.event_key ?? ""}, task_id=${templateCardEvent?.task_id ?? ""}`,
        );

        try {
          await updateTemplateCardOnEvent({
            frame,
            accountId: account.accountId,
            runtime,
            wsClient,
          });
        } catch (updateErr) {
          runtime.error?.(
            `[${account.accountId}] [template-card-update] Failed to update template card: ${String(updateErr)}`,
          );
        }

        const entry = await prepareWeComMessage({
          frame,
          account,
          config,
          runtime,
          wsClient,
        });
        if (entry) {
          await processWeComMessageNow(entry);
        }
      } catch (err) {
        runtime.error?.(`[${account.accountId}] Failed to process template_card_event: ${String(err)}`);
      }
    });

    runtime.log?.(`[${account.accountId}] Event listeners attached: message + event(template_card_event)`);

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
