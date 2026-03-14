/**
 * 路径 A：HTTP API → AgentInput 转化
 * 复刻 openclaw 的 buildAgentPrompt() 逻辑（src/gateway/openai-http.ts:321-387）
 */

import type { AgentInput, ImageContent } from "../types.js";

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
 * OpenAI 兼容的消息格式
 */
export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool" | "developer";
  content:
    | string
    | Array<{ type: "text" | "image_url"; text?: string; image_url?: { url: string } }>;
  name?: string;
  tool_call_id?: string;
}

/**
 * OpenAI Chat Completion 请求体
 */
export interface OpenAIChatRequest {
  model?: string;
  messages: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  // ... 其他 OpenAI 参数
}

/**
 * 从 OpenAI messages 中构建 AgentInput
 *
 * 核心逻辑（对应 openclaw buildAgentPrompt）：
 * 1. 遍历 messages，分离 system/developer role 和 user/assistant/tool role
 * 2. system/developer → extraSystemPrompt
 * 3. user/assistant/tool → conversationEntries → message
 * 4. 提取图片 URL → images[]
 *
 * @param request OpenAI Chat Completion 请求体
 * @param metadata 额外的元数据（channel, accountId 等）
 * @returns AgentInput
 */
export function transformHttpToAgentInput(
  request: OpenAIChatRequest,
  metadata?: {
    channel?: string;
    accountId?: string;
    sessionKey?: string;
    senderIsOwner?: boolean;
  },
): AgentInput {
  const { messages } = request;

  // Step 1: 分离 system prompts 和 conversation entries
  const systemParts: string[] = [];
  const conversationEntries: string[] = [];
  const images: ImageContent[] = [];

  for (const msg of messages) {
    const { role, content } = msg;

    // 处理 system 和 developer role
    if (role === "system" || role === "developer") {
      if (typeof content === "string") {
        systemParts.push(content);
      } else if (Array.isArray(content)) {
        // 处理多模态 content（虽然 system 通常是纯文本）
        for (const part of content) {
          if (part.type === "text" && part.text) {
            systemParts.push(part.text);
          }
        }
      }
      continue;
    }

    // 处理 user/assistant/tool role
    if (role === "user" || role === "assistant" || role === "tool") {
      const prefix =
        role === "assistant"
          ? "Assistant: "
          : role === "tool"
            ? `Tool (${msg.name || msg.tool_call_id}): `
            : "User: ";

      if (typeof content === "string") {
        conversationEntries.push(`${prefix}${content}`);
      } else if (Array.isArray(content)) {
        // 处理多模态 content（user 可能包含图片）
        const textParts: string[] = [];
        for (const part of content) {
          if (part.type === "text" && part.text) {
            textParts.push(part.text);
          } else if (part.type === "image_url" && part.image_url?.url) {
            // 提取图片 URL
            const url = part.image_url.url;
            let mimeType = "image/jpeg"; // 默认值
            let data = url;

            if (url.startsWith("http://") || url.startsWith("https://")) {
              // 远程 URL：从扩展名推断 MIME 类型
              const ext = url.split(".").pop()?.split("?")[0]?.toLowerCase() || "";
              mimeType = getMimeTypeFromExtension(ext);
            } else if (url.startsWith("data:image/")) {
              // base64 Data URI：从 data: 前缀提取 MIME 类型
              const match = url.match(/^data:(image\/[^;]+);/);
              if (match) {
                mimeType = match[1];
              }
            }

            images.push({ type: "image", data, mimeType });
            textParts.push("[图片]");
          }
        }
        if (textParts.length > 0) {
          conversationEntries.push(`${prefix}${textParts.join(" ")}`);
        }
      }
    }
  }

  // Step 2: 合并 system prompts
  const extraSystemPrompt = systemParts.length > 0 ? systemParts.join("\n\n") : undefined;

  // Step 3: 合并 conversation entries
  // 对应 openclaw 的逻辑：如果只有一条 user 消息，不加前缀；否则保留多轮对话格式
  let message: string;
  if (conversationEntries.length === 1 && conversationEntries[0].startsWith("User: ")) {
    message = conversationEntries[0].replace(/^User: /, "");
  } else {
    message = conversationEntries.join("\n\n");
  }

  // Step 4: 构造 AgentInput（对齐 AgentCommandOpts 原生字段）
  return {
    // ── 核心字段 ──
    message,
    extraSystemPrompt,
    images: images.length > 0 ? images : undefined,

    // ── 会话和路由 ──
    sessionKey: metadata?.sessionKey,
    messageChannel: metadata?.channel,
    channel: metadata?.channel,
    accountId: metadata?.accountId,

    // ── 权限和元数据 ──
    senderIsOwner: metadata?.senderIsOwner ?? false,
    inputProvenance: {
      kind: "external_user",
      sourceChannel: metadata?.channel,
    },
  };
}
