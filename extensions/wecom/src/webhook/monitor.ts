/**
 * Webhook 核心消息处理
 *
 * 从 @mocrane/wecom monitor.ts 部分迁移 + 重构。
 * 负责：入站消息解析、防抖聚合、Agent 调度、流式输出、超时兜底。
 */

import { pathToFileURL } from "node:url";
import os from "node:os";
import type {
  WecomWebhookTarget,
  WebhookInboundMessage,
} from "./types.js";
import {
  resolveWecomCommandAuthorization,
  buildWecomUnauthorizedCommandPrompt,
} from "./command-auth.js";
import {
  STREAM_MAX_BYTES,
  BOT_WINDOW_MS,
  BOT_SWITCH_MARGIN_MS,
  REQUEST_TIMEOUT_MS,
} from "./types.js";
import { getMonitorState } from "./gateway.js";
import { sendText as sendAgentText, uploadMedia, sendMedia as sendAgentMedia } from "../agent/api-client.js";
import { wecomFetch } from "./http.js";
import {
  truncateUtf8Bytes,
  appendDmContent,
  buildFallbackPrompt,
  extractLocalFilePathsFromText,
  extractLocalImagePathsFromText,
  looksLikeSendLocalFileIntent,
  computeTaskKey,
  isAgentConfigured,
  guessContentTypeFromPath,
  buildStreamReplyFromState,
  computeMd5,
  resolveWecomMediaMaxBytes,
  buildCfgForDispatch,
  processInboundMessage,
  MIME_BY_EXT,
  resolveWecomSenderUserId,
  buildInboundBody,
  hasMedia,
  buildStreamResponse,
  buildStreamPlaceholderReply,
  buildStreamTextPlaceholderReply,
} from "./helpers.js";
import { processDynamicRouting } from "../dynamic-routing.js";
// ============================================================================
// 入站消息处理
// ============================================================================

/**
 * 处理入站消息
 *
 * 解析消息类型和内容，创建/获取 stream，加入防抖队列，返回占位符响应。
 */
export async function handleInboundMessage(
  target: WecomWebhookTarget,
  message: WebhookInboundMessage,
  timestamp: string,
  nonce: string,
  proxyUrl?: string,
  msgFilterData?: {
    senderUserId?: string;
    chatId?: string;
  }
): Promise<Record<string, unknown> | null> {
  const state = getMonitorState();

  const { streamStore, activeReplyStore } = state;
  const msgid = message.msgid;

  // msgid 去重检查
  if (msgid) {
    const existingStreamId = streamStore.getStreamByMsgId(msgid);
    if (existingStreamId) {
      const existingStream = streamStore.getStream(existingStreamId);
      if (existingStream) {
        target.runtime.log?.(
          `[webhook] 消息去重: msgid=${msgid} 已关联 streamId=${existingStreamId}`,
        );
        return buildStreamResponse(existingStream);
      }
    }
  }

  // 解析消息内容（对齐原版 buildInboundBody）
  const msgContent = buildInboundBody(message);
  if (!msgContent && !hasMedia(message)) {
    target.runtime.log?.(`[webhook] 空消息内容 (type=${message.msgtype}, msgid=${msgid})`);
    return null;
  }

  const userid = msgFilterData?.senderUserId ?? "";
  const chatType = String(message.chattype ?? "").trim().toLowerCase();
  const chatId = msgFilterData?.chatId ?? message.chatid ?? "";
  // 原版 conversationKey 格式：wecom:{accountId}:{userid}:{chatId}
  // 单聊时 chatId 等于 userid
  const resolvedChatId = chatId || userid;
  const conversationKey = `wecom:${target.account.accountId}:${userid}:${resolvedChatId}`;

  // 加入防抖队列
  const result = streamStore.addPendingMessage({
    conversationKey,
    target,
    msg: message,
    msgContent: msgContent ?? "",
    nonce,
    timestamp,
    debounceMs: (target.account.config as any)?.debounceMs
  });

  const { streamId, status } = result;

  target.runtime.log?.(
    `[webhook] 消息入队 (status=${status}, streamId=${streamId}, convKey=${conversationKey})`,
  );

  // 存储 response_url（对齐原版：同时保存 proxyUrl 用于后续出站请求的代理）
  if (message.response_url) {
    activeReplyStore.store(
      streamId,
      message.response_url,
      proxyUrl,
    );
  }

  // 更新 stream 的元数据
  streamStore.updateStream(streamId, (s) => {
    s.userId = userid;
    s.chatType = chatType === "group" ? "group" : "direct";
    s.chatId = resolvedChatId;
    s.aibotid = target.account.botId;
  });

  // 根据 status 返回不同的占位符响应（对齐原版 status 分支处理）
  const defaultPlaceholder = (target.account.config as any)?.streamPlaceholderContent;
  const queuedPlaceholder = "已收到，已排队处理中...";
  const mergedQueuedPlaceholder = "已收到，已合并排队处理中...";

  if (status === "active_new") {
    // 第一条消息，返回默认占位符
    return buildStreamPlaceholderReply(streamId, defaultPlaceholder);
  }

  if (status === "queued_new") {
    // 进入排队批次，返回排队提示
    target.runtime.log?.(`[webhook] queue: 已进入下一批次 streamId=${streamId} msgid=${String(message.msgid ?? "")}`);
    return buildStreamPlaceholderReply(streamId, queuedPlaceholder);
  }

  // active_merged / queued_merged：合并进某个批次
  // 为本条 msgid 创建一个"回执 stream"，先显示"已合并排队"，并在批次结束时自动更新为"已合并处理完成"
  const ackStreamId = streamStore.createStream({ msgid: message.msgid ? String(message.msgid) : undefined });
  streamStore.updateStream(ackStreamId, (s) => {
    s.finished = false;
    s.started = true;
    s.content = mergedQueuedPlaceholder;
  });
  if (message.msgid) {
    streamStore.setStreamIdForMsgId(String(message.msgid), ackStreamId);
  }
  streamStore.addAckStreamForBatch({ batchStreamId: streamId, ackStreamId });
  target.runtime.log?.(
    `[webhook] queue: 已合并排队（回执流）ackStreamId=${ackStreamId} mergedIntoStreamId=${streamId} msgid=${String(message.msgid ?? "")}`,
  );
  return buildStreamTextPlaceholderReply(ackStreamId, mergedQueuedPlaceholder);
}

// ============================================================================
// stream_refresh 处理
// ============================================================================

/**
 * 处理 stream_refresh 请求
 *
 * 返回 StreamState 中的当前累积内容、图片附件和 finish 标记。
 */
export async function handleStreamRefresh(
  target: WecomWebhookTarget,
  message: WebhookInboundMessage,
): Promise<Record<string, unknown> | null> {
  const state = getMonitorState();

  const streamId = String(message.stream?.id ?? "").trim();
  if (!streamId) {
    target.runtime.log?.("[webhook] stream_refresh 缺少 stream_id");
    return null;
  }

  const stream = state.streamStore.getStream(streamId);
  if (!stream) {
    target.runtime.log?.(`[webhook] stream_refresh: stream ${streamId} 不存在`);
    // 返回 finish=true 以通知客户端停止轮询
    return {
      msgtype: "stream",
      stream: { id: streamId, finish: true, content: "" },
    };
  }

  target.runtime.log?.(
    `[webhook] stream_refresh (streamId=${streamId}, started=${stream.started}, finished=${stream.finished}, len=${stream.content.length})`,
  );

  return buildStreamResponse(stream);
}

// ============================================================================
// enter_chat 处理
// ============================================================================

/**
 * 处理 enter_chat 事件
 *
 * 返回可配置的欢迎消息。
 */
export async function handleEnterChat(
  target: WecomWebhookTarget,
  message: WebhookInboundMessage,
): Promise<Record<string, unknown> | null> {
  const welcomeText = target.account.welcomeText;

  const userId = message.from?.userid ?? "unknown";
  target.runtime.log?.(
    `[webhook] enter_chat (userId=${userId}, account=${target.account.accountId})`,
  );

  if (welcomeText) {
    return {
      msgtype: "text",
      text: { content: welcomeText },
    };
  }

  // 无欢迎消息配置，返回空回复
  return null;
}

// ============================================================================
// template_card_event 处理
// ============================================================================

/**
 * 处理模板卡片事件（对齐原版 template_card_event 逻辑）
 *
 * 原版流程：
 * 1. msgid 去重：跳过已处理的卡片事件
 * 2. 解析卡片交互数据：event_key、selected_items、task_id
 * 3. 立即返回空加密回复（非阻塞）
 * 4. 创建 stream 并标记开始
 * 5. 存储 response_url（用于后续推送）
 * 6. 构造交互描述文本，作为文本消息启动 Agent 处理
 */
export async function handleTemplateCardEvent(
  target: WecomWebhookTarget,
  message: WebhookInboundMessage,
  timestamp: string,
  nonce: string,
  proxyUrl?: string,
): Promise<Record<string, unknown> | null> {
  const state = getMonitorState();
  const { streamStore, activeReplyStore } = state;

  const msgid = message.msgid ? String(message.msgid) : undefined;

  // 1. msgid 去重：跳过已处理的卡片事件
  if (msgid && streamStore.getStreamByMsgId(msgid)) {
    target.runtime.log?.(
      `[webhook] template_card_event: already processed msgid=${msgid}, skipping`,
    );
    return {};
  }

  // 2. 解析卡片交互数据
  const cardEvent = message.event?.template_card_event as Record<string, unknown> | undefined;
  let interactionDesc = `[卡片交互] 按钮: ${String(cardEvent?.event_key ?? "unknown")}`;

  // 解析选择项（selected_items.selected_item）
  const selectedItems = cardEvent?.selected_items as Record<string, unknown> | undefined;
  const selectedItemList = selectedItems?.selected_item as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(selectedItemList) && selectedItemList.length > 0) {
    const selects = selectedItemList.map((i) => {
      const questionKey = String(i.question_key ?? "");
      const optionIds = (i.option_ids as Record<string, unknown> | undefined)?.option_id;
      const optionStr = Array.isArray(optionIds) ? optionIds.join(",") : String(optionIds ?? "");
      return `${questionKey}=${optionStr}`;
    });
    interactionDesc += ` 选择: ${selects.join("; ")}`;
  }

  // 解析任务 ID
  if (cardEvent?.task_id) {
    interactionDesc += ` (任务ID: ${String(cardEvent.task_id)})`;
  }

  target.runtime.log?.(
    `[webhook] template_card_event (event_key=${String(cardEvent?.event_key ?? "N/A")}, msgid=${msgid ?? "N/A"})`,
  );

  // 3. 创建 stream 并标记开始
  const streamId = streamStore.createStream({ msgid });
  streamStore.markStarted(streamId);

  // 4. 存储 response_url（用于后续 Agent 输出推送）
  if (message.response_url) {
    activeReplyStore.store(streamId, message.response_url, proxyUrl);
  }

  // 5. 构造交互描述作为文本消息，异步启动 Agent 处理
  const syntheticMessage: WebhookInboundMessage = {
    ...message,
    msgtype: "text",
    text: { content: interactionDesc },
  };

  // 异步启动 Agent（不阻塞 HTTP 响应）
  startAgentForStream({
    target,
    accountId: target.account.accountId,
    msg: syntheticMessage,
    streamId,
    mergedContents: undefined,
    mergedMsgids: undefined,
  }).catch((err) => {
    target.runtime.error?.(`[webhook] template_card_event Agent failed: ${String(err)}`);
  });

  // 6. 立即返回空回复（非阻塞，原版返回 {} 加密后的）
  return {};
}

// ============================================================================
// Agent 调度（startAgentForStream）
// ============================================================================

/**
 * **startAgentForStream (启动 Agent 处理流程)**
 *
 * 将接收到的（或聚合的）消息转换为 OpenClaw 内部格式，并分发给对应的 Agent。
 * 包含：
 * 1. 消息解密与媒体保存。
 * 2. 路由解析 (Agent Route)。
 * 3. 会话记录 (Session Recording)。
 * 4. 触发 Agent 响应 (Dispatch Reply)。
 * 5. 处理 Agent 输出（包括文本、Markdown 表格转换、<think> 标签保护、模板卡片识别）。
 */
export async function startAgentForStream(params: {
  target: WecomWebhookTarget;
  accountId: string;
  msg: WebhookInboundMessage;
  streamId: string;
  mergedContents?: string; // Combined content from debounced messages
  mergedMsgids?: string[];
}): Promise<void> {
  const { target, msg, streamId } = params;

  const state = getMonitorState();
  const { streamStore } = state;
  const stream = streamStore.getStream(streamId);
  if (!stream) {
    target.runtime.log?.(`[webhook] stream ${streamId} 不存在，跳过 Agent 调度`);
    return;
  }

  // WS 长连接模式标记：跳过 Webhook 专属的 Agent 私信兜底逻辑（对齐 lh 版）
  const isWsMode = Boolean(stream.wsMode);

  const core = target.core;
  const config = target.config;
  const account = target.account;

  const userid = resolveWecomSenderUserId(msg) || "unknown";
  const chatType = msg.chattype === "group" ? "group" : "direct";
  const chatId = msg.chattype === "group" ? (msg.chatid?.trim() || "unknown") : userid;
  const taskKey = computeTaskKey(target, msg);
  const aibotid = String(msg.aibotid ?? "").trim() || undefined;

  // 更新 Stream 状态：记录上下文信息（用户ID、ChatType等）
  streamStore.updateStream(streamId, (s) => {
    s.userId = userid;
    s.chatType = chatType === "group" ? "group" : "direct";
    s.chatId = chatId;
    s.taskKey = taskKey;
    s.aibotid = aibotid;
  });

  // ──────────────────────────────────────────────────────────────────
  // 1. 入站消息处理（媒体解密）—— 对齐原版 processInboundMessage
  // ──────────────────────────────────────────────────────────────────
  let { body: rawBody, media } = await processInboundMessage(target, msg);

  // 若存在从防抖逻辑聚合来的多条消息内容，则覆盖 rawBody
  if (params.mergedContents) {
    rawBody = params.mergedContents;
  }

  // ──────────────────────────────────────────────────────────────────
  // 2. P0: 本机路径文件发送
  // P0: 群聊/私聊里“让 Bot 发送本机图片/文件路径”的场景，优先走 Bot 原会话交付（图片），
  // 非图片文件则走 Agent 私信兜底，并确保 Bot 会话里有中文提示。
  //
  // 典型背景：Agent 主动发群 chatId（wr/wc...）在很多情况下会 86008，无论怎么“修复”都发不出去；
  // 这种请求如果能被动回复图片，就必须由 Bot 在群内交付。
  // ──────────────────────────────────────────────────────────────────
  const directLocalPaths = extractLocalFilePathsFromText(rawBody);
  if (directLocalPaths.length) {
    target.runtime.log?.(
      `local-path: 检测到用户消息包含本机路径 count=${directLocalPaths.length} intent=${looksLikeSendLocalFileIntent(rawBody)}`,
    );
  }
  if (directLocalPaths.length && looksLikeSendLocalFileIntent(rawBody)) {
    const fs = await import("node:fs/promises");
    const pathModule = await import("node:path");
    const imageExts = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

    const imagePaths: string[] = [];
    const otherPaths: string[] = [];
    for (const p of directLocalPaths) {
      const ext = pathModule.extname(p).slice(1).toLowerCase();
      if (imageExts.has(ext)) imagePaths.push(p);
      else otherPaths.push(p);
    }

    // 图片：通过 Bot 原会话交付（base64 msg_item）
    if (imagePaths.length > 0 && otherPaths.length === 0) {
      const loaded: Array<{ base64: string; md5: string; path: string }> = [];
      for (const p of imagePaths) {
        try {
          const buf = await fs.readFile(p);
          const base64 = buf.toString("base64");
          const md5 = computeMd5(buf);
          loaded.push({ base64, md5, path: p });
        } catch (err) {
          target.runtime.error?.(`[webhook] local-path: 读取图片失败 path=${p}: ${String(err)}`);
        }
      }

      if (loaded.length > 0) {
        streamStore.updateStream(streamId, (s) => {
          s.images = loaded.map(({ base64, md5 }) => ({ base64, md5 }));
          s.content = loaded.length === 1
            ? `已发送图片（${pathModule.basename(loaded[0]!.path)}）`
            : `已发送 ${loaded.length} 张图片`;
          s.finished = true;
        });

        // 通过 response_url 推送（对齐 lh 版：直接 POST JSON，不加密）
        const responseUrl = getActiveReplyUrl(streamId);
        if (responseUrl) {
          try {
            const finalReply = buildStreamReplyFromState(streamStore.getStream(streamId)!, STREAM_MAX_BYTES) as unknown as Record<string, unknown>;
            await useActiveReplyOnce(streamId, async ({ responseUrl, proxyUrl }) => {
              const res = await wecomFetch(
                responseUrl,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(finalReply),
                },
                { proxyUrl, timeoutMs: REQUEST_TIMEOUT_MS },
              );
              if (!res.ok) throw new Error(`local-path image push failed: ${res.status}`);
            });
            target.runtime.log?.(`[webhook] local-path: 已通过 Bot response_url 推送图片 frames=final images=${loaded.length}`);
          } catch (err) {
            target.runtime.error?.(`[webhook] local-path: Bot 主动推送图片失败（将依赖 stream_refresh 拉取）: ${String(err)}`);
          }
        } else {
          target.runtime.log?.(`[webhook] local-path: 无 response_url，等待 stream_refresh 拉取最终图片`);
        }
        // 该消息已完成，推进队列处理下一批
        streamStore.onStreamFinished(streamId);
        return;
      }

      // 图片路径都读取失败时的兜底处理（对齐 lh 版 Webhook 模式）
      const agentOk = isAgentConfigured(target);
      const fallbackName = imagePaths.length === 1
        ? (imagePaths[0]!.split("/").pop() || "image")
        : `${imagePaths.length} 张图片`;
      const prompt = buildFallbackPrompt({
        kind: "media",
        agentConfigured: agentOk,
        userId: userid,
        filename: fallbackName,
        chatType,
      });

      streamStore.updateStream(streamId, (s) => {
        s.fallbackMode = "error";
        s.finished = true;
        s.content = prompt;
        s.fallbackPromptSentAt = s.fallbackPromptSentAt ?? Date.now();
      });

      try {
        await sendBotFallbackPromptNow({ streamId, text: prompt });
        target.runtime.log?.(`[webhook] local-path: 图片读取失败后已推送兜底提示`);
      } catch (err) {
        target.runtime.error?.(`[webhook] local-path: 图片读取失败后的兜底提示推送失败: ${String(err)}`);
      }
      // TODO: agent兜底这里需要有agent对象，待对齐lh版本
      if (agentOk && userid && userid !== "unknown") {
        for (const p of imagePaths) {
          const guessedType = guessContentTypeFromPath(p);
          try {
            await agentDmMedia({
              target,
              userId: userid,
              mediaUrlOrPath: p,
              contentType: guessedType,
              filename: p.split("/").pop() || "image",
            });
            streamStore.updateStream(streamId, (s) => {
              s.agentMediaKeys = Array.from(new Set([...(s.agentMediaKeys ?? []), p]));
            });
            target.runtime.log?.(
              `[webhook] local-path: 图片已通过 Agent 私信发送 user=${userid} path=${p} contentType=${guessedType ?? "unknown"}`,
            );
          } catch (err) {
            target.runtime.error?.(`[webhook] local-path: 图片 Agent 私信兜底失败 path=${p}: ${String(err)}`);
          }
        }
      }
      streamStore.onStreamFinished(streamId);
      return;
    }

    // 非图片文件：Bot 提示 + Agent 私信兜底（对齐 lh 版 Webhook 模式）
    if (otherPaths.length > 0) {
      const agentOk = isAgentConfigured(target);

      const filename = otherPaths.length === 1 ? otherPaths[0]!.split("/").pop()! : `${otherPaths.length} 个文件`;
      const prompt = buildFallbackPrompt({
        kind: "media",
        agentConfigured: agentOk,
        userId: userid,
        filename,
        chatType,
      });

      streamStore.updateStream(streamId, (s) => {
        s.fallbackMode = "media";
        s.finished = true;
        s.content = prompt;
        s.fallbackPromptSentAt = s.fallbackPromptSentAt ?? Date.now();
      });

      try {
        await sendBotFallbackPromptNow({ streamId, text: prompt });
        target.runtime.log?.(`[webhook] local-path: 文件兜底提示已推送`);
      } catch (err) {
        target.runtime.error?.(`[webhook] local-path: 文件兜底提示推送失败: ${String(err)}`);
      }

      if (!agentOk) {
        streamStore.onStreamFinished(streamId);
        return;
      }
      if (!userid || userid === "unknown") {
        target.runtime.error?.(`[webhook] local-path: 无法识别触发者 userId，无法 Agent 私信发送文件`);
        streamStore.onStreamFinished(streamId);
        return;
      }

      // TODO: agent兜底这里需要有agent对象，待对齐lh版本
      for (const p of otherPaths) {
        const alreadySent = streamStore.getStream(streamId)?.agentMediaKeys?.includes(p);
        if (alreadySent) continue;
        const guessedType = guessContentTypeFromPath(p);
        try {
          await agentDmMedia({
            target,
            userId: userid,
            mediaUrlOrPath: p,
            contentType: guessedType,
            filename: p.split("/").pop() || "file",
          });
          streamStore.updateStream(streamId, (s) => {
            s.agentMediaKeys = Array.from(new Set([...(s.agentMediaKeys ?? []), p]));
          });
          target.runtime.log?.(
            `[webhook] local-path: 文件已通过 Agent 私信发送 user=${userid} path=${p} contentType=${guessedType ?? "unknown"}`,
          );
        } catch (err) {
          target.runtime.error?.(`[webhook] local-path: Agent 私信发送文件失败 path=${p}: ${String(err)}`);
        }
      }
      streamStore.onStreamFinished(streamId);
      return;
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // 3. 保存媒体文件供 Agent 使用
  // ──────────────────────────────────────────────────────────────────
  let mediaPath: string | undefined;
  let mediaType: string | undefined;
  if (media) {
    try {
      const maxBytes = resolveWecomMediaMaxBytes(config);
      const saved = await core.channel.media.saveMediaBuffer(
        media.buffer,
        media.contentType,
        "inbound",
        maxBytes,
        media.filename,
      );
      mediaPath = saved.path;
      mediaType = saved.contentType;
      target.runtime.log?.(`[webhook] 入站媒体已保存: ${mediaPath} (${mediaType})`);
    } catch (err) {
      target.runtime.error?.(`[webhook] 入站媒体保存失败: ${String(err)}`);
    }
  }

  // 3.5 视频第一帧提取（ffmpeg）
  let videoFirstFramePath: string | undefined;
  if (mediaPath && mediaType?.startsWith("video/")) {
    try {
      const { extractVideoFirstFrame } = await import("./video-frame.js");
      videoFirstFramePath = await extractVideoFirstFrame(mediaPath);
      if (videoFirstFramePath) {
        target.runtime.log?.(`[webhook] video: 第一帧提取成功 ${videoFirstFramePath}`);
      }
    } catch (err) {
      target.runtime.log?.(`[webhook] video: 第一帧提取失败（ffmpeg 可能不可用）: ${String(err)}`);
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // 4. 路由解析 + 动态路由处理
  // ──────────────────────────────────────────────────────────────────
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "wecom",
    accountId: account.accountId,
    peer: { kind: chatType === "group" ? "group" : "direct", id: chatId },
  });

  // ===== 动态 Agent 路由处理 =====
  const routingResult = processDynamicRouting({
    route,
    config,
    core,
    accountId: account.accountId,
    chatType: chatType === "group" ? "group" : "dm",
    chatId,
    senderId: userid,
    log: (msg) => target.runtime.log?.(msg.replace(/^\[dynamic-routing\]/, "[webhook]")),
    error: (msg) => target.runtime.error?.(msg.replace(/^\[dynamic-routing\]/, "[webhook]")),
  });

  // 应用动态路由结果
  if (routingResult.routeModified) {
    route.agentId = routingResult.finalAgentId;
    route.sessionKey = routingResult.finalSessionKey;
  }
  // ===== 动态 Agent 路由处理结束 =====
  // ──────────────────────────────────────────────────────────────────
  // 5. Agent Envelope 格式化（对齐原版）
  // ──────────────────────────────────────────────────────────────────
  const fromLabel = chatType === "group" ? `group:${chatId}` : `user:${userid}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "WeCom",
    from: fromLabel,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  // ──────────────────────────────────────────────────────────────────
  // 5.5 命令授权检查（对齐 lh 版 command-auth 门禁）
  // ──────────────────────────────────────────────────────────────────
  const authz = await resolveWecomCommandAuthorization({
    core,
    cfg: config,
    accountConfig: account.config,
    rawBody,
    senderUserId: userid,
  });
  const commandAuthorized = authz.commandAuthorized;
  target.runtime.log?.(
    `[webhook] authz: dmPolicy=${authz.dmPolicy} shouldCompute=${authz.shouldComputeAuth} sender=${userid.toLowerCase()} senderAllowed=${authz.senderAllowed} authorizerConfigured=${authz.authorizerConfigured} commandAuthorized=${String(commandAuthorized)}`,
  );

  // 命令门禁：如果这是命令且未授权，必须给用户一个明确的中文回复（不能静默忽略）
  if (authz.shouldComputeAuth && authz.commandAuthorized !== true) {
    const prompt = buildWecomUnauthorizedCommandPrompt({
      senderUserId: userid,
      dmPolicy: authz.dmPolicy,
      scope: "bot",
    });
    streamStore.updateStream(streamId, (s) => {
      s.finished = true;
      s.content = prompt;
    });
    try {
      await sendBotFallbackPromptNow({ streamId, text: prompt });
      target.runtime.log?.(`[webhook] authz: 未授权命令已提示用户 streamId=${streamId}`);
    } catch (err) {
      target.runtime.error?.(`[webhook] authz: 未授权命令提示推送失败 streamId=${streamId}: ${String(err)}`);
    }
    streamStore.onStreamFinished(streamId);
    return;
  }

  // ──────────────────────────────────────────────────────────────────
  // 6. /new /reset 命令检测
  // ──────────────────────────────────────────────────────────────────
  const rawBodyNormalized = rawBody.trim();
  const isResetCommand = /^\/(new|reset)(?:\s|$)/i.test(rawBodyNormalized);
  const resetCommandKind = isResetCommand ? (rawBodyNormalized.match(/^\/(new|reset)/i)?.[1]?.toLowerCase() ?? "new") : null;

  // ──────────────────────────────────────────────────────────────────
  // 7. 构造附件
  // ──────────────────────────────────────────────────────────────────
  const attachments: Array<{ name: string; mimeType?: string; url: string }> | undefined =
    mediaPath ? [{ 
      name: media?.filename || "file",
      mimeType: mediaType,
      url: pathToFileURL(mediaPath).href
    }] : undefined;

  // 如果提取到了视频第一帧，追加为附件让 LLM 能看到视频画面
  if (videoFirstFramePath && attachments) {
    const pathModule = await import("node:path");
    attachments.push({
      name: pathModule.basename(videoFirstFramePath),
      mimeType: "image/jpeg",
      url: pathToFileURL(videoFirstFramePath).href
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // 8. 构造 inbound context
  // ──────────────────────────────────────────────────────────────────
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    Attachments: attachments,
    From: chatType === "group" ? `wecom:group:${chatId}` : `wecom:${userid}`,
    To: `wecom:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: chatType,
    ConversationLabel: fromLabel,
    SenderName: userid,
    SenderId: userid,
    Provider: "wecom",
    Surface: "wecom",
    MessageSid: msg.msgid,
    CommandAuthorized: commandAuthorized,
    OriginatingChannel: "wecom",
    OriginatingTo: `wecom:${chatId}`,
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaUrl: mediaPath,
  });

  // ──────────────────────────────────────────────────────────────────
  // 9. 会话记录
  // ──────────────────────────────────────────────────────────────────
  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err: unknown) => {
      target.runtime.error?.(`[webhook] session meta update failed: ${String(err)}`);
    },
  });

  // ──────────────────────────────────────────────────────────────────
  // 10. Markdown 表格模式解析
  // ──────────────────────────────────────────────────────────────────
  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: config,
    channel: "wecom",
    accountId: account.accountId,
  });

  // ──────────────────────────────────────────────────────────────────
  // 11. 构造 dispatch config（禁用 message 工具）
  // ──────────────────────────────────────────────────────────────────
  // WeCom Bot 会话交付约束：
  // - 图片应尽量由 Bot 在原会话交付（流式最终帧 msg_item）。
  // - 非图片文件走 Agent 私信兜底（本文件中实现），并由 Bot 给出提示。
  //
  // 重要：message 工具不是 sandbox 工具，必须通过 cfg.tools.deny 禁用。
  // 否则 Agent 可能直接通过 message 工具私信/发群，绕过 Bot 交付链路，导致群里“没有任何提示”。
  const cfgForDispatch = buildCfgForDispatch(config);

  // ──────────────────────────────────────────────────────────────────
  // 12. 调度 Agent 回复（核心 deliver 回调）
  // ──────────────────────────────────────────────────────────────────
  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: cfgForDispatch,
    replyOptions: {
      disableBlockStreaming: false,
    },
    dispatcherOptions: {
      deliver: async (payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] }, info: { kind: string }) => {
        let text = payload.text ?? "";

        // ── <think> 标签保护 ──
        const thinkRegex = /<think>([\s\S]*?)<\/think>/g;
        const thinks: string[] = [];
        text = text.replace(thinkRegex, (match: string) => {
          thinks.push(match);
          return `__THINK_PLACEHOLDER_${thinks.length - 1}__`;
        });

        // ── template_card JSON 检测与发送（对齐 lh 版：直接 wecomFetch 推送） ──
        const trimmedText = text.trim();
        if (trimmedText.startsWith("{") && trimmedText.includes('"template_card"')) {
          try {
            const parsed = JSON.parse(trimmedText);
            if (parsed.template_card) {
              const isSingleChat = chatType !== "group";
              const responseUrl = getActiveReplyUrl(streamId);

              if (responseUrl && isSingleChat) {
                // 单聊且有 response_url：发送卡片
                await useActiveReplyOnce(streamId, async ({ responseUrl, proxyUrl }) => {
                  const res = await wecomFetch(
                    responseUrl,
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        msgtype: "template_card",
                        template_card: parsed.template_card,
                      }),
                    },
                    { proxyUrl, timeoutMs: REQUEST_TIMEOUT_MS },
                  );
                  if (!res.ok) {
                    throw new Error(`template_card send failed: ${res.status}`);
                  }
                });
                target.runtime.log?.(`[webhook] sent template_card: task_id=${parsed.template_card.task_id}`);
                streamStore.updateStream(streamId, (s) => {
                  s.finished = true;
                  s.content = "[已发送交互卡片]";
                });
                target.statusSink?.({ lastOutboundAt: Date.now() });
                return;
              } else {
                // 群聊 或 无 response_url：降级为文本描述
                target.runtime.log?.(`[webhook] template_card fallback to text (group=${!isSingleChat}, hasUrl=${!!responseUrl})`);
                const cardTitle = parsed.template_card.main_title?.title || "交互卡片";
                const cardDesc = parsed.template_card.main_title?.desc || "";
                const buttons = parsed.template_card.button_list?.map((b: any) => b.text).join(" / ") || "";
                text = `📋 **${cardTitle}**${cardDesc ? `\n${cardDesc}` : ""}${buttons ? `\n\n选项: ${buttons}` : ""}`;
              }
            }
          } catch { /* parse fail, use normal text */ }
        }

        // ── Markdown 表格转换 ──
        text = core.channel.text.convertMarkdownTables(text, tableMode);

        // ── 还原 <think> 标签 ──
        thinks.forEach((think, i) => {
          text = text.replace(`__THINK_PLACEHOLDER_${i}__`, think);
        });

        const current = streamStore.getStream(streamId);
        if (!current) return;

        if (!current.images) current.images = [];
        if (!current.agentMediaKeys) current.agentMediaKeys = [];

        // ── 从输出文本推断本机图片路径（安全：要求路径也出现在用户原消息中） ──
        if (!payload.mediaUrl && !(payload.mediaUrls?.length ?? 0) && text.includes("/")) {
          const candidates = extractLocalImagePathsFromText({ text, mustAlsoAppearIn: rawBody });
          if (candidates.length > 0) {
            target.runtime.log?.(`media: 从输出文本推断到本机图片路径（来自用户原消息）count=${candidates.length}`);
            for (const p of candidates) {
              try {
                const fs = await import("node:fs/promises");
                const pathModule = await import("node:path");
                const buf = await fs.readFile(p);
                const ext = pathModule.extname(p).slice(1).toLowerCase();
                const imageExts: Record<string, string> = {
                  jpg: "image/jpeg",
                  jpeg: "image/jpeg",
                  png: "image/png",
                  gif: "image/gif",
                  webp: "image/webp",
                  bmp: "image/bmp",
                };
                const contentType = imageExts[ext] ?? "application/octet-stream";
                if (!contentType.startsWith("image/")) {
                  continue;
                }
                const base64 = buf.toString("base64");
                const md5 = computeMd5(buf);
                current.images.push({ base64, md5 });
              } catch (err) {
                target.runtime.error?.(`[webhook] media: 读取本机图片失败 path=${p}: ${String(err)}`);
              }
            }
          }
        }

        // ── 每次 deliver 都追加到 dmContent（不受 STREAM_MAX_BYTES 限制） ──
        if (text.trim()) {
          streamStore.updateStream(streamId, (s) => {
            appendDmContent(s, text);
          });
        }

        // ── 超时渐进式检测（接近 6 分钟窗口，对齐 lh 版） ──
        const now = Date.now();
        const deadline = current.createdAt + BOT_WINDOW_MS;
        const switchAt = deadline - BOT_SWITCH_MARGIN_MS;
        const nearTimeout = !current.fallbackMode && !current.finished && now >= switchAt;
        if (nearTimeout) {
          const agentOk = isAgentConfigured(target);
          const prompt = buildFallbackPrompt({
            kind: "timeout",
            agentConfigured: agentOk,
            userId: current.userId,
            chatType: current.chatType,
          });
          target.runtime.log?.(
            `[webhook] fallback(timeout): 触发切换（接近 6 分钟）chatType=${current.chatType} agentConfigured=${agentOk} hasResponseUrl=${Boolean(getActiveReplyUrl(streamId))}`,
          );
          streamStore.updateStream(streamId, (s) => {
            s.fallbackMode = "timeout";
            s.finished = true;
            s.content = prompt;
            s.fallbackPromptSentAt = s.fallbackPromptSentAt ?? Date.now();
          });
          try {
            await sendBotFallbackPromptNow({ streamId, text: prompt });
            target.runtime.log?.(`[webhook] fallback(timeout): 群内提示已推送`);
          } catch (err) {
            target.runtime.error?.(`[webhook] fallback(timeout) prompt push failed streamId=${streamId}: ${String(err)}`);
          }
          return;
        }

        // ── MEDIA: 指令解析 ──
        const mediaDirectivePaths: string[] = [];
        const mediaDirectiveRe = /^MEDIA:\s*`?([^\n`]+?)`?\s*$/gm;
        let _mdMatch: RegExpExecArray | null;
        while ((_mdMatch = mediaDirectiveRe.exec(text)) !== null) {
          let p = (_mdMatch[1] ?? "").trim();
          if (!p) continue;
          if (p.startsWith("~/") || p === "~") {
            const home = os.homedir() || "/root";
            p = p.replace(/^~/, home);
          }
          if (!mediaDirectivePaths.includes(p)) mediaDirectivePaths.push(p);
        }
        if (mediaDirectivePaths.length > 0) {
          text = text.replace(/^MEDIA:\s*`?[^\n`]+?`?\s*$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
        }

        // ── 媒体处理（对齐 lh 版） ──
        const mediaUrls = Array.from(new Set([
          ...(payload.mediaUrls || []),
          ...(payload.mediaUrl ? [payload.mediaUrl] : []),
          ...mediaDirectivePaths,
        ]));
        for (const mPath of mediaUrls) {
          let contentType: string | undefined;
          let filename = mPath.split("/").pop() || "attachment";
          try {
            let buf: Buffer;

            const looksLikeUrl = /^https?:\/\//i.test(mPath);

            if (looksLikeUrl) {
              const loaded = await core.channel.media.fetchRemoteMedia({ url: mPath });
              buf = loaded.buffer;
              contentType = loaded.contentType;
              filename = loaded.fileName ?? "attachment";
            } else {
              const fs = await import("node:fs/promises");
              const pathMod = await import("node:path");
              buf = await fs.readFile(mPath);
              filename = pathMod.basename(mPath);
              const ext = pathMod.extname(mPath).slice(1).toLowerCase();
              contentType = MIME_BY_EXT[ext] ?? "application/octet-stream";
            }

            if (contentType?.startsWith("image/")) {
              // 非 WS 模式：保持原有 base64 嵌入方式
              const base64 = buf.toString("base64");
              const md5 = computeMd5(buf);
              current.images.push({ base64, md5 });
              target.runtime.log?.(`[webhook] media: 识别为图片 contentType=${contentType} filename=${filename}`);
            } else {
              // Webhook 模式：统一切换到 Agent 私信兜底，并在 Bot 会话里提示用户。
              const agentOk = isAgentConfigured(target);
              const alreadySent = current.agentMediaKeys.includes(mPath);
              target.runtime.log?.(
                `[webhook] fallback(media): 检测到非图片文件 chatType=${current.chatType} contentType=${contentType ?? "unknown"} filename=${filename} agentConfigured=${agentOk} alreadySent=${alreadySent} hasResponseUrl=${Boolean(getActiveReplyUrl(streamId))}`,
              );

              // TODO: 补充agent
              if (agentOk && !alreadySent && current.userId) {
                try {
                  await agentDmMedia({
                    target,
                    userId: current.userId,
                    mediaUrlOrPath: mPath,
                    contentType,
                    filename,
                  });
                  target.runtime.log?.(`[webhook] fallback(media): 文件已通过 Agent 私信发送 user=${current.userId}`);
                  streamStore.updateStream(streamId, (s) => {
                    s.agentMediaKeys = Array.from(new Set([...(s.agentMediaKeys ?? []), mPath]));
                  });
                } catch (err) {
                  target.runtime.error?.(`[webhook] Agent DM 媒体发送失败: ${String(err)}`);
                }
              }

              if (!current.fallbackMode) {
                const prompt = buildFallbackPrompt({
                  kind: "media",
                  agentConfigured: agentOk,
                  userId: current.userId,
                  filename,
                  chatType: current.chatType,
                });
                streamStore.updateStream(streamId, (s) => {
                  s.fallbackMode = "media";
                  s.finished = true;
                  s.content = prompt;
                  s.fallbackPromptSentAt = s.fallbackPromptSentAt ?? Date.now();
                });
                try {
                  await sendBotFallbackPromptNow({ streamId, text: prompt });
                  target.runtime.log?.(`[webhook] fallback(media): 群内提示已推送`);
                } catch (err) {
                  target.runtime.error?.(`[webhook] fallback(media) prompt push failed streamId=${streamId}: ${String(err)}`);
                }
              }
              return;
            }
          } catch (err) {
            target.runtime.error?.(`[webhook] 媒体处理失败: ${mPath}: ${String(err)}`);
            // Webhook 模式：Agent 私信兜底
            const agentOk = isAgentConfigured(target);
            const fallbackFilename = filename || mPath.split("/").pop() || "attachment";
            // TODO: 补充agent
            if (agentOk && current.userId && !current.agentMediaKeys.includes(mPath)) {
              try {
                await agentDmMedia({
                  target,
                  userId: current.userId,
                  mediaUrlOrPath: mPath,
                  contentType,
                  filename: fallbackFilename,
                });
                streamStore.updateStream(streamId, (s) => {
                  s.agentMediaKeys = Array.from(new Set([...(s.agentMediaKeys ?? []), mPath]));
                });
                target.runtime.log?.(`[webhook] fallback(error): 媒体处理失败后已通过 Agent 私信发送 user=${current.userId}`);
              } catch (sendErr) {
                target.runtime.error?.(`[webhook] fallback(error): 媒体处理失败后的 Agent 私信发送也失败: ${String(sendErr)}`);
              }
            }
            if (!current.fallbackMode) {
              const prompt = buildFallbackPrompt({
                kind: "error",
                agentConfigured: agentOk,
                userId: current.userId,
                filename: fallbackFilename,
                chatType: current.chatType,
              });
              streamStore.updateStream(streamId, (s) => {
                s.fallbackMode = "error";
                s.finished = true;
                s.content = prompt;
                s.fallbackPromptSentAt = s.fallbackPromptSentAt ?? Date.now();
              });
              try {
                await sendBotFallbackPromptNow({ streamId, text: prompt });
                target.runtime.log?.(`[webhook] fallback(error): 群内提示已推送`);
              } catch (pushErr) {
                target.runtime.error?.(`[webhook] fallback(error) prompt push failed streamId=${streamId}: ${String(pushErr)}`);
              }
            }
            return;
          }
        }

        // ── fallbackMode 检查：如果已进入 fallback 模式，不再更新 content ──
        const mode = streamStore.getStream(streamId)?.fallbackMode;
        if (mode) return;

        // ── 累积 content（段落分隔 \n\n，truncate 保护） ──
        const nextText = current.content
          ? `${current.content}\n\n${text}`.trim()
          : text.trim();

        streamStore.updateStream(streamId, (s) => {
          s.content = truncateUtf8Bytes(nextText, STREAM_MAX_BYTES);
          if (current.images?.length) s.images = current.images;
        });
        target.statusSink?.({ lastOutboundAt: Date.now() });
      },

      onError: (err: unknown) => {
        target.runtime.error?.(`[webhook] Agent reply failed (streamId=${streamId}): ${String(err)}`);
      },
    },
  });

  // ──────────────────────────────────────────────────────────────────
  // 13. 后处理：/new /reset 中文回执
  // ──────────────────────────────────────────────────────────────────
  if (isResetCommand) {
    const current = streamStore.getStream(streamId);
    if (current && !current.content?.trim()) {
      const ackText = resetCommandKind === "reset" ? "✅ 已重置会话。" : "✅ 已开启新会话。";
      streamStore.updateStream(streamId, (s) => { s.content = ackText; s.finished = true; });
    }
  }

  // 空内容兜底
  streamStore.updateStream(streamId, (s) => {
    if (!s.content.trim() && !(s.images?.length ?? 0)) {
      const hasMediaDelivered = (s.agentMediaKeys?.length ?? 0) > 0;
      const hasFallback = Boolean(s.fallbackMode);
      if (hasMediaDelivered) {
        s.content = "✅ 文件已发送。";
      } else if (!hasFallback) {
        s.content = "✅ 已处理完成。";
      }
    }
  });

  streamStore.markFinished(streamId);

  // ──────────────────────────────────────────────────────────────────
  // 14. 超时模式下 Agent DM 最终投递（对齐 lh 版）
  // ──────────────────────────────────────────────────────────────────
  const finishedState = streamStore.getStream(streamId);
  // TODO: 补充agent
  if (finishedState?.fallbackMode === "timeout" && !finishedState.finalDeliveredAt) {
    if (!isAgentConfigured(target)) {
      // Agent not configured - group prompt already explains the situation.
      streamStore.updateStream(streamId, (s) => { s.finalDeliveredAt = Date.now(); });
    } else if (finishedState.userId) {
      const dmText = (finishedState.dmContent ?? "").trim();
      if (dmText) {
        try {
          target.runtime.log?.(`[webhook] fallback(timeout): 开始通过 Agent 私信发送剩余内容 user=${finishedState.userId} len=${dmText.length}`);
          await agentDmText({ target, userId: finishedState.userId, text: dmText });
          target.runtime.log?.(`[webhook] fallback(timeout): Agent 私信发送完成 user=${finishedState.userId}`);
        } catch (err) {
          target.runtime.error?.(`[webhook] fallback(timeout): Agent 私信发送失败: ${String(err)}`);
        }
      }
      streamStore.updateStream(streamId, (s) => { s.finalDeliveredAt = Date.now(); });
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // 15. 统一终结：主动推送最终流帧（对齐 lh 版：直接 POST JSON 不加密）
  // ──────────────────────────────────────────────────────────────────
  const stateAfterFinish = streamStore.getStream(streamId);
  const responseUrl = getActiveReplyUrl(streamId);
  if (stateAfterFinish && responseUrl) {
    try {
      await pushFinalStreamReplyNow(streamId);
      target.runtime.log?.(
        `[webhook] final stream pushed via response_url streamId=${streamId}, chatType=${chatType}, images=${stateAfterFinish.images?.length ?? 0}`,
      );
    } catch (err) {
      target.runtime.error?.(`[webhook] final stream push via response_url failed streamId=${streamId}: ${String(err)}`);
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // 16. 更新回执流 + 推进队列
  // ──────────────────────────────────────────────────────────────────
  target.runtime.log?.(`[webhook] queue: 当前批次结束，尝试推进下一批 streamId=${streamId}`);

  const ackStreamIds = streamStore.drainAckStreamsForBatch(streamId);
  if (ackStreamIds.length > 0) {
    const mergedDoneHint = "✅ 已合并处理完成，请查看上一条回复。";
    for (const ackId of ackStreamIds) {
      streamStore.updateStream(ackId, (s) => { s.content = mergedDoneHint; s.finished = true; });
    }
    target.runtime.log?.(`[webhook] queue: 已更新回执流 count=${ackStreamIds.length} batchStreamId=${streamId}`);
  }

  streamStore.onStreamFinished(streamId);
}

// ============================================================================
// 内部辅助：response_url 推送）
// ============================================================================

/**
 * 获取 response_url
 */
function getActiveReplyUrl(streamId: string): string | undefined {
  return getMonitorState().activeReplyStore.getUrl(streamId);
}

/**
 * 使用 response_url 发送一次性请求
 */
async function useActiveReplyOnce(
  streamId: string,
  fn: (params: { responseUrl: string; proxyUrl?: string }) => Promise<void>,
): Promise<void> {
  return getMonitorState().activeReplyStore.use(streamId, fn);
}

/**
 * 通过 response_url 推送 Bot 兜底提示
 *
 * 对齐 lh 版：直接 POST JSON，不加密。
 */
async function sendBotFallbackPromptNow(params: { streamId: string; text: string }): Promise<void> {
  const responseUrl = getActiveReplyUrl(params.streamId);
  if (!responseUrl) {
    throw new Error("no response_url（无法主动推送群内提示）");
  }
  await useActiveReplyOnce(params.streamId, async ({ responseUrl, proxyUrl }) => {
    const payload = {
      msgtype: "stream",
      stream: {
        id: params.streamId,
        finish: true,
        content: truncateUtf8Bytes(params.text, STREAM_MAX_BYTES) || "1",
      },
    };
    const res = await wecomFetch(
      responseUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      { proxyUrl, timeoutMs: REQUEST_TIMEOUT_MS },
    );
    if (!res.ok) {
      throw new Error(`fallback prompt push failed: ${res.status}`);
    }
  });
}

/**
 * 通过 response_url 推送最终流帧（对齐 lh 版 pushFinalStreamReplyNow）
 *
 * 对齐 lh 版：从 StreamState 构建完整响应，直接 POST JSON，不加密。
 */
async function pushFinalStreamReplyNow(streamId: string): Promise<void> {
  const state = getMonitorState().streamStore.getStream(streamId);
  const responseUrl = getActiveReplyUrl(streamId);
  if (!state || !responseUrl) return;
  const finalReply = buildStreamReplyFromState(state, STREAM_MAX_BYTES) as unknown as Record<string, unknown>;
  await useActiveReplyOnce(streamId, async ({ responseUrl, proxyUrl }) => {
    const res = await wecomFetch(
      responseUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(finalReply),
      },
      { proxyUrl, timeoutMs: REQUEST_TIMEOUT_MS },
    );
    if (!res.ok) {
      throw new Error(`final stream push failed: ${res.status}`);
    }
  });
}

/**
 * 通过 Agent 私信发送文本（对齐 lh 版 sendAgentDmText）
 *
 * 对齐 lh 版：使用 core.channel.text.chunkText 进行文本分块。
 */
async function agentDmText(params: {
  target: WecomWebhookTarget;
  userId: string;
  text: string;
}): Promise<void> {
  const { target, userId, text } = params;
  if (!target.account.agent?.configured) {
    throw new Error("Agent credentials not configured");
  }
  const agent = target.account.agent;
  const chunks = target.core.channel.text.chunkText(text, 20480);
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    await sendAgentText({
      agent, 
      toUser: userId,
      text: trimmed,
    });
  }
}

/**
 * 通过 Agent 私信发送媒体（对齐 lh 版 sendAgentDmMedia）
 *
 * 对齐 lh 版：接受 mediaUrlOrPath，内部判断 URL 或本地路径。
 */
async function agentDmMedia(params: {
  target: WecomWebhookTarget;
  userId: string;
  mediaUrlOrPath: string;
  contentType?: string;
  filename: string;
}): Promise<void> {
  const { target, userId, mediaUrlOrPath, filename } = params;
  if (!target.account.agent?.configured) {
    throw new Error("Agent credentials not configured");
  }
  const agent = target.account.agent;
  let buffer: Buffer;
  let inferredContentType = params.contentType;

  const looksLikeUrl = /^https?:\/\//i.test(mediaUrlOrPath);
  if (looksLikeUrl) {
    const res = await fetch(mediaUrlOrPath, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`media download failed: ${res.status}`);
    buffer = Buffer.from(await res.arrayBuffer());
    inferredContentType = inferredContentType || res.headers.get("content-type") || "application/octet-stream";
  } else {
    const fs = await import("node:fs/promises");
    buffer = await fs.readFile(mediaUrlOrPath);
  }

  let mediaType: "image" | "voice" | "video" | "file" = "file";
  const ct = (inferredContentType || "").toLowerCase();
  if (ct.startsWith("image/")) mediaType = "image";
  else if (ct.startsWith("audio/")) mediaType = "voice";
  else if (ct.startsWith("video/")) mediaType = "video";

  const mediaId = await uploadMedia({ agent, type: mediaType, buffer, filename });
  
    await sendAgentMedia({
        agent,
        toUser: userId,
        mediaId,
        mediaType,
        ...(mediaType === "video" ? { title: filename, description: "" } : {}),
    });
}
