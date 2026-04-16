import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

// ============================================================================
// 类型别名
// ============================================================================

/**
 * 从 OpenClawPluginApi['registerTool'] 的参数中Extract OpenClawPluginToolFactory，
 * 再从 OpenClawPluginToolFactory 的第一个参数中Extract OpenClawPluginToolContext。
 *
 * 因为 SDK 没有直接导出 OpenClawPluginToolContext，所以这里通过类型推导获取。
 */
type RegisterToolParam = Parameters<OpenClawPluginApi["registerTool"]>[0];

/** 从 registerTool 接受的联合类型中Extract 函数（即 OpenClawPluginToolFactory） */
type ToolFactory = Extract<RegisterToolParam, (...args: never[]) => unknown>;

/** 工具工厂函数接收的会话上下文（从 OpenClawPluginToolFactory 参数推导） */
export type OpenClawPluginToolContext = Parameters<ToolFactory>[0];

// ============================================================================
// 会话判断
// ============================================================================

/**
 * Determine whether the current session is a Yuanbao channel group chat.
 *
 * 同时满足以下两个条件才返回 true：
 * 1. sessionKey 中包含 `:group:`（群聊）
 * 2. messageChannel 为 `yuanbao`（元宝通道）
 *
 * @param ctx - 工具上下文
 * @returns 是元宝通道的群聊返回 true，否则返回 false
 */
export function isYbGroupChat(ctx: OpenClawPluginToolContext): boolean {
  if (ctx.messageChannel === "yuanbao") {
    return ctx.sessionKey?.includes("yuanbao:group:") ?? false;
  }
  return false;
}

// ============================================================================
// 会话解析
// ============================================================================

/**
 * 从 sessionKey 中Extract元宝群聊的 groupCode。
 *
 * sessionKey 格式示例：`agent:<agentId>:yuanbao:group:<groupCode>`
 * 匹配规则：找到 `yuanbao:group:` 后取其后的部分作为 groupCode。
 *
 * @param sessionKey - 会话标识
 * @returns groupCode，未匹配时返回空字符串
 */
export function extractGroupCode(sessionKey: string): string {
  const prefix = "yuanbao:group:";
  const idx = sessionKey.indexOf(prefix);
  if (idx === -1) {
    return "";
  }
  return sessionKey.slice(idx + prefix.length);
}

// ============================================================================
// MCP 响应构建
// ============================================================================

/**
 * 构建纯文本类型的 MCP content 响应。
 *
 * @param text - 响应文本
 * @returns MCP content 数组
 */
export function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

/**
 * 构建 JSON 类型的 MCP content 响应。
 *
 * 将数据序列化为格式化 JSON 字符串作为文本内容，同时在 details 中保留原始数据。
 *
 * @param data - 任意可序列化数据
 * @returns 包含 content 和 details 的响应对象
 */
export function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

// ============================================================================
// 日志脱敏
// ============================================================================

/**
 * 对 MsgBody Message body数组进行脱敏处理，生成可安全记录到日志的摘要字符串。
 * 文本类型消息（TIMTextElem）会对内容做脱敏，其他类型保留原始结构用于排查。
 *
 * @param msg_body - Message body数组，每个元素包含 msg_type 和 msg_content 字段
 * @returns 脱敏后的日志字符串，如 `[text:你好***(3)***世界][TIMImageElem:{...}]`
 *
 * @example
 * ```ts
 * const log = msgBodyDesensitization([
 *   { msg_type: 'TIMTextElem', msg_content: { text: '这是一段测试文本' } },
 *   { msg_type: 'TIMImageElem', msg_content: { url: 'https://example.com/img.png' } },
 * ]);
 * // => '[text:这是***(5)***文本][TIMImageElem:{"url":"https://example.com/img.png"}]'
 * ```
 */
export function msgBodyDesensitization(
  msg_body: Array<{ msg_type?: string; msg_content?: { text?: string } & Record<string, unknown> }>,
) {
  let log = "";
  msg_body.forEach(
    (item: { msg_type?: string; msg_content?: { text?: string } & Record<string, unknown> }) => {
      if (item.msg_type === "TIMTextElem") {
        log += `[text:${textDesensitization(item.msg_content?.text ?? "") ?? "-"}]`;
      } else {
        log += `[${item.msg_type}:${JSON.stringify(item.msg_content)}]`;
      }
    },
  );
  return log;
}

/**
 * 对文本内容进行脱敏处理，保留首尾各 2 个字符，中间部分以 `***` 替代并标注被遮盖的字符数。
 * 当文本长度不超过 5 时，原样返回（信息量过少无需脱敏）。
 *
 * @param text - 需要脱敏的原始文本
 * @returns 脱敏后的文本，如 `你好***(3)***世界`；若长度 ≤ 5 则原样返回
 *
 * @example
 * ```ts
 * textDesensitization('这是一段测试文本'); // => '这是***(5)***文本'
 * textDesensitization('你好世界');          // => '你好世界'（长度 ≤ 5，不脱敏）
 * ```
 */
export function textDesensitization(text: string) {
  if (text.length > 5) {
    return `${text.slice(0, 2)}***(${text.length - 4})***${text.slice(-2)}`;
  }
  return text;
}
