import type { BaseProbeResult } from "openclaw/plugin-sdk/dingtalk";
import type {
  DingtalkConfigSchema,
  DingtalkGroupSchema,
  DingtalkAccountConfigSchema,
  z,
} from "./config-schema.js";

export type DingtalkConfig = z.infer<typeof DingtalkConfigSchema>;
export type DingtalkGroupConfig = z.infer<typeof DingtalkGroupSchema>;
export type DingtalkAccountConfig = z.infer<typeof DingtalkAccountConfigSchema>;

// 账号选择来源 / Account selection source
export type DingtalkDefaultAccountSelectionSource =
  | "explicit-default"
  | "mapped-default"
  | "fallback";
export type DingtalkAccountSelectionSource = "explicit" | DingtalkDefaultAccountSelectionSource;

// 解析后的钉钉账号 / Resolved DingTalk account
export type ResolvedDingtalkAccount = {
  accountId: string;
  selectionSource: DingtalkAccountSelectionSource;
  enabled: boolean;
  configured: boolean;
  name?: string;
  clientId?: string;
  clientSecret?: string;
  robotCode?: string;
  // 合并后的配置（顶层默认值 + 账号级别覆盖） / Merged config (top-level defaults + account overrides)
  config: DingtalkConfig;
};

// 钉钉消息回调数据结构 / DingTalk robot message callback data structure
export type DingtalkRobotMessage = {
  conversationId: string;
  chatbotCorpId: string;
  chatbotUserId: string;
  msgId: string;
  senderNick: string;
  isAdmin: boolean;
  senderStaffId: string;
  sessionWebhookExpiredTime: number;
  createAt: number;
  senderCorpId: string;
  // "1" = 单聊, "2" = 群聊 / "1" = DM, "2" = group chat
  conversationType: "1" | "2";
  senderId: string;
  sessionWebhook: string;
  robotCode: string;
  msgtype: string;
  // 文本消息内容 / Text message content
  text?: { content: string };
  // 图片消息 / Image message
  content?: string;
  // 群聊标题 / Group chat title
  conversationTitle?: string;
  // @列表 / At-list
  atUsers?: Array<{
    dingtalkId: string;
    staffId?: string;
  }>;
  // 是否在 @列表 中 / Whether the bot is in the at-list
  isInAtList?: boolean;
};

// 解析后的钉钉消息上下文 / Parsed DingTalk message context
export type DingtalkMessageContext = {
  conversationId: string;
  messageId: string;
  senderId: string;
  senderStaffId: string;
  senderNick: string;
  // "1" = 单聊, "2" = 群聊 / "1" = direct, "2" = group
  conversationType: "1" | "2";
  mentionedBot: boolean;
  content: string;
  contentType: string;
  sessionWebhook: string;
  sessionWebhookExpiredTime: number;
  robotCode: string;
  chatbotUserId: string;
  conversationTitle?: string;
};

// 钉钉消息发送结果 / DingTalk message send result
export type DingtalkSendResult = {
  processQueryKey?: string;
};

// 钉钉探测结果 / DingTalk probe result
export type DingtalkProbeResult = BaseProbeResult<string> & {
  clientId?: string;
  robotCode?: string;
};
