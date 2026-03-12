/**
 * 路径 B：Channel dispatch → AgentInput 转化
 * 复刻 openclaw 的 runPreparedReply() 中的 prompt 组装逻辑
 * （src/auto-reply/reply/get-reply-run.ts:270-275, 525）
 */

import type { AgentInput, ChannelMsgContext, ImageContent } from "../types.js";

/**
 * 从文件扩展名推断 MIME 类型
 * @param ext 文件扩展名（如 "jpg", "png", "webp"）
 * @returns MIME 类型字符串
 */
function getMimeTypeFromExtension(ext: string): string {
  const mimeMap: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    ico: "image/x-icon",
  };
  return mimeMap[ext] || "image/jpeg"; // 默认使用 image/jpeg
}

/**
 * 从 ChannelMsgContext 构建 AgentInput
 *
 * 核心逻辑（对应 openclaw runPreparedReply）：
 * 1. 提取 BodyForAgent 作为 message（用户消息 + 前置系统指令）
 * 2. 组装 extraSystemPrompt = [groupChat, groupIntro, groupSystemPrompt] （去重并过滤空值）
 * 3. 提取 MediaPaths/MediaUrls → images[]
 * 4. 传递 SessionKey, AccountId, Provider, ChatType 等元数据
 *
 * @param ctx ChannelMsgContext（从插件传入的消息上下文）
 * @returns AgentInput
 */
export function transformChannelToAgentInput(ctx: ChannelMsgContext): AgentInput {
  // Step 1: 提取用户消息（BodyForAgent 优先，回退到 Body）
  const message = ctx.BodyForAgent || ctx.Body || ctx.RawBody || "";

  // Step 2: 组装 extraSystemPrompt（对应 openclaw 的 extraSystemPromptParts）
  // 官方顺序：[inboundMetaPrompt, groupChatContext, groupIntro, groupSystemPrompt]
  // demo 简化：跳过 inboundMetaPrompt（需要完整 session 上下文）和 groupIntro（需要激活状态）
  // 保留：groupChatContext（群名 + 成员）和 groupSystemPrompt
  const extraSystemPromptParts: string[] = [];

  // 2.1 群聊上下文（对应 openclaw 的 groupChatContext = buildGroupChatContext()）
  // 官方 buildGroupChatContext 使用：GroupSubject（群名）+ GroupMembers（成员列表）
  if (ctx.ChatType === "group") {
    const groupContextLines: string[] = [];
    if (ctx.GroupSubject?.trim()) {
      groupContextLines.push(`Group Name: ${ctx.GroupSubject.trim()}`);
    }
    if (ctx.GroupMembers?.trim()) {
      groupContextLines.push(`Members: ${ctx.GroupMembers.trim()}`);
    }
    if (groupContextLines.length > 0) {
      extraSystemPromptParts.push(`# Group Chat Context\n${groupContextLines.join("\n")}`);
    }
  }

  // 2.2 群组系统提示词（对应 openclaw 的 groupSystemPrompt = GroupSystemPrompt）
  const groupSystemPrompt = ctx.GroupSystemPrompt?.trim() ?? "";
  if (groupSystemPrompt) {
    extraSystemPromptParts.push(groupSystemPrompt);
  }

  // 2.3 合并（对应 openclaw 的 extraSystemPromptParts.join("\n\n") || undefined）
  const extraSystemPrompt =
    extraSystemPromptParts.length > 0 ? extraSystemPromptParts.join("\n\n") : undefined;

  // Step 3: 提取媒体附件（优先 MediaPaths，回退到 MediaUrls）
  const images: ImageContent[] = [];

  // 3.1 处理本地文件路径
  if (ctx.MediaPaths && ctx.MediaPaths.length > 0) {
    for (const path of ctx.MediaPaths) {
      // 将本地路径转为 file:// URI（ImageContent.data 字段）
      // mimeType 从文件扩展名推断（简化处理，生产环境应使用 magic number 检测）
      const ext = path.split(".").pop()?.toLowerCase() || "";
      const mimeType = getMimeTypeFromExtension(ext);
      images.push({
        type: "image",
        data: `file://${path}`,
        mimeType,
      });
    }
  }

  // 3.2 处理远程 URL
  if (ctx.MediaUrls && ctx.MediaUrls.length > 0) {
    for (const url of ctx.MediaUrls) {
      // URL 直接使用（ImageContent.data 字段）
      // mimeType 从 URL 扩展名推断或使用默认值
      const ext = url.split(".").pop()?.split("?")[0]?.toLowerCase() || "";
      const mimeType = getMimeTypeFromExtension(ext);
      images.push({
        type: "image",
        data: url,
        mimeType,
      });
    }
  }

  // Step 4: 构造 AgentInput（对齐 AgentCommandOpts 原生字段）
  return {
    // ── 核心字段 ──
    message,
    extraSystemPrompt,
    images: images.length > 0 ? images : undefined,

    // ── 会话和路由 ──
    sessionKey: ctx.SessionKey,
    messageChannel: ctx.OriginatingChannel || ctx.Provider,
    channel: ctx.OriginatingChannel || ctx.Provider,
    accountId: ctx.AccountId,

    // ── 群组/线程上下文 ──
    groupId: ctx.GroupSubject, // 群组标识（对应 AgentCommandOpts.groupId）
    groupChannel: ctx.GroupChannel, // 群组频道
    groupSpace: ctx.GroupSpace, // 群组空间
    threadId: ctx.MessageThreadId, // 线程 ID

    // ── 回复路由 ──
    replyTo: ctx.OriginatingTo, // 回复目标
    replyChannel: ctx.OriginatingChannel, // 回复渠道

    // ── 权限和元数据 ──
    senderIsOwner: ctx.CommandAuthorized ?? false,
    inputProvenance: ctx.InputProvenance || {
      kind: "external_user",
      sourceChannel: ctx.OriginatingChannel || ctx.Provider,
    },
  };
}

/**
 * 辅助函数：验证 ChannelMsgContext 的必要字段
 *
 * @param ctx 待验证的上下文
 * @returns 验证结果（{ valid: boolean, missingFields?: string[] }）
 */
export function validateChannelMsgContext(ctx: unknown): {
  valid: boolean;
  missingFields?: string[];
} {
  if (!ctx || typeof ctx !== "object") {
    return { valid: false, missingFields: ["ctx is null or not an object"] };
  }

  const typedCtx = ctx as Record<string, unknown>;
  const requiredFields = ["BodyForAgent", "Body", "RawBody"]; // 至少需要一个消息体字段
  const missingFields: string[] = [];

  // 检查是否至少有一个消息体字段
  const hasBodyField = requiredFields.some((field) => {
    const value = typedCtx[field];
    return typeof value === "string" && value.trim().length > 0;
  });

  if (!hasBodyField) {
    missingFields.push("BodyForAgent | Body | RawBody (at least one required)");
  }

  return {
    valid: missingFields.length === 0,
    missingFields: missingFields.length > 0 ? missingFields : undefined,
  };
}
