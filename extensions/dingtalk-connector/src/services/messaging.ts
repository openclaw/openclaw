/**
 * 钉钉消息发送模块
 * 支持 AI Card 流式响应、普通消息、主动消息
 */

import type { DingtalkConfig } from "../types/index.ts";
import { DINGTALK_API, getAccessToken, getOapiAccessToken } from "../utils/index.ts";
import { dingtalkHttp, dingtalkOapiHttp } from "../utils/http-client.ts";
import { MEDIA_MSG_TYPES } from "../utils/constants.ts";
import { createLoggerFromConfig } from "../utils/logger.ts";
import {
  processLocalImages,
  processVideoMarkers,
  processAudioMarkers,
  processFileMarkers,
  uploadMediaToDingTalk,
} from "./media.ts";
// ✅ 导入 AI Card 相关函数，避免重复实现
import {
  createAICardForTarget,
  streamAICard,
  finishAICard,
  type AICardInstance,
  type AICardTarget,
} from "./messaging/card.ts";
import { substituteBotMentions } from "./messaging/mentions.ts";

// ============ 常量 ============
// 注意：AI Card 相关的类型和函数已移至 ./messaging/card.ts，通过上方 import 引入

/** 消息类型枚举 */
export type DingTalkMsgType =
  | "text"
  | "markdown"
  | "link"
  | "actionCard"
  | "image";

/** 主动发送消息的结果 */
export interface SendResult {
  ok: boolean;
  processQueryKey?: string;
  cardInstanceId?: string;
  error?: string;
  usedAICard?: boolean;
}

/** 主动发送选项 */
export interface ProactiveSendOptions {
  msgType?: DingTalkMsgType;
  replyToId?: string;
  title?: string;
  log?: any;
  useAICard?: boolean;
  fallbackToNormal?: boolean;
  /**
   * @人 / @机器人 列表。多机器人协作场景下，传入对方机器人的 chatbotUserId（加密 ID）
   * 可在群消息中嵌入 @ 文字。注意：钉钉应用机器人不会因此触发对方的 stream 回调，
   * 仅用于视觉展示与配合 OpenClaw sessions_send 的协作叙事。
   */
  atDingtalkIds?: string[];
  /** @人列表（普通用户 staffId / userId） */
  atUserIds?: string[];
  /** 是否 @ 全员 */
  atAll?: boolean;
}

// ============ AI Card 相关函数已移至 ./messaging/card.ts ============
// createAICardForTarget, streamAICard, finishAICard 现在从 card.ts 导入使用

// ============ 普通消息发送 ============

/**
 * 发送 Markdown 消息
 * 支持 @用户（atUserId）和 @机器人（atDingtalkIds）
 */
export async function sendMarkdownMessage(
  config: DingtalkConfig,
  sessionWebhook: string,
  title: string,
  markdown: string,
  options: any = {},
): Promise<any> {
  const token = await getAccessToken(config);
  let text = markdown;
  let mergedAtDingtalkIds: string[] = Array.isArray(options.atDingtalkIds)
    ? [...options.atDingtalkIds]
    : [];

  // 多机器人兜底：如果调用方传入全局 cfg（包含 channels.dingtalk-connector.accounts），
  // 自动把文本里 `@<友好名/agentId/accountId>` 替换成 `@<chatbotUserId>`，
  // 并合并被注入的加密 ID 到 atDingtalkIds，保证钉钉正确渲染蓝色 @ 并推送给被 @ 的 bot 的 stream。
  if (options.cfg) {
    const substituted = substituteBotMentions(text, options.cfg, {
      detectBareAliases: Boolean(options.detectBareAliases),
    });
    text = substituted.text;
    for (const id of substituted.injectedChatbotUserIds) {
      if (!mergedAtDingtalkIds.includes(id)) mergedAtDingtalkIds.push(id);
    }
  }

  if (options.atUserId) text = `${text} @${options.atUserId}`;
  if (mergedAtDingtalkIds.length) {
    for (const id of mergedAtDingtalkIds) {
      if (!text.includes(`@${id}`)) {
        text = `${text} @${id}`;
      }
    }
  }

  const body: any = {
    msgtype: "markdown",
    markdown: { title: title || "Message", text },
  };
  const atUserIds = options.atUserId ? [options.atUserId] : [];
  const atDingtalkIds = mergedAtDingtalkIds;
  if (atUserIds.length > 0 || atDingtalkIds.length > 0) {
    body.at = {
      ...(atUserIds.length > 0 ? { atUserIds } : {}),
      ...(atDingtalkIds.length > 0 ? { atDingtalkIds } : {}),
      isAtAll: false,
    };
  }

  return (
    await dingtalkHttp.post(sessionWebhook, body, {
      headers: {
        "x-acs-dingtalk-access-token": token,
        "Content-Type": "application/json",
      },
    })
  ).data;
}

/**
 * 发送文本消息
 * 支持 @用户（atUserId）和 @机器人（atDingtalkIds）
 */
export async function sendTextMessage(
  config: DingtalkConfig,
  sessionWebhook: string,
  text: string,
  options: any = {},
): Promise<any> {
  const token = await getAccessToken(config);
  let content = text;
  let mergedAtDingtalkIds: string[] = Array.isArray(options.atDingtalkIds)
    ? [...options.atDingtalkIds]
    : [];

  // 多机器人兜底：见 sendMarkdownMessage 同样说明
  if (options.cfg) {
    const substituted = substituteBotMentions(content, options.cfg, {
      detectBareAliases: Boolean(options.detectBareAliases),
    });
    content = substituted.text;
    for (const id of substituted.injectedChatbotUserIds) {
      if (!mergedAtDingtalkIds.includes(id)) mergedAtDingtalkIds.push(id);
    }
  }

  if (mergedAtDingtalkIds.length) {
    for (const id of mergedAtDingtalkIds) {
      if (!content.includes(`@${id}`)) {
        content = `${content} @${id}`;
      }
    }
  }
  const body: any = { msgtype: "text", text: { content } };
  const atUserIds = options.atUserId ? [options.atUserId] : [];
  const atDingtalkIds = mergedAtDingtalkIds;
  if (atUserIds.length > 0 || atDingtalkIds.length > 0) {
    body.at = {
      ...(atUserIds.length > 0 ? { atUserIds } : {}),
      ...(atDingtalkIds.length > 0 ? { atDingtalkIds } : {}),
      isAtAll: false,
    };
  }

  return (
    await dingtalkHttp.post(sessionWebhook, body, {
      headers: {
        "x-acs-dingtalk-access-token": token,
        "Content-Type": "application/json",
      },
    })
  ).data;
}

/**
 * 智能选择 text / markdown
 */
export async function sendMessage(
  config: DingtalkConfig,
  sessionWebhook: string,
  text: string,
  options: any = {},
): Promise<any> {
  // 多机器人协作：自动从文本中提取 chatbotUserId 形式的加密 dingtalkId
  // (格式固定为 `$:LWCP_v1:$<base64-like>`)，注入到 options.atDingtalkIds，
  // 让钉钉 webhook 把它渲染成蓝色 @ 标签，并把这条消息推送给被 @ 的目标机器人。
  // 参考钉钉文档：自定义机器人 webhook + at.atDingtalkIds 即可完成机器人间互相召唤。
  const mergedOptions: any = { ...options };
  let workingText = text;

  // 多机器人兜底：先把文本里的 `@<友好名/agentId/accountId>` 替换成 `@<chatbotUserId>`，
  // 再按原有规则扫描加密 ID 注入 atDingtalkIds。两步都依赖 options.cfg（全局配置）。
  if (options.cfg && typeof workingText === "string" && workingText.length > 0) {
    const substituted = substituteBotMentions(workingText, options.cfg, {
      detectBareAliases: Boolean(options.detectBareAliases),
    });
    workingText = substituted.text;
    if (substituted.injectedChatbotUserIds.length > 0) {
      const existing = Array.isArray(mergedOptions.atDingtalkIds)
        ? (mergedOptions.atDingtalkIds as string[])
        : [];
      mergedOptions.atDingtalkIds = Array.from(
        new Set([...existing, ...substituted.injectedChatbotUserIds]),
      );
    }
  }

  if (typeof workingText === "string" && workingText.length > 0) {
    const CHATBOT_ID_PATTERN = /\$:LWCP_v1:\$[A-Za-z0-9+/=]+/g;
    const found = Array.from(new Set(workingText.match(CHATBOT_ID_PATTERN) || []));
    if (found.length > 0) {
      const existing = Array.isArray(mergedOptions.atDingtalkIds)
        ? (mergedOptions.atDingtalkIds as string[])
        : [];
      const merged = Array.from(new Set([...existing, ...found]));
      mergedOptions.atDingtalkIds = merged;
    }
  }

  const hasMarkdown =
    /^[#*>-]|[*_`#\[\]]/.test(workingText) ||
    (workingText && typeof workingText === "string" && workingText.includes("\n"));
  const useMarkdown =
    mergedOptions.useMarkdown !== false && (mergedOptions.useMarkdown || hasMarkdown);

  // cfg 已在上方消费完毕，子函数不需要再次替换，剥除避免重复扫描
  const downstreamOptions = { ...mergedOptions };
  delete downstreamOptions.cfg;

  if (useMarkdown) {
    const title =
      downstreamOptions.title ||
      workingText
        .split("\n")[0]
        .replace(/^[#*\s\->]+/, "")
        .slice(0, 20) ||
      "Message";
    return sendMarkdownMessage(config, sessionWebhook, title, workingText, downstreamOptions);
  }
  return sendTextMessage(config, sessionWebhook, workingText, downstreamOptions);
}

// ============ 主动发送消息 ============

/**
 * 构建普通消息的 msgKey 和 msgParam
 *
 * 第四个参数可携带 at 信息：
 * - atDingtalkIds：对方加密 dingtalkId / chatbotUserId（多机器人协作时使用）
 * - atUserIds：普通成员 staffId
 * 这些 ID 会以 `@${id}` 文本附加到 content 末尾（钉钉客户端会尝试将其渲染成 @ 标签）。
 */
export function buildMsgPayload(
  msgType: DingTalkMsgType,
  content: string,
  title?: string,
  atOptions?: { atDingtalkIds?: string[]; atUserIds?: string[]; atAll?: boolean },
): { msgKey: string; msgParam: Record<string, any> } | { error: string } {
  // 在 text/markdown 末尾追加 @文本（其它消息类型如 link/actionCard/image 不处理）
  const appendAtMentions = (raw: string): string => {
    if (!atOptions) return raw;
    let out = raw ?? "";
    const ids = [
      ...(atOptions.atDingtalkIds || []),
      ...(atOptions.atUserIds || []),
    ];
    for (const id of ids) {
      if (id && !out.includes(`@${id}`)) {
        out = `${out} @${id}`;
      }
    }
    if (atOptions.atAll && !out.includes("@all")) {
      out = `${out} @all`;
    }
    return out;
  };

  switch (msgType) {
    case "markdown": {
      const text = appendAtMentions(content);
      return {
        msgKey: "sampleMarkdown",
        msgParam: {
          title:
            title ||
            content
              .split("\n")[0]
              .replace(/^[#*\s\->]+/, "")
              .slice(0, 20) ||
            "Message",
          text,
        },
      };
    }
    case "link":
      try {
        return {
          msgKey: "sampleLink",
          msgParam: typeof content === "string" ? JSON.parse(content) : content,
        };
      } catch {
        return { error: "Invalid link message format, expected JSON" };
      }
    case "actionCard":
      try {
        return {
          msgKey: "sampleActionCard",
          msgParam: typeof content === "string" ? JSON.parse(content) : content,
        };
      } catch {
        return { error: "Invalid actionCard message format, expected JSON" };
      }
    case "image":
      return {
        msgKey: "sampleImageMsg",
        msgParam: { photoURL: content },
      };
    case "text":
    default: {
      const finalContent = appendAtMentions(content);
      return {
        msgKey: "sampleText",
        msgParam: { content: finalContent },
      };
    }
  }
}

/**
 * 使用普通消息 API 发送单聊消息（降级方案）
 */
export async function sendNormalToUser(
  config: DingtalkConfig,
  userIds: string | string[],
  content: string,
  options: ProactiveSendOptions = {},
): Promise<SendResult> {
  const { msgType = "text", title, log } = options;
  const userIdArray = Array.isArray(userIds) ? userIds : [userIds];

  // ✅ 后处理：上传本地图片到钉钉，替换 markdown 图片语法中的本地路径为 media_id
  let processedContent = content;
  const oapiToken = await getOapiAccessToken(config);
  if (oapiToken) {
    log?.info?.(`[sendNormalToUser] 开始图片后处理`);
    processedContent = await processLocalImages(content, oapiToken, log);
  } else {
    log?.warn?.(`[sendNormalToUser] 无法获取 oapiToken，跳过媒体后处理`);
  }

  const payload = buildMsgPayload(msgType, processedContent, title);
  if ("error" in payload) {
    return { ok: false, error: payload.error, usedAICard: false };
  }

  try {
    const token = await getAccessToken(config);
    const body = {
      robotCode: String(config.clientId),
      userIds: userIdArray,
      msgKey: payload.msgKey,
      msgParam: JSON.stringify(payload.msgParam),
    };

    log?.info?.(
      `发送单聊消息: userIds=${userIdArray.join(",")}, msgType=${msgType}`,
    );

    const resp = await dingtalkHttp.post(
      `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`,
      body,
      {
        headers: {
          "x-acs-dingtalk-access-token": token,
          "Content-Type": "application/json",
        },
        timeout: 10_000,
      },
    );

    if (resp.data?.processQueryKey) {
      log?.info?.(
        `发送成功: processQueryKey=${resp.data.processQueryKey}`,
      );
      return {
        ok: true,
        processQueryKey: resp.data.processQueryKey,
        usedAICard: false,
      };
    }

    log?.warn?.(
      `发送响应异常: ${JSON.stringify(resp.data)}`,
    );
    return {
      ok: false,
      error: resp.data?.message || "Unknown error",
      usedAICard: false,
    };
  } catch (err: any) {
    const errMsg = err.response?.data?.message || err.message;
    log?.error?.(`发送失败: ${errMsg}`);
    return { ok: false, error: errMsg, usedAICard: false };
  }
}

/**
 * 使用普通消息 API 发送群聊消息（降级方案）
 */
export async function sendNormalToGroup(
  config: DingtalkConfig,
  openConversationId: string,
  content: string,
  options: ProactiveSendOptions = {},
): Promise<SendResult> {
  const { msgType = "text", title, log } = options;

  // ✅ 后处理：上传本地图片到钉钉，替换 markdown 图片语法中的本地路径为 media_id
  let processedContent = content;
  const oapiToken = await getOapiAccessToken(config);
  if (oapiToken) {
    log?.info?.(`[sendNormalToGroup] 开始图片后处理`);
    processedContent = await processLocalImages(content, oapiToken, log);
  } else {
    log?.warn?.(`[sendNormalToGroup] 无法获取 oapiToken，跳过媒体后处理`);
  }

  const payload = buildMsgPayload(msgType, processedContent, title);
  if ("error" in payload) {
    return { ok: false, error: payload.error, usedAICard: false };
  }

  try {
    const token = await getAccessToken(config);
    const body = {
      robotCode: String(config.clientId),
      openConversationId,
      msgKey: payload.msgKey,
      msgParam: JSON.stringify(payload.msgParam),
    };

    log?.info?.(
      `发送群聊消息: openConversationId=${openConversationId}, msgType=${msgType}`,
    );

    const resp = await dingtalkHttp.post(
      `${DINGTALK_API}/v1.0/robot/groupMessages/send`,
      body,
      {
        headers: {
          "x-acs-dingtalk-access-token": token,
          "Content-Type": "application/json",
        },
        timeout: 10_000,
      },
    );

    if (resp.data?.processQueryKey) {
      log?.info?.(
        `发送成功: processQueryKey=${resp.data.processQueryKey}`,
      );
      return {
        ok: true,
        processQueryKey: resp.data.processQueryKey,
        usedAICard: false,
      };
    }

    log?.warn?.(
      `发送响应异常: ${JSON.stringify(resp.data)}`,
    );
    return {
      ok: false,
      error: resp.data?.message || "Unknown error",
      usedAICard: false,
    };
  } catch (err: any) {
    const errMsg = err.response?.data?.message || err.message;
    log?.error?.(`发送失败: ${errMsg}`);
    return { ok: false, error: errMsg, usedAICard: false };
  }
}

/**
 * 主动创建并发送 AI Card（通用内部实现）
 */
export async function sendAICardInternal(
  config: DingtalkConfig,
  target: AICardTarget,
  content: string,
  log?: any,
): Promise<SendResult> {
  const targetDesc =
    target.type === "group"
      ? `群聊 ${target.openConversationId}`
      : `用户 ${target.userId}`;

  try {
    // 0. 获取 oapiToken 用于后处理
    const oapiToken = await getOapiAccessToken(config);

    // 1. 后处理01：上传本地图片到钉钉，替换路径为 media_id
    let processedContent = content;
    if (oapiToken) {
      log?.info?.(`开始图片后处理`);
      processedContent = await processLocalImages(content, oapiToken, log);
    } else {
      log?.warn?.(
        `无法获取 oapiToken，跳过媒体后处理`,
      );
    }

    // 2. 后处理02：提取视频标记并发送视频消息
    log?.info?.(`开始视频后处理`);
    processedContent = await processVideoMarkers(
      processedContent,
      "",
      config,
      oapiToken,
      log,
      true,
      target,
    );

    // 3. 后处理03：提取音频标记并发送音频消息
    log?.info?.(`开始音频后处理`);
    processedContent = await processAudioMarkers(
      processedContent,
      "",
      config,
      oapiToken,
      log,
      true,
      target,
    );

    // 4. 后处理04：提取文件标记并发送独立文件消息
    log?.info?.(`开始文件后处理`);
    processedContent = await processFileMarkers(
      processedContent,
      "",
      config,
      oapiToken,
      log,
      true,
      target,
    );

    // 5. 检查处理后的内容是否为空
    const trimmedContent = processedContent.trim();
    if (!trimmedContent) {
      log?.info?.(
        `处理后内容为空（纯文件/视频消息），跳过创建 AI Card`,
      );
      return { ok: true, usedAICard: false };
    }

    // 6. 创建卡片
    const card = await createAICardForTarget(config, target, log);
    if (!card) {
      return {
        ok: false,
        error: "Failed to create AI Card",
        usedAICard: false,
      };
    }

    // 7. 使用 finishAICard 设置内容
    await finishAICard(card, processedContent, config, log);

    log?.info?.(
      `AI Card 发送成功: ${targetDesc}, cardInstanceId=${card.cardInstanceId}`,
    );
    return { ok: true, cardInstanceId: card.cardInstanceId, usedAICard: true };
  } catch (err: any) {
    log?.error?.(
      `AI Card 发送失败 (${targetDesc}): ${err.message}`,
    );
    if (err.response) {
      log?.error?.(
        `错误响应: status=${err.response.status} data=${JSON.stringify(err.response.data)}`,
      );
    }
    return {
      ok: false,
      error: err.response?.data?.message || err.message,
      usedAICard: false,
    };
  }
}

/**
 * 主动发送 AI Card 到单聊用户
 */
export async function sendAICardToUser(
  config: DingtalkConfig,
  userId: string,
  content: string,
  log?: any,
): Promise<SendResult> {
  return sendAICardInternal(config, { type: "user", userId }, content, log);
}

/**
 * 主动发送 AI Card 到群聊
 */
export async function sendAICardToGroup(
  config: DingtalkConfig,
  openConversationId: string,
  content: string,
  log?: any,
): Promise<SendResult> {
  return sendAICardInternal(
    config,
    { type: "group", openConversationId },
    content,
    log,
  );
}

/**
 * 主动发送文本消息到钉钉
 */
export async function sendToUser(
  config: DingtalkConfig,
  userId: string | string[],
  text: string,
  options?: ProactiveSendOptions,
): Promise<SendResult> {
  if (!config?.clientId || !config?.clientSecret) {
    return { ok: false, error: "Missing clientId or clientSecret", usedAICard: false };
  }
  if (!userId || (Array.isArray(userId) && userId.length === 0)) {
    return { ok: false, error: "userId is empty", usedAICard: false };
  }

  // 多用户：使用普通消息 API（不走 AI Card）
  if (Array.isArray(userId)) {
    return sendNormalToUser(config, userId, text, options || {});
  }

  return sendProactive(config, { userId }, text, options || {});
}

/**
 * 主动发送文本消息到钉钉群
 */
export async function sendToGroup(
  config: DingtalkConfig,
  openConversationId: string,
  text: string,
  options?: ProactiveSendOptions,
): Promise<SendResult> {
  if (!config?.clientId || !config?.clientSecret) {
    return { ok: false, error: "Missing clientId or clientSecret", usedAICard: false };
  }
  if (!openConversationId || typeof openConversationId !== "string") {
    return { ok: false, error: "openConversationId is empty", usedAICard: false };
  }
  return sendProactive(config, { openConversationId }, text, options || {});
}

/**
 * 发送文本消息（用于 outbound 接口）
 */
export async function sendTextToDingTalk(params: {
  config: DingtalkConfig;
  target: string;
  text: string;
  replyToId?: string;
}): Promise<SendResult> {
  const { config, target, text, replyToId } = params;

  const log = createLoggerFromConfig(config, 'sendTextToDingTalk');

  // 参数校验
  if (!target || typeof target !== "string") {
    log.error("target 参数无效:", target);
    return { ok: false, error: "Invalid target parameter", usedAICard: false };
  }

  // 判断目标是用户还是群（支持 group:/user: 前缀，与 gateway-methods.ts 逻辑保持一致）
  let targetParam: { type: "user"; userId: string } | { type: "group"; openConversationId: string };
  if (target.startsWith("group:")) {
    targetParam = { type: "group", openConversationId: target.slice(6) };
  } else if (target.startsWith("user:")) {
    targetParam = { type: "user", userId: target.slice(5) };
  } else if (target.startsWith("cid")) {
    targetParam = { type: "group", openConversationId: target };
  } else {
    targetParam = { type: "user", userId: target };
  }

  return sendProactive(config, targetParam, text, {
    msgType: "text",
    replyToId,
  });
}

/**
 * 发送媒体消息（用于 outbound 接口）
 */
export async function sendMediaToDingTalk(params: {
  config: DingtalkConfig;
  target: string;
  text?: string;
  mediaUrl: string;
  replyToId?: string;
  /** 框架提供的文件搜索根目录列表，用于解析相对路径 */
  mediaLocalRoots?: readonly string[];
}): Promise<SendResult> {
  const log = createLoggerFromConfig(params.config, 'sendMediaToDingTalk');
  
  log.info(
    "开始处理，params:",
    JSON.stringify({
      target: params.target,
      text: params.text,
      mediaUrl: params.mediaUrl,
      replyToId: params.replyToId,
      hasConfig: !!params.config,
    }),
  );

  const { config, target, text, mediaUrl, replyToId, mediaLocalRoots } = params;

  // 参数校验
  if (!target || typeof target !== "string") {
    log.error("target 参数无效:", target);
    return { ok: false, error: "Invalid target parameter", usedAICard: false };
  }

  // 判断目标是用户还是群（支持 group:/user: 前缀，与 gateway-methods.ts 逻辑保持一致）
  let targetParam: { type: "user"; userId: string } | { type: "group"; openConversationId: string };
  if (target.startsWith("group:")) {
    targetParam = { type: "group", openConversationId: target.slice(6) };
  } else if (target.startsWith("user:")) {
    targetParam = { type: "user", userId: target.slice(5) };
  } else if (target.startsWith("cid")) {
    targetParam = { type: "group", openConversationId: target };
  } else {
    targetParam = { type: "user", userId: target };
  }

  log.info("参数解析完成，mediaUrl:", mediaUrl, "type:", typeof mediaUrl);

  // 参数校验
  if (!mediaUrl) {
    log.info("mediaUrl 为空，返回错误提示");
    return sendProactive(config, targetParam, text ?? "⚠️ 缺少媒体文件 URL", {
      msgType: "text",
      replyToId,
    });
  }

  // 1. 先发送文本消息（如果有且不为空）
  // 注意：只有在 text 有实际内容时才发送，避免发送空消息
  if (text && text.trim().length > 0) {
    log.info("先发送文本消息:", text);
    await sendProactive(config, targetParam, text, {
      msgType: "text",
      replyToId,
    });
  }

  // 2. 上传媒体文件并发送媒体消息
  try {
    log.info("开始获取 oapiToken");
    const oapiToken = await getOapiAccessToken(config);
    log.info("oapiToken 获取成功");

    // 根据文件扩展名判断媒体类型
    log.info("开始解析文件扩展名，mediaUrl:", mediaUrl);
    const ext = mediaUrl.toLowerCase().split(".").pop() || "";
    log.info("文件扩展名:", ext);
    let mediaType: "image" | "file" | "video" | "voice" = "file";

    if (["jpg", "jpeg", "png", "gif", "bmp", "webp"].includes(ext)) {
      mediaType = "image";
    } else if (
      ["mp4", "avi", "mov", "mkv", "flv", "wmv", "webm"].includes(ext)
    ) {
      mediaType = "video";
    } else if (
      ["mp3", "wav", "aac", "ogg", "m4a", "flac", "wma", "amr"].includes(ext)
    ) {
      mediaType = "voice";
    }
    log.info("媒体类型判断完成:", mediaType);

    // 上传文件到钉钉
    // 根据媒体类型设置不同的大小限制（钉钉 OAPI 官方限制）
    let maxSize: number;
    switch (mediaType) {
      case "image":
        maxSize = 10 * 1024 * 1024; // 图片最大 10MB
        break;
      case "voice":
        maxSize = 2 * 1024 * 1024; // 语音最大 2MB
        break;
      case "video":
      case "file":
        maxSize = 20 * 1024 * 1024; // 视频和文件最大 20MB
        break;
      default:
        maxSize = 20 * 1024 * 1024; // 默认 20MB
    }
    
    log.info("准备调用 uploadMediaToDingTalk，参数:", { mediaUrl, mediaType, maxSizeMB: (maxSize / (1024 * 1024)).toFixed(0) });
    if (!oapiToken) {
      log.error("oapiToken 为空，无法上传媒体文件");
      return sendProactive(
        config,
        targetParam,
        "⚠️ 媒体文件处理失败：缺少 oapiToken",
        { msgType: "text", replyToId },
      );
    }
    // 解析文件路径：如果是相对路径且直接不存在，尝试基于 mediaLocalRoots 查找
    let resolvedMediaUrl = mediaUrl;
    const { toLocalPath } = await import('./media.ts');
    const _fs = await import('fs');
    const _path = await import('path');
    const directPath = toLocalPath(mediaUrl);
    if (!_fs.existsSync(directPath) && mediaLocalRoots?.length && !_path.isAbsolute(directPath)) {
      for (const root of mediaLocalRoots) {
        const candidate = _path.resolve(root, directPath);
        if (_fs.existsSync(candidate)) {
          log.info(`相对路径解析成功：${mediaUrl} → ${candidate}（基于 mediaLocalRoots）`);
          resolvedMediaUrl = candidate;
          break;
        }
      }
    }
    const uploadResult = await uploadMediaToDingTalk(
      resolvedMediaUrl,
      mediaType,
      oapiToken,
      maxSize,
      log,
    );
    log.info("uploadMediaToDingTalk 返回结果:", uploadResult);

    if (!uploadResult) {
      // 上传失败，发送文本消息提示
      log.error("上传失败，返回错误提示");
      return sendProactive(config, targetParam, "⚠️ 媒体文件上传失败", {
        msgType: "text",
        replyToId,
      });
    }

    // uploadResult 现在是对象，包含 mediaId、cleanMediaId、downloadUrl
    log.info("提取 media_id:", uploadResult.mediaId);

    // 3. 根据媒体类型发送对应的消息
    const fileName = mediaUrl.split("/").pop() || "file";

    if (mediaType === "image") {
      // 图片消息 - 发送真正的图片消息，使用原始 mediaId（带 @）
      const result = await sendProactive(config, targetParam, uploadResult.mediaId, {
        msgType: "image",
        replyToId,
      });
      return {
        ...result,
        processQueryKey: result.processQueryKey || "image-message-sent",
      };
    }

    // 对于视频，使用视频标记机制
    if (mediaType === "video") {
      // 构建视频标记
      const videoMarker = `[DINGTALK_VIDEO]{"path":"${mediaUrl}"}[/DINGTALK_VIDEO]`;

      // 直接处理视频标记（上传并发送视频消息）
      const { processVideoMarkers } = await import("./media");
      await processVideoMarkers(
        videoMarker, // 只传入标记，不包含原始文本
        "",
        config,
        oapiToken,
        console,
        true, // useProactiveApi
        targetParam,
      );

      // 如果有原始文本，单独发送
      if (text?.trim()) {
        const result = await sendProactive(config, targetParam, text, {
          msgType: "text",
          replyToId,
        });
        return {
          ...result,
          processQueryKey: result.processQueryKey || "video-text-sent",
        };
      }

      // 视频已发送，返回成功
      return {
        ok: true,
        usedAICard: false,
        processQueryKey: "video-message-sent",
      };
    }

    // 对于音频、文件，发送真正的文件消息
    const fs = await import("fs");
    const stats = fs.statSync(mediaUrl);
    
    // 获取文件扩展名作为 fileType
    const fileType = ext || "file";
    
    // 构建文件信息（path 字段用于 sendFileProactive 中 fileName 的 fallback）
    const fileInfo = {
      path: mediaUrl,
      fileName: fileName,
      fileType: fileType,
    };

    // 使用 sendFileProactive 发送文件消息
    const { sendFileProactive } = await import("./media.ts");
    await sendFileProactive(config, targetParam, fileInfo, uploadResult.mediaId, log);

    // 返回成功结果
    return {
      ok: true,
      usedAICard: false,
      processQueryKey: "file-message-sent",
    };
  } catch (err: any) {
    log.error("发送媒体消息失败:", err.message);
    // 发生错误，发送文本消息提示
    return sendProactive(
      config,
      targetParam,
      `⚠️ 媒体文件处理失败: ${err.message}`,
      { msgType: "text", replyToId },
    );
  }
}

/**
 * 智能发送消息
 */
export async function sendProactive(
  config: DingtalkConfig,
  target: { userId?: string; userIds?: string[]; openConversationId?: string },
  content: string,
  options: ProactiveSendOptions = {},
): Promise<SendResult> {
  const log = createLoggerFromConfig(config, 'sendProactive');
  
  log.info(
    "开始处理，参数:",
    JSON.stringify({
      target,
      contentLength: content?.length,
      hasOptions: !!options,
    }),
  );

  if (!options.msgType) {
    const hasMarkdown =
      /^[#*>-]|[*_`#\[\]]/.test(content) ||
      (content && typeof content === "string" && content.includes("\n"));
    if (hasMarkdown) {
      options.msgType = "markdown";
    }
  }

  // 直接实现发送逻辑，不要递归调用 sendToUser/sendToGroup
  if (target.userId || target.userIds) {
    const userIds = target.userIds || [target.userId!];
    const userId = userIds[0];
    log.info("发送给用户，userId:", userId);

    // 构建发送参数
    return sendProactiveInternal(
      config,
      { type: "user", userId },
      content,
      options,
    );
  }

  if (target.openConversationId) {
    log.info(
      "发送给群聊，openConversationId:",
      target.openConversationId,
    );
    return sendProactiveInternal(
      config,
      { type: "group", openConversationId: target.openConversationId },
      content,
      options,
    );
  }

  log.error("target 参数缺少必要字段:", target);
  return {
    ok: false,
    error: "Must specify userId, userIds, or openConversationId",
    usedAICard: false,
  };
}

/**
 * 内部发送实现
 */
async function sendProactiveInternal(
  config: DingtalkConfig,
  target: AICardTarget,
  content: string,
  options: ProactiveSendOptions,
): Promise<SendResult> {
  const log = createLoggerFromConfig(config, 'sendProactiveInternal');
  
  log.info(
    "开始处理，参数:",
    JSON.stringify({
      target,
      contentLength: content?.length,
      msgType: options.msgType,
      useAICard: options.useAICard,
      targetType: target?.type,
      hasTarget: !!target,
    }),
  );

  // 参数校验
  if (!target || typeof target !== "object") {
    log.error("target 参数无效:", target);
    return { ok: false, error: "Invalid target parameter", usedAICard: false };
  }

  const {
    msgType = "text",
    useAICard = true,          // 默认启用 AI Card，让主动发送消息优先使用卡片形式
    fallbackToNormal = true,   // 默认降级，AI Card 失败时自动回退到普通消息
    log: externalLog,
  } = options;

  // 图片、音频、视频、文件等媒体类型消息不支持 AI Card，必须走普通消息 API
  const isMediaMessage = MEDIA_MSG_TYPES.has(msgType as any);

  // 如果启用 AI Card（媒体消息强制跳过）
  if (useAICard && !isMediaMessage) {
    try {
      const card = await createAICardForTarget(config, target, externalLog);
      if (card) {
        await finishAICard(card, content, config, externalLog);
        return {
          ok: true,
          cardInstanceId: card.cardInstanceId,
          usedAICard: true,
        };
      }
      if (!fallbackToNormal) {
        return {
          ok: false,
          error: "Failed to create AI Card",
          usedAICard: false,
        };
      }
    } catch (err: any) {
      externalLog?.error?.(`AI Card 发送失败: ${err.message}`);
      if (!fallbackToNormal) {
        return { ok: false, error: err.message, usedAICard: false };
      }
    }
  }

  // 发送普通消息
  try {
    log.info(
      "准备发送普通消息，target.type:",
      target.type,
    );
    const token = await getAccessToken(config);
    const isUser = target.type === "user";
    log.info(
      "isUser:",
      isUser,
      "target:",
      JSON.stringify(target),
    );
    const targetId = isUser ? target.userId : target.openConversationId;
    log.info("targetId:", targetId);

    // ✅ 根据目标类型选择不同的 API
    const webhookUrl = isUser
      ? `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`
      : `${DINGTALK_API}/v1.0/robot/groupMessages/send`;

    // 使用 buildMsgPayload 构建消息体（支持所有消息类型 + 多机器人协作时的 @ 嵌入）
    const payload = buildMsgPayload(msgType, content, options.title, {
      atDingtalkIds: options.atDingtalkIds,
      atUserIds: options.atUserIds,
      atAll: options.atAll,
    });
    if ("error" in payload) {
      log.error("构建消息失败:", payload.error);
      return { ok: false, error: payload.error, usedAICard: false };
    }

    const body: any = {
      robotCode: String(config.clientId),
      msgKey: payload.msgKey,
      msgParam: JSON.stringify(payload.msgParam),
    };

    // ✅ 根据目标类型设置不同的参数
    if (isUser) {
      body.userIds = [targetId];
    } else {
      body.openConversationId = targetId;
    }

    externalLog?.info?.(
      `发送${isUser ? '单聊' : '群聊'}消息：${isUser ? 'userIds=' : 'openConversationId='}${targetId}`,
    );

    const resp = await dingtalkHttp.post(webhookUrl, body, {
      headers: {
        "x-acs-dingtalk-access-token": token,
        "Content-Type": "application/json",
      },
    });

    // 重要：钉钉接口有时会出现 HTTP 200 但业务失败的情况，需要打印返回体辅助排查
    try {
      const dataPreview = JSON.stringify(resp.data ?? {});
      const truncated =
        dataPreview.length > 2000 ? `${dataPreview.slice(0, 2000)}...(truncated)` : dataPreview;
      const msg = `发送${isUser ? "单聊" : "群聊"}消息响应：status=${resp.status}, processQueryKey=${resp.data?.processQueryKey ?? ""}, data=${truncated}`;
      log.info(msg);
      externalLog?.info?.(msg);
    } catch {
      const msg = `发送${isUser ? "单聊" : "群聊"}消息响应：status=${resp.status}, processQueryKey=${resp.data?.processQueryKey ?? ""}`;
      log.info(msg);
      externalLog?.info?.(msg);
    }

    return {
      ok: true,
      processQueryKey: resp.data?.processQueryKey,
      usedAICard: false,
    };
  } catch (err: any) {
    const status = err?.response?.status;
    const respData = err?.response?.data;
    let respPreview = "";
    try {
      const raw = JSON.stringify(respData ?? {});
      respPreview = raw.length > 2000 ? `${raw.slice(0, 2000)}...(truncated)` : raw;
    } catch {
      respPreview = String(respData ?? "");
    }

    const baseMsg = err?.message ? String(err.message) : String(err);
    const extra =
      typeof status === "number"
        ? ` status=${status}${respPreview ? `, data=${respPreview}` : ""}`
        : respPreview
          ? ` data=${respPreview}`
          : "";

    const msg = `发送${target.type === "user" ? "单聊" : "群聊"}消息失败：${baseMsg}${extra}`;
    log.error(msg);
    externalLog?.error?.(msg);
    return { ok: false, error: baseMsg, usedAICard: false };
  }
}
