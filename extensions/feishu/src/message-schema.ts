import { z } from "zod";

/**
 * Feishu message operations schema.
 * Supports: list, recall, delete
 *
 * Note: start_time/end_time use Unix timestamp seconds (string format)
 * as required by Feishu API, not ISO 8601.
 */
export const FeishuMessageSchema = z.object({
  action: z
    .enum(["list", "recall", "delete"])
    .describe("操作类型：list(列出消息), recall(撤回消息), delete(删除消息)"),
  chat_id: z.string().describe("会话 ID（群聊或单聊）"),
  message_id: z.string().optional().describe("消息 ID（recall/delete 操作必填）"),
  start_time: z
    .string()
    .optional()
    .describe('起始时间（秒级 Unix 时间戳字符串，例如 "1609296809"，list 操作可选）'),
  end_time: z
    .string()
    .optional()
    .describe('结束时间（秒级 Unix 时间戳字符串，例如 "1609296809"，list 操作可选）'),
  page_size: z
    .number()
    .min(1)
    .max(50)
    .optional()
    .default(20)
    .describe("每页消息数（1-50，list 操作可选）"),
  page_token: z.string().optional().describe("分页标记（list 操作可选）"),
});

export type FeishuMessageParams = z.infer<typeof FeishuMessageSchema>;
