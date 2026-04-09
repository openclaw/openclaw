/**
 * Webhook core message processing
 *
 * Migrated from @mocrane/wecom monitor.ts + refactored.
 * Responsibilities: inbound message parsing, debounce aggregation, Agent dispatch, streaming output, timeout fallback.
 */

import os from "node:os";
import { pathToFileURL } from "node:url";
import {
  sendText as sendAgentText,
  uploadMedia,
  sendMedia as sendAgentMedia,
} from "../agent/api-client.js";
import { processDynamicRouting } from "../dynamic-routing.js";
import {
  resolveWecomCommandAuthorization,
  buildWecomUnauthorizedCommandPrompt,
} from "../shared/command-auth.js";
import { getMonitorState } from "./gateway.js";
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
import { wecomFetch } from "./http.js";
import type { WecomWebhookTarget, WebhookInboundMessage } from "./types.js";
import { toStr } from "../shared/to-str.js";
import {
  STREAM_MAX_BYTES,
  BOT_WINDOW_MS,
  BOT_SWITCH_MARGIN_MS,
  REQUEST_TIMEOUT_MS,
} from "./types.js";
// ============================================================================
// Inbound message processing
// ============================================================================

/**
 * Handle inbound message
 *
 * Parse message type and content, create/get stream, add to debounce queue, return placeholder response.
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
  },
): Promise<Record<string, unknown> | null> {
  const state = getMonitorState();

  const { streamStore, activeReplyStore } = state;
  const msgid = message.msgid;

  // msgid deduplication check
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

  // Parse message content (aligned with original buildInboundBody)
  const msgContent = buildInboundBody(message);
  if (!msgContent && !hasMedia(message)) {
    target.runtime.log?.(`[webhook] 空消息内容 (type=${message.msgtype}, msgid=${msgid})`);
    return null;
  }

  const userid = msgFilterData?.senderUserId ?? "";
  const chatType = toStr(message.chattype)
    .trim()
    .toLowerCase();
  const chatId = msgFilterData?.chatId ?? message.chatid ?? "";
  // Original conversationKey format: wecom:{accountId}:{userid}:{chatId}
  // For single chat, chatId equals userid
  const resolvedChatId = chatId || userid;
  const conversationKey = `wecom:${target.account.accountId}:${userid}:${resolvedChatId}`;

  // Add to debounce queue
  const result = streamStore.addPendingMessage({
    conversationKey,
    target,
    msg: message,
    msgContent: msgContent ?? "",
    nonce,
    timestamp,
    debounceMs: (target.account.config as unknown as Record<string, unknown>)?.debounceMs as number | undefined,
  });

  const { streamId, status } = result;

  target.runtime.log?.(
    `[webhook] 消息入队 (status=${status}, streamId=${streamId}, convKey=${conversationKey})`,
  );

  // Store response_url (aligned with original: also save proxyUrl for outbound request proxying)
  if (message.response_url) {
    activeReplyStore.store(streamId, message.response_url, proxyUrl);
  }

  // Update stream metadata
  streamStore.updateStream(streamId, (s) => {
    s.userId = userid;
    s.chatType = chatType === "group" ? "group" : "direct";
    s.chatId = resolvedChatId;
    s.aibotid = target.account.botId;
  });

  // Return different placeholder responses based on status (aligned with original status branch handling)
  const defaultPlaceholder = (target.account.config as unknown as Record<string, unknown>)?.streamPlaceholderContent as string | undefined;
  const queuedPlaceholder = "已收到，已排队处理中...";
  const mergedQueuedPlaceholder = "已收到，已合并排队处理中...";

  if (status === "active_new") {
    // First message, return default placeholder
    return buildStreamPlaceholderReply(streamId, defaultPlaceholder);
  }

  if (status === "queued_new") {
    // Entered queue batch, return queue prompt
    target.runtime.log?.(
      `[webhook] queue: 已进入下一批次 streamId=${streamId} msgid=${toStr(message.msgid)}`,
    );
    return buildStreamPlaceholderReply(streamId, queuedPlaceholder);
  }

  // active_merged / queued_merged: merged into a batch
  // Create an "ack stream" for this msgid, initially showing "merged queued", auto-updated to "merged done" when batch finishes
  const ackStreamId = streamStore.createStream({
    msgid: message.msgid ? String(message.msgid) : undefined,
  });
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
    `[webhook] queue: 已合并排队（回执流）ackStreamId=${ackStreamId} mergedIntoStreamId=${streamId} msgid=${toStr(message.msgid)}`,
  );
  return buildStreamTextPlaceholderReply(ackStreamId, mergedQueuedPlaceholder);
}

// ============================================================================
// stream_refresh handling
// ============================================================================

/**
 * Handle stream_refresh request
 *
 * Returns accumulated content, image attachments, and finish flag from StreamState.
 */
export async function handleStreamRefresh(
  target: WecomWebhookTarget,
  message: WebhookInboundMessage,
): Promise<Record<string, unknown> | null> {
  const state = getMonitorState();

  const streamId = toStr(message.stream?.id).trim();
  if (!streamId) {
    target.runtime.log?.("[webhook] stream_refresh 缺少 stream_id");
    return null;
  }

  const stream = state.streamStore.getStream(streamId);
  if (!stream) {
    target.runtime.log?.(`[webhook] stream_refresh: stream ${streamId} 不存在`);
    // Return finish=true to notify client to stop polling
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
// enter_chat handling
// ============================================================================

/**
 * Handle enter_chat event
 *
 * Returns a configurable welcome message.
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

  // No welcome message configured, return empty reply
  return null;
}

// ============================================================================
// template_card_event handling
// ============================================================================

/**
 * Handle template card event (aligned with original template_card_event logic)
 *
 * Original flow:
 * 1. msgid dedup: skip already processed card events
 * 2. Parse card interaction data: event_key, selected_items, task_id
 * 3. Return empty encrypted reply immediately (non-blocking)
 * 4. Create stream and mark as started
 * 5. Store response_url (for subsequent pushes)
 * 6. Build interaction description text, start Agent processing as text message
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

  // 1. msgid dedup: skip already processed card events
  if (msgid && streamStore.getStreamByMsgId(msgid)) {
    target.runtime.log?.(
      `[webhook] template_card_event: already processed msgid=${msgid}, skipping`,
    );
    return {};
  }

  // 2. Parse card interaction data
  const cardEvent = message.event?.template_card_event;
  let interactionDesc = `[卡片交互] 按钮: ${toStr(cardEvent?.event_key, "unknown")}`;

  // Parse selected items (selected_items.selected_item)
  const selectedItems = cardEvent?.selected_items as Record<string, unknown> | undefined;
  const selectedItemList = selectedItems?.selected_item as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(selectedItemList) && selectedItemList.length > 0) {
    const selects = selectedItemList.map((i) => {
      const questionKey = toStr(i.question_key);
      const optionIds = (i.option_ids as Record<string, unknown> | undefined)?.option_id;
      const optionStr = Array.isArray(optionIds) ? optionIds.join(",") : toStr(optionIds);
      return `${questionKey}=${optionStr}`;
    });
    interactionDesc += ` 选择: ${selects.join("; ")}`;
  }

  // Parse task ID
  if (cardEvent?.task_id) {
    interactionDesc += ` (任务ID: ${toStr(cardEvent?.task_id)})`;
  }

  target.runtime.log?.(
    `[webhook] template_card_event (event_key=${String(toStr(cardEvent?.event_key, "N/A"))}, msgid=${msgid ?? "N/A"})`,
  );

  // 3. Create stream and mark as started
  const streamId = streamStore.createStream({ msgid });
  streamStore.markStarted(streamId);

  // 4. Store response_url (for subsequent Agent output pushes)
  if (message.response_url) {
    activeReplyStore.store(streamId, message.response_url, proxyUrl);
  }

  // 5. Build interaction description as text message, async start Agent processing
  const syntheticMessage: WebhookInboundMessage = {
    ...message,
    msgtype: "text",
    text: { content: interactionDesc },
  };

  // Async start Agent (does not block HTTP response)
  startAgentForStream({
    target,
    accountId: target.account.accountId,
    msg: syntheticMessage,
    streamId,
    mergedContents: undefined,
    mergedMsgids: undefined,
  }).catch((err) => {
    target.runtime.error?.(`[webhook] template_card_event Agent failed: ${toStr(err)}`);
  });

  // 6. Return empty reply immediately (non-blocking, original returns {} encrypted)
  return {};
}

// ============================================================================
// Agent dispatch (startAgentForStream)
// ============================================================================

/**
 * **startAgentForStream (start Agent processing workflow)**
 *
 * Converts received (or aggregated) messages into OpenClaw internal format and dispatches to the corresponding Agent.
 * Includes:
 * 1. Message decryption and media saving.
 * 2. Route resolution (Agent Route).
 * 3. Session recording.
 * 4. Trigger Agent response (Dispatch Reply).
 * 5. Process Agent output (including text, Markdown table conversion, <think> tag protection, template card detection).
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
  const _isWsMode = Boolean(stream.wsMode);

  const core = target.core;
  const config = target.config;
  const account = target.account;

  const userid = resolveWecomSenderUserId(msg) || "unknown";
  const chatType = msg.chattype === "group" ? "group" : "direct";
  const chatId = msg.chattype === "group" ? msg.chatid?.trim() || "unknown" : userid;
  const taskKey = computeTaskKey(target, msg);
  const aibotid = toStr(msg.aibotid).trim() || undefined;

  // Update Stream status: record context info (userId, ChatType, etc.)
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

  // If debounce-aggregated multi-message content exists, override rawBody
  if (params.mergedContents) {
    rawBody = params.mergedContents;
  }

  // ──────────────────────────────────────────────────────────────────
  // 2. P0: 本机路径文件发送
  // P0: For group/DM scenarios where Bot sends local image/file paths, prefer Bot in-session delivery (images),
  // non-image files fall back to Agent DM, and ensure Bot session has a Chinese prompt.
  //
  // Background: Agent sending to group chatId (wr/wc...) often results in 86008 error regardless of "fixes";
  // if such requests can passively reply with images, they must be delivered by Bot within the group.
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
      if (imageExts.has(ext)) {
        imagePaths.push(p);
      } else {
        otherPaths.push(p);
      }
    }

    // Images: deliver via Bot in-session (base64 msg_item)
    if (imagePaths.length > 0 && otherPaths.length === 0) {
      const loaded: Array<{ base64: string; md5: string; path: string }> = [];
      const allowedRoots = target.account.config.mediaLocalRoots ?? [];
      for (const p of imagePaths) {
        try {
          // Validate path against allowed media roots
          const resolved = pathModule.resolve(p);
          if (allowedRoots.length > 0 && !allowedRoots.some((r) => {
            const root = pathModule.resolve(r);
            return resolved === root || resolved.startsWith(root + pathModule.sep);
          })) {
            target.runtime.error?.(`[webhook] local-path: path ${p} outside allowed media roots, skipping`);
            continue;
          }
          const buf = await fs.readFile(resolved);
          const base64 = buf.toString("base64");
          const md5 = computeMd5(buf);
          loaded.push({ base64, md5, path: p });
        } catch (err) {
          target.runtime.error?.(`[webhook] local-path: 读取图片失败 path=${p}: ${toStr(err)}`);
        }
      }

      if (loaded.length > 0) {
        streamStore.updateStream(streamId, (s) => {
          s.images = loaded.map(({ base64, md5 }) => ({ base64, md5 }));
          s.content =
            loaded.length === 1
              ? `已发送图片（${pathModule.basename(loaded[0].path)}）`
              : `已发送 ${loaded.length} 张图片`;
          s.finished = true;
        });

        // Push via response_url (aligned with lh version: POST JSON directly, no encryption)
        const responseUrl = getActiveReplyUrl(streamId);
        if (responseUrl) {
          try {
            const finalReply = buildStreamReplyFromState(
              streamStore.getStream(streamId)!,
              STREAM_MAX_BYTES,
            ) as unknown as Record<string, unknown>;
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
                throw new Error(`local-path image push failed: ${res.status}`);
              }
            });
            target.runtime.log?.(
              `[webhook] local-path: 已通过 Bot response_url 推送图片 frames=final images=${loaded.length}`,
            );
          } catch (err) {
            target.runtime.error?.(
              `[webhook] local-path: Bot 主动推送图片失败（将依赖 stream_refresh 拉取）: ${toStr(err)}`,
            );
          }
        } else {
          target.runtime.log?.(
            `[webhook] local-path: 无 response_url，等待 stream_refresh 拉取最终图片`,
          );
        }
        // This message is complete, advance queue to process next batch
        streamStore.onStreamFinished(streamId);
        return;
      }

      // Fallback when all image paths fail to read (aligned with lh version Webhook mode)
      const agentOk = isAgentConfigured(target);
      const fallbackName =
        imagePaths.length === 1
          ? imagePaths[0].split("/").pop() || "image"
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
        target.runtime.error?.(
          `[webhook] local-path: 图片读取失败后的兜底提示推送失败: ${toStr(err)}`,
        );
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
            target.runtime.error?.(
              `[webhook] local-path: 图片 Agent 私信兜底失败 path=${p}: ${toStr(err)}`,
            );
          }
        }
      }
      streamStore.onStreamFinished(streamId);
      return;
    }

    // Non-image files: Bot prompt + Agent DM fallback (aligned with lh version Webhook mode)
    if (otherPaths.length > 0) {
      const agentOk = isAgentConfigured(target);

      const filename =
        otherPaths.length === 1 ? otherPaths[0].split("/").pop()! : `${otherPaths.length} 个文件`;
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
        target.runtime.error?.(`[webhook] local-path: 文件兜底提示推送失败: ${toStr(err)}`);
      }

      if (!agentOk) {
        streamStore.onStreamFinished(streamId);
        return;
      }
      if (!userid || userid === "unknown") {
        target.runtime.error?.(
          `[webhook] local-path: 无法识别触发者 userId，无法 Agent 私信发送文件`,
        );
        streamStore.onStreamFinished(streamId);
        return;
      }

      // TODO: agent兜底这里需要有agent对象，待对齐lh版本
      for (const p of otherPaths) {
        const alreadySent = streamStore.getStream(streamId)?.agentMediaKeys?.includes(p);
        if (alreadySent) {
          continue;
        }
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
          target.runtime.error?.(
            `[webhook] local-path: Agent 私信发送文件失败 path=${p}: ${toStr(err)}`,
          );
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
      target.runtime.error?.(`[webhook] 入站媒体保存失败: ${toStr(err)}`);
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
      target.runtime.log?.(`[webhook] video: 第一帧提取失败（ffmpeg 可能不可用）: ${toStr(err)}`);
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

  // Apply dynamic routing result
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

  // Non-command sender gate: if dmPolicy is not "open" and sender not in allowlist, skip silently
  if (!authz.shouldComputeAuth && authz.dmPolicy !== "open" && !authz.senderAllowed) {
    target.runtime.log?.(
      `[webhook] sender ${userid} not allowed by dmPolicy=${authz.dmPolicy}, skipping`,
    );
    streamStore.onStreamFinished(streamId);
    return;
  }

  // Command gate: if this is a command and unauthorized, must give user a clear Chinese reply (cannot silently ignore)
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
      target.runtime.error?.(
        `[webhook] authz: 未授权命令提示推送失败 streamId=${streamId}: ${toStr(err)}`,
      );
    }
    streamStore.onStreamFinished(streamId);
    return;
  }

  // ──────────────────────────────────────────────────────────────────
  // 6. /new /reset 命令检测
  // ──────────────────────────────────────────────────────────────────
  const rawBodyNormalized = rawBody.trim();
  const isResetCommand = /^\/(new|reset)(?:\s|$)/i.test(rawBodyNormalized);
  const resetCommandKind = isResetCommand
    ? (rawBodyNormalized.match(/^\/(new|reset)/i)?.[1]?.toLowerCase() ?? "new")
    : null;

  // ──────────────────────────────────────────────────────────────────
  // 7. 构造附件
  // ──────────────────────────────────────────────────────────────────
  const attachments: Array<{ name: string; mimeType?: string; url: string }> | undefined = mediaPath
    ? [
        {
          name: media?.filename || "file",
          mimeType: mediaType,
          url: pathToFileURL(mediaPath).href,
        },
      ]
    : undefined;

  // If video first frame was extracted, append as attachment so LLM can see the video frame
  if (videoFirstFramePath && attachments) {
    const pathModule = await import("node:path");
    attachments.push({
      name: pathModule.basename(videoFirstFramePath),
      mimeType: "image/jpeg",
      url: pathToFileURL(videoFirstFramePath).href,
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
      target.runtime.error?.(`[webhook] session meta update failed: ${toStr(err)}`);
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
  // Important: message tool is not a sandbox tool; must be disabled via cfg.tools.deny.
  // Otherwise Agent may DM/send to group directly via message tool, bypassing Bot delivery chain, causing "no prompt" in group.
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
      deliver: async (
        payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] },
        _info: { kind: string },
      ) => {
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
                // Single chat with response_url: send card
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
                target.runtime.log?.(
                  `[webhook] sent template_card: task_id=${parsed.template_card.task_id}`,
                );
                streamStore.updateStream(streamId, (s) => {
                  s.finished = true;
                  s.content = "[已发送交互卡片]";
                });
                target.statusSink?.({ lastOutboundAt: Date.now() });
                return;
              } else {
                // Group chat or no response_url: degrade to text description
                target.runtime.log?.(
                  `[webhook] template_card fallback to text (group=${!isSingleChat}, hasUrl=${!!responseUrl})`,
                );
                const cardTitle = parsed.template_card.main_title?.title || "交互卡片";
                const cardDesc = parsed.template_card.main_title?.desc || "";
                const buttons =
                  parsed.template_card.button_list?.map((b: Record<string, unknown>) => b.text).join(" / ") || "";
                text = `📋 **${cardTitle}**${cardDesc ? `\n${cardDesc}` : ""}${buttons ? `\n\n选项: ${buttons}` : ""}`;
              }
            }
          } catch {
            /* parse fail, use normal text */
          }
        }

        // ── Markdown table conversion ──
        text = core.channel.text.convertMarkdownTables(text, tableMode);

        // ── Restore <think> tags ──
        thinks.forEach((think, i) => {
          text = text.replace(`__THINK_PLACEHOLDER_${i}__`, think);
        });

        const current = streamStore.getStream(streamId);
        if (!current) {
          return;
        }

        if (!current.images) {
          current.images = [];
        }
        if (!current.agentMediaKeys) {
          current.agentMediaKeys = [];
        }

        // ── 从输出文本推断本机图片路径（安全：要求路径也出现在用户原消息中） ──
        if (!payload.mediaUrl && !(payload.mediaUrls?.length ?? 0) && text.includes("/")) {
          const candidates = extractLocalImagePathsFromText({ text, mustAlsoAppearIn: rawBody });
          if (candidates.length > 0) {
            target.runtime.log?.(
              `media: 从输出文本推断到本机图片路径（来自用户原消息）count=${candidates.length}`,
            );
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
                target.runtime.error?.(
                  `[webhook] media: 读取本机图片失败 path=${p}: ${toStr(err)}`,
                );
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
            target.runtime.error?.(
              `[webhook] fallback(timeout) prompt push failed streamId=${streamId}: ${toStr(err)}`,
            );
          }
          return;
        }

        // ── MEDIA: 指令解析 ──
        const mediaDirectivePaths: string[] = [];
        const mediaDirectiveRe = /^MEDIA:\s*`?([^\n`]+?)`?\s*$/gm;
        let _mdMatch: RegExpExecArray | null;
        while ((_mdMatch = mediaDirectiveRe.exec(text)) !== null) {
          let p = (_mdMatch[1] ?? "").trim();
          if (!p) {
            continue;
          }
          if (p.startsWith("~/") || p === "~") {
            const home = os.homedir() || "/root";
            p = p.replace(/^~/, home);
          }
          if (!mediaDirectivePaths.includes(p)) {
            mediaDirectivePaths.push(p);
          }
        }
        if (mediaDirectivePaths.length > 0) {
          text = text
            .replace(/^MEDIA:\s*`?[^\n`]+?`?\s*$/gm, "")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
        }

        // ── 媒体处理（对齐 lh 版） ──
        const mediaUrls = Array.from(
          new Set([
            ...(payload.mediaUrls || []),
            ...(payload.mediaUrl ? [payload.mediaUrl] : []),
            ...mediaDirectivePaths,
          ]),
        );
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
              // Non-WS mode: keep original base64 embed approach
              const base64 = buf.toString("base64");
              const md5 = computeMd5(buf);
              current.images.push({ base64, md5 });
              target.runtime.log?.(
                `[webhook] media: 识别为图片 contentType=${contentType} filename=${filename}`,
              );
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
                  target.runtime.log?.(
                    `[webhook] fallback(media): 文件已通过 Agent 私信发送 user=${current.userId}`,
                  );
                  streamStore.updateStream(streamId, (s) => {
                    s.agentMediaKeys = Array.from(new Set([...(s.agentMediaKeys ?? []), mPath]));
                  });
                } catch (err) {
                  target.runtime.error?.(`[webhook] Agent DM 媒体发送失败: ${toStr(err)}`);
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
                  target.runtime.error?.(
                    `[webhook] fallback(media) prompt push failed streamId=${streamId}: ${toStr(err)}`,
                  );
                }
              }
              return;
            }
          } catch (err) {
            target.runtime.error?.(`[webhook] 媒体处理失败: ${mPath}: ${toStr(err)}`);
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
                target.runtime.log?.(
                  `[webhook] fallback(error): 媒体处理失败后已通过 Agent 私信发送 user=${current.userId}`,
                );
              } catch (sendErr) {
                target.runtime.error?.(
                  `[webhook] fallback(error): 媒体处理失败后的 Agent 私信发送也失败: ${String(sendErr)}`,
                );
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
                target.runtime.error?.(
                  `[webhook] fallback(error) prompt push failed streamId=${streamId}: ${String(pushErr)}`,
                );
              }
            }
            return;
          }
        }

        // ── fallbackMode 检查：如果已进入 fallback 模式，不再更新 content ──
        const mode = streamStore.getStream(streamId)?.fallbackMode;
        if (mode) {
          return;
        }

        // ── 累积 content（段落分隔 \n\n，truncate 保护） ──
        const nextText = current.content ? `${current.content}\n\n${text}`.trim() : text.trim();

        streamStore.updateStream(streamId, (s) => {
          s.content = truncateUtf8Bytes(nextText, STREAM_MAX_BYTES);
          if (current.images?.length) {
            s.images = current.images;
          }
        });
        target.statusSink?.({ lastOutboundAt: Date.now() });
      },

      onError: (err: unknown) => {
        target.runtime.error?.(
          `[webhook] Agent reply failed (streamId=${streamId}): ${toStr(err)}`,
        );
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
      streamStore.updateStream(streamId, (s) => {
        s.content = ackText;
        s.finished = true;
      });
    }
  }

  // Empty content fallback
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
      streamStore.updateStream(streamId, (s) => {
        s.finalDeliveredAt = Date.now();
      });
    } else if (finishedState.userId) {
      const dmText = (finishedState.dmContent ?? "").trim();
      if (dmText) {
        try {
          target.runtime.log?.(
            `[webhook] fallback(timeout): 开始通过 Agent 私信发送剩余内容 user=${finishedState.userId} len=${dmText.length}`,
          );
          await agentDmText({ target, userId: finishedState.userId, text: dmText });
          target.runtime.log?.(
            `[webhook] fallback(timeout): Agent 私信发送完成 user=${finishedState.userId}`,
          );
        } catch (err) {
          target.runtime.error?.(`[webhook] fallback(timeout): Agent 私信发送失败: ${toStr(err)}`);
        }
      }
      streamStore.updateStream(streamId, (s) => {
        s.finalDeliveredAt = Date.now();
      });
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
      target.runtime.error?.(
        `[webhook] final stream push via response_url failed streamId=${streamId}: ${toStr(err)}`,
      );
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
      streamStore.updateStream(ackId, (s) => {
        s.content = mergedDoneHint;
        s.finished = true;
      });
    }
    target.runtime.log?.(
      `[webhook] queue: 已更新回执流 count=${ackStreamIds.length} batchStreamId=${streamId}`,
    );
  }

  streamStore.onStreamFinished(streamId);
}

// ============================================================================
// Internal helpers: response_url push
// ============================================================================

/**
 * Get response_url
 */
function getActiveReplyUrl(streamId: string): string | undefined {
  return getMonitorState().activeReplyStore.getUrl(streamId);
}

/**
 * Send a one-time request using response_url
 */
async function useActiveReplyOnce(
  streamId: string,
  fn: (params: { responseUrl: string; proxyUrl?: string }) => Promise<void>,
): Promise<void> {
  return getMonitorState().activeReplyStore.use(streamId, fn);
}

/**
 * Push Bot fallback prompt via response_url
 *
 * Aligned with lh version: POST JSON directly, no encryption.
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
 * Push final stream frame via response_url (aligned with lh version pushFinalStreamReplyNow)
 *
 * Aligned with lh version: build complete response from StreamState, POST JSON directly, no encryption.
 */
async function pushFinalStreamReplyNow(streamId: string): Promise<void> {
  const state = getMonitorState().streamStore.getStream(streamId);
  const responseUrl = getActiveReplyUrl(streamId);
  if (!state || !responseUrl) {
    return;
  }
  const finalReply = buildStreamReplyFromState(state, STREAM_MAX_BYTES) as unknown as Record<
    string,
    unknown
  >;
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
 * Send text via Agent DM (aligned with lh version sendAgentDmText)
 *
 * Aligned with lh version: uses core.channel.text.chunkText for text chunking.
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
    if (!trimmed) {
      continue;
    }
    await sendAgentText({
      agent,
      toUser: userId,
      text: trimmed,
    });
  }
}

/**
 * Send media via Agent DM (aligned with lh version sendAgentDmMedia)
 *
 * Aligned with lh version: accepts mediaUrlOrPath, internally determines URL or local path.
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
    if (!res.ok) {
      throw new Error(`media download failed: ${res.status}`);
    }
    buffer = Buffer.from(await res.arrayBuffer());
    inferredContentType =
      inferredContentType || res.headers.get("content-type") || "application/octet-stream";
  } else {
    const fs = await import("node:fs/promises");
    buffer = await fs.readFile(mediaUrlOrPath);
  }

  let mediaType: "image" | "voice" | "video" | "file" = "file";
  const ct = (inferredContentType || "").toLowerCase();
  if (ct.startsWith("image/")) {
    mediaType = "image";
  } else if (ct.startsWith("audio/")) {
    mediaType = "voice";
  } else if (ct.startsWith("video/")) {
    mediaType = "video";
  }

  const mediaId = await uploadMedia({ agent, type: mediaType, buffer, filename });

  await sendAgentMedia({
    agent,
    toUser: userId,
    mediaId,
    mediaType,
    ...(mediaType === "video" ? { title: filename, description: "" } : {}),
  });
}
