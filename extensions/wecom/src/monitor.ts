/**
 * WeCom WebSocket monitor main module
 *
 * Responsible for:
 * - Establishing and managing WebSocket connections
 * - Coordinating message processing flow (parse → policy check → download images → route reply)
 * - Resource lifecycle management
 *
 * Sub-modules:
 * - message-parser.ts  : Message content parsing
 * - message-sender.ts  : Message sending (with timeout protection)
 * - media-handler.ts   : Image download and save (with timeout protection)
 * - group-policy.ts    : Group access control
 * - dm-policy.ts       : Direct message access control
 * - state-manager.ts   : Global state management (with TTL cleanup)
 * - timeout.ts         : Timeout utilities
 */

import * as os from "os";
import * as path from "path";
import {
  WSClient,
  generateReqId,
  WSAuthFailureError,
  WSReconnectExhaustedError,
} from "@wecom/aibot-node-sdk";
import type { WsFrame, Logger } from "@wecom/aibot-node-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { enqueueWeComChatTask } from "./chat-queue.js";
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
import { checkDmPolicy } from "./dm-policy.js";
import { processDynamicRouting } from "./dynamic-routing.js";
import { checkGroupPolicy } from "./group-policy.js";
import type { WeComMonitorOptions, MessageState } from "./interface.js";
import { downloadAndSaveImages, downloadAndSaveFiles } from "./media-handler.js";
import { uploadAndSendMedia } from "./media-uploader.js";
import { parseMessageContent, type MessageBody } from "./message-parser.js";
import { sendWeComReply, StreamExpiredError } from "./message-sender.js";
import { getDefaultMediaLocalRoots, resolveStateDir } from "./openclaw-compat.js";
import { getWeComRuntime } from "./runtime.js";
import { resolveWecomCommandAuthorization } from "./shared/command-auth.js";
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
import type { ResolvedWeComAccount, WeComConfig } from "./utils.js";
import { PLUGIN_VERSION } from "./version.js";

// ============================================================================
// Message entry type
// ============================================================================

/**
 * Message entry: stores parsing phase (Steps 1-4) results,
 * fed into the serial queue for consumption by processing phase (Steps 5-7).
 */
interface WeComMessageEntry {
  frame: WsFrame;
  account: ResolvedWeComAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  wsClient: WSClient;
  /** Parsed text content */
  text: string;
  /** Downloaded media file list */
  mediaList: Array<{ path: string; contentType?: string }>;
  /** Quoted message content */
  quoteContent?: string;
  /** Message ID */
  messageId: string;
  /** chatId (group ID or user ID) */
  chatId: string;
  /** Request ID */
  reqId: string;
}

// ============================================================================
// Media local path whitelist extension
// ============================================================================

/**
 * Extend getDefaultMediaLocalRoots() by adding the stateDir itself to the whitelist,
 * and merging any custom mediaLocalRoots configured by the user in WeComConfig.
 *
 * getDefaultMediaLocalRoots() only includes subdirectories under stateDir (media/agents/workspace/sandboxes),
 * but agents may generate files directly in the stateDir root (e.g. ~/.openclaw-dev/1.png),
 * so stateDir itself must also be whitelisted to avoid LocalMediaAccessError.
 *
 * Users can configure in openclaw.json:
 * {
 *   "channels": {
 *     "wecom": {
 *       "mediaLocalRoots": ["~/Downloads", "~/Documents"]
 *     }
 *   }
 * }
 */
async function getExtendedMediaLocalRoots(config?: WeComConfig): Promise<string[]> {
  // Get default whitelist from the compatibility layer (handles low-version SDK fallback internally)
  const defaults = await getDefaultMediaLocalRoots();
  const roots: string[] = [...defaults];

  // Only add safe subdirectories of stateDir (not the entire state tree,
  // which would expose sensitive files like credentials/sessions)
  const stateDir = path.resolve(resolveStateDir());
  for (const sub of ["media", "workspace", "sandboxes"]) {
    const dir = path.join(stateDir, sub);
    if (!roots.includes(dir)) {
      roots.push(dir);
    }
  }
  // Merge custom paths configured by the user in WeComConfig
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
// Media send error hints
// ============================================================================

/**
 * Build a plain-text error summary from the media send result (used to replace the thinking stream message shown to the user).
 *
 * Use plain text instead of markdown because replyStream only supports plain text.
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
// Re-exports (backward compatibility)
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
async function buildMessageContext(
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
    log: runtime?.log ? (...args: unknown[]) => runtime.log?.(...args) : undefined,
    error: runtime?.error ? (...args: unknown[]) => runtime.error?.(...args) : undefined,
  });

  // Apply dynamic routing result
  if (routingResult.routeModified) {
    route.agentId = routingResult.finalAgentId;
    route.sessionKey = routingResult.finalSessionKey;
  }
  // ===== End dynamic Agent routing injection =====

  // Build conversation label
  const fromLabel = chatType === "group" ? `group:${chatId}` : `user:${body.from.userid}`;

  // When only media with no text, use placeholder to identify media type
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

  // Use route.agentId to resolve storePath (session path isolation in multi-agent scenarios)
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });

  // Compute CommandAuthorized dynamically.
  //
  // DM-only: `resolveWecomCommandAuthorization` enforces dmPolicy / allowFrom,
  // which are direct-message access-control settings and MUST NOT apply to
  // group chats. Group authorization is already handled earlier in
  // `prepareWeComMessage` via `checkGroupPolicy` (groupPolicy + groupAllowFrom
  // + per-group sender allowlist), so for group chats we leave
  // CommandAuthorized = undefined and let the upper-layer access-groups
  // mechanism decide. Otherwise a sender outside the DM allowlist would get
  // CommandAuthorized=false and valid group commands would be blocked.
  let commandAuthorized: boolean | undefined;
  if (chatType !== "group") {
    const authz = await resolveWecomCommandAuthorization({
      core,
      cfg: config,
      accountConfig: account.config,
      rawBody: messageBody,
      senderUserId: body.from.userid,
    });
    commandAuthorized = authz.commandAuthorized;
  }

  // 构建标准消息上下文
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: messageBody,
    RawBody: messageBody,
    CommandBody: messageBody,

    MessageSid: body.msgid,

    From:
      chatType === "group" ? `${CHANNEL_ID}:group:${chatId}` : `${CHANNEL_ID}:${body.from.userid}`,
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

    CommandAuthorized: commandAuthorized,

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
      runtime.log?.(
        `[wecom] Stream expired during thinking reply, will fallback to proactive send`,
      );
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
async function sendMediaBatch(ctx: DeliverContext, mediaUrls: string[]): Promise<void> {
  const { wsClient, frame, state, account, runtime } = ctx;
  const body = frame.body as MessageBody;
  const chatId = body.chatid || body.from.userid;
  const mediaLocalRoots = await getExtendedMediaLocalRoots(account.config);

  runtime.log?.(
    `[wecom][debug] mediaLocalRoots=${JSON.stringify(mediaLocalRoots)}, mediaUrls=${JSON.stringify(mediaUrls)}`,
  );

  for (const mediaUrl of mediaUrls) {
    const result = await uploadAndSendMedia({
      wsClient,
      mediaUrl,
      chatId,
      mediaLocalRoots,
      log: (...args: unknown[]) => runtime.log?.(...args),
      errorLog: (...args: unknown[]) => runtime.error?.(...args),
    });

    if (result.ok) {
      state.hasMedia = true;
    } else {
      state.hasMediaFailed = true;
      runtime.error?.(
        `[wecom] Media send failed: url=${mediaUrl}, reason=${result.rejectReason || result.error}`,
      );
      // Collect error summary; later in finishThinkingStream it directly replaces the thinking stream to show the user
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
 *    3a. 同时存在失败 → 在文末追加错误摘要
 * 4. 媒体全部发送失败（无任何成功媒体） → 直接用错误摘要替换 thinking
 *    （否则 hasMedia 为 false 会跳过此处，thinking 永远卡住）
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
      finishText = finishText
        ? `${finishText}\n\n${state.mediaErrorSummary}`
        : state.mediaErrorSummary;
    } else if (!finishText) {
      finishText = "📎 文件已发送，请查收。";
    }
  } else if (state.hasMediaFailed && state.mediaErrorSummary) {
    // 媒体全部失败且无可见文本/卡片/成功媒体：直接用错误摘要替换 thinking，
    // 避免用户停留在空 thinking 动画上没有反馈。
    finishText = state.mediaErrorSummary;
  }

  if (finishText) {
    // 尝试流式发送；若已知过期或发送时发现过期，统一降级为主动发送
    let expired = state.streamExpired;
    if (!expired) {
      try {
        await sendWeComReply({
          wsClient,
          frame,
          text: finishText,
          runtime,
          finish: true,
          streamId: state.streamId,
        });
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
 * Route the message to the core processing pipeline and handle replies
 */
async function routeAndDispatchMessage(params: {
  ctxPayload: Awaited<ReturnType<typeof buildMessageContext>>["ctxPayload"];
  route: Awaited<ReturnType<typeof buildMessageContext>>["route"];
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
  const {
    ctxPayload,
    route,
    storePath,
    chatId,
    chatType,
    config,
    account,
    wsClient,
    frame,
    state,
    runtime,
    onCleanup,
  } = params;
  const core = getWeComRuntime();
  const ctx: DeliverContext = { wsClient, frame, state, account, runtime };

  // Prevent onCleanup from being called multiple times (onError callback and catch block may trigger redundantly)
  let cleanedUp = false;
  const safeCleanup = () => {
    if (!cleanedUp) {
      cleanedUp = true;
      onCleanup();
    }
  };

  let isShowThink = !(account.sendThinkingMessage ?? true);

  try {
    // 记录 inbound session 元数据（session 追踪）
    await core.channel.session.recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      updateLastRoute:
        chatType !== "group"
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
              await sendThinkingReply({
                wsClient,
                frame,
                streamId: state.streamId,
                runtime,
                state,
              });
            } catch (e) {
              runtime.error?.(`[wecom] sendThinkingReply threw err: ${String(e)}`);
            }
            isShowThink = true;
          }
        },
        deliver: async (payload, info) => {
          runtime.log?.(
            `[openclaw -> plugin] kind=${info.kind}, text=${payload.text ?? ""}, mediaUrl=${payload.mediaUrl ?? ""}, mediaUrls=${JSON.stringify(payload.mediaUrls ?? [])}`,
          );

          // 累积文本
          if (payload.text) {
            state.accumulatedText += payload.text || "";
          }

          // Send media (all via proactive send)
          const mediaUrls = payload.mediaUrls?.length
            ? payload.mediaUrls
            : payload.mediaUrl
              ? [payload.mediaUrl]
              : [];
          if (mediaUrls.length > 0) {
            try {
              await sendMediaBatch(ctx, mediaUrls);
            } catch (mediaErr) {
              // Internal exception from sendMediaBatch (e.g. getDefaultMediaLocalRoots unavailable, etc.)
              // Must mark state, otherwise finishThinkingStream would show "处理完成" misleading the user
              state.hasMediaFailed = true;
              const errMsg = String(mediaErr);
              const summary = `⚠️ 文件发送失败：内部处理异常，请升级 openclaw 到最新版本后重试。\n错误详情：${errMsg}`;
              state.mediaErrorSummary = state.mediaErrorSummary
                ? `${state.mediaErrorSummary}\n\n${summary}`
                : summary;
              runtime.error?.(`[wecom] sendMediaBatch threw: ${errMsg}`);
            }
          }

          // Intermediate frame: stream update when visible text exists (skip if stream expired, wait for proactive send after deliver completes)
          if (state.accumulatedText && !state.streamExpired) {
            try {
              await sendWeComReply({
                wsClient,
                frame,
                text: state.accumulatedText,
                runtime,
                finish: false,
                streamId: state.streamId,
              });
            } catch (err) {
              if (err instanceof StreamExpiredError) {
                state.streamExpired = true;
                runtime.log?.(
                  `[wecom] Stream expired during intermediate reply, will fallback to proactive send`,
                );
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

    // 关闭 thinking 流
    await finishThinkingStream(ctx);
    safeCleanup();
  } catch (err) {
    runtime.error?.(`[wecom][plugin] Failed to process message: ${String(err)}`);
    // 即使 dispatch 抛异常，也需要关闭 thinking 流
    try {
      await finishThinkingStream(ctx);
    } catch (finishErr) {
      runtime.error?.(
        `[wecom] Failed to finish thinking stream after dispatch error: ${String(finishErr)}`,
      );
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

  // Step 1: Parse message content
  const { textParts, imageUrls, imageAesKeys, fileUrls, fileAesKeys, quoteContent } =
    parseMessageContent(body);
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

  // Step 4: Download and save images and files
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
 * Process a WeCom message (Steps 5-7)
 *
 * Receives parsed message data, initializes state, sends thinking message, and routes to core.
 * Messages within the same conversation are processed sequentially via a serial queue.
 */
async function processWeComMessageNow(entry: WeComMessageEntry): Promise<void> {
  const {
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
  } = entry;

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
  const {
    ctxPayload,
    route,
    storePath,
    chatId: resolvedChatId,
    chatType,
  } = await buildMessageContext(frame, account, config, text, mediaList, quoteContent, runtime);
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
// SDK Logger adapter
// ============================================================================

/**
 * Create a Logger that adapts to RuntimeEnv
 */
function createSdkLogger(runtime: RuntimeEnv, accountId: string): Logger {
  return {
    debug: (message: string, ...args: unknown[]) => {
      runtime.log?.(`[${accountId}] ${message}`, ...args);
    },
    info: (message: string, ...args: unknown[]) => {
      runtime.log?.(`[${accountId}] ${message}`, ...args);
    },
    warn: (message: string, ...args: unknown[]) => {
      runtime.log?.(`[${accountId}] WARN: ${message}`, ...args);
    },
    error: (message: string, ...args: unknown[]) => {
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

    // Prevent cleanup from being called multiple times (abort handler, error handler, disconnected_event may race)
    let cleanedUp = false;

    // Cleanup function: ensure all resources are released (idempotent)
    const cleanup = async () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      stopMessageStateCleanup();
      await cleanupAccount(account.accountId);
    };

    // Handle abort signal (framework stopChannel triggers abort)
    // resolve() settles the Promise → framework cleans up store.tasks/store.aborts
    if (abortSignal) {
      abortSignal.addEventListener("abort", async () => {
        runtime.log?.(`[${account.accountId}] Connection aborted`);
        wsClient.disconnect();
        await cleanup();
        resolve();
      });
    }

    // Listen for connection events
    wsClient.on("connected", () => {
      runtime.log?.(`[${account.accountId}] WebSocket connected`);
    });

    // Listen for authentication success event
    wsClient.on("authenticated", () => {
      runtime.log?.(`[${account.accountId}] Authentication successful`);
      setWeComWebSocket(account.accountId, wsClient);
    });

    // Listen for disconnect events
    wsClient.on("disconnected", (reason) => {
      runtime.log?.(`[${account.accountId}] WebSocket disconnected: ${reason}`);
    });

    // Listen for kicked-offline event (server disconnects old connection when a new one is established)
    //
    // The SDK internally sets isManualClose=true to prevent SDK-level auto-reconnect; the connection will not recover.
    // **Do NOT reject/resolve the Promise** — keep it pending to prevent framework-level auto-restart.
    //
    // Why not reject/resolve:
    //   - reject → framework auto-restart kicks in → new connection established → kicked again → two instances kick each other in an infinite loop
    //   - resolve → same issue, framework .then() auto-restart also triggers
    //
    // Promise pending safety:
    //   - store.tasks.has(id) = true → prevents Health Monitor from directly calling startChannel (startChannel checks tasks.has)
    //   - framework stopChannel → abort() → abort handler resolve() → tasks cleaned up normally
    //   - user modifies config → config reload → stopChannel + startChannel → normal recovery
    //
    // Explicitly call wsClient.disconnect() to ensure SDK internal resources (timers, queues, etc.) are fully released.
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
      // Keep Promise pending, do not trigger auto-restart
    });

    // 监听重连事件
    wsClient.on("reconnecting", (attempt) => {
      runtime.log?.(`[${account.accountId}] Reconnecting attempt ${attempt}...`);
    });

    // Listen for error events
    wsClient.on("error", async (error) => {
      runtime.error?.(`[${account.accountId}] WebSocket error: ${error.message}`);

      if (error instanceof WSAuthFailureError) {
        // Auth failure retry attempts exhausted (SDK has retried WS_MAX_AUTH_FAILURE_ATTEMPTS times).
        // Config error (e.g. invalid botId/secret); framework auto-restart cannot recover.
        //
        // **Do NOT reject/resolve the Promise** — keep it pending to prevent framework-level auto-restart.
        //
        // Why not reject/resolve:
        //   - reject/resolve → framework auto-restart (max 10 times) × SDK retry (5 times) = 60 pointless attempts
        //   - Plus Health Monitor resets restart attempts every hour for another round
        //
        // Promise pending safety: same as kicked-offline scenario
        //   - store.tasks.has(id) = true → prevents Health Monitor from directly calling startChannel
        //   - framework stopChannel / config reload → abort handler resolve() → normal cleanup
        //   - user fixes config, framework restarts via reload mechanism
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
        void cleanup().finally(() => reject(error));
        return;
      }
    });

    // 监听版本检查事件：收到 enter_check_update 时回复当前插件版本
    // @ts-expect-error -- EVENT_ENTER_CHECK_UPDATE is a valid WS event but not in SDK type map
    wsClient.on(EVENT_ENTER_CHECK_UPDATE as string, async (frame: WsFrame) => {
      try {
        // runtime.log?.(`[${account.accountId}] Received enter_check_update, replying with version=${PLUGIN_VERSION}`);
        await wsClient.reply(frame, { version: PLUGIN_VERSION }, CMD_ENTER_EVENT_REPLY);
      } catch {}
    });

    // Listen for regular messages
    wsClient.on("message", async (frame: WsFrame) => {
      try {
        const entry = await prepareWeComMessage({
          frame,
          account,
          config,
          runtime,
          wsClient,
        });
        if (!entry) {
          return;
        }

        // Per-chat serialization: messages within the same (accountId, chatId)
        // run serially so turn state isn't interleaved across concurrent
        // messages. Different chats remain independent and are processed in
        // parallel. The listener returns immediately after enqueueing; task
        // errors are caught inside the task so the queue keeps draining.
        const { status } = enqueueWeComChatTask({
          accountId: entry.account.accountId,
          chatId: entry.chatId,
          task: async () => {
            try {
              await processWeComMessageNow(entry);
            } catch (err) {
              runtime.error?.(`[${account.accountId}] Failed to process message: ${String(err)}`);
            }
          },
        });

        if (status === "queued") {
          runtime.log?.(
            `[wecom] Chat task queued for chat=${entry.chatId} (previous task still running)`,
          );
        }
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
      } catch (err) {
        runtime.error?.(`[${account.accountId}] Failed to process event callback: ${String(err)}`);
      }
    });

    runtime.log?.(`[${account.accountId}] Event listeners attached: message + event`);

    // 启动前预热 reqId 缓存，确保完成后再建立连接，避免 getSync 在预热完成前返回 undefined
    warmupReqIdStore(account.accountId, (...args) => runtime.log?.(...args))
      .then((count) => {
        runtime.log?.(`[${account.accountId}] Warmed up ${count} reqId entries from disk`);
      })
      .catch((err) => {
        runtime.error?.(`[${account.accountId}] Failed to warmup reqId store: ${String(err)}`);
      })
      .finally(() => {
        // Connect regardless of whether warmup succeeded or failed
        wsClient.connect();
      });
  });
}
