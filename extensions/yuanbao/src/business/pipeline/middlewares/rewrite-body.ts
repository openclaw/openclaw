/**
 * 中间件：命令改写 + 引用拼接 + mentions 拼接
 *
 * 将斜杠命令改写为自然语言，拼接引用消息和 @用户信息。
 */

import { formatQuoteContext } from "../../messaging/quote.js";
import type { MiddlewareDescriptor } from "../types.js";

// ============ 斜杠命令改写 ============

/** /yuanbao-health-check 命令的正则：可选的 start_time 和 end_time（HH:MM 格式） */
const SLASH_HEALTH_CHECK_RE =
  /^\/yuanbao-health-check(?:\s+(\d{1,2}:\d{2})(?:\s+(\d{1,2}:\d{2}))?)?\s*$/;

/**
 * Rewrite recognized slash commands into natural language queries.
 *
 * Supported commands:
 * - `/yuanbao-health-check [start_time] [end_time]`
 *   → "查询{start_time}到{end_time}时间段内的 warn 和 error 日志摘要并发给我"
 *   如果未提供时间参数，则Default为「过去10分钟」。
 *
 * @param text - 原始消息文本
 * @param onRewrite - 可选的回调函数，当发生改写时被调用
 * @returns 改写后的文本；如果没有匹配到任何命令则返回原始文本
 */
function rewriteSlashCommand(
  text: string,
  onRewrite?: (original: string, rewritten: string) => void,
): string {
  const trimmed = text.trim();
  const match = SLASH_HEALTH_CHECK_RE.exec(trimmed);
  if (!match) {
    return text;
  }

  const startTime = match[1];
  const endTime = match[2];

  const result =
    startTime && endTime
      ? `查询 openclaw 系统 [yuanbao channel] 从${startTime}到${endTime}时间段内的 warn 和 error 日志`
      : "查询 openclaw 系统 [yuanbao channel] 过去10分钟内的 warn 和 error 日志";

  const prompt = `
    ${result}

    **要求**：
    - 不要输出你的思考过程
    - 只列出日志摘要，不用分析代码层面的问题。
    - 输出格式为纯文本，不要任何 Markdown 语法。
    - 每条日志摘要占一行，行首不需要任何符号。
  `;

  onRewrite?.(text, prompt);

  return prompt;
}

export const rewriteBody: MiddlewareDescriptor = {
  name: "rewrite-body",
  handler: async (ctx, next) => {
    const { rawBody, quoteInfo, mentions, isGroup } = ctx;

    // 斜杠命令改写
    const rewritten = rewriteSlashCommand(rawBody, (orig, result) => {
      ctx.log.info("[rewrite-body] command rewrite", { orig, result });
    });

    // Group chat scenario:附加 mentions 信息
    const mentionsContext =
      isGroup && mentions && mentions.length > 0
        ? `\n[消息中@了以下用户: ${mentions.map((m) => `${m.text}(userId: ${m.userId})`).join(", ")}]`
        : "";

    // 拼接引用上下文
    ctx.rewrittenBody = quoteInfo
      ? `${formatQuoteContext(quoteInfo)}\n${rewritten}${mentionsContext}`
      : `${rewritten}${mentionsContext}`;

    await next();
  },
};
