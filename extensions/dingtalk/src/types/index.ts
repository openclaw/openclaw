// 本地类型定义
interface BaseProbeResult<T = any> {
  ok: boolean;
  error?: string;
  data?: T;
  [key: string]: any;
}

import type {
  DingtalkConfigSchema,
  DingtalkGroupSchema,
  DingtalkAccountConfigSchema,
  z,
} from "../config/schema.ts";

export type DingtalkConfig = z.infer<typeof DingtalkConfigSchema>;
export type DingtalkGroupConfig = z.infer<typeof DingtalkGroupSchema>;
export type DingtalkAccountConfig = z.infer<typeof DingtalkAccountConfigSchema>;

export type DingtalkConnectionMode = "stream";

export type DingtalkDefaultAccountSelectionSource =
  | "explicit-default"
  | "mapped-default"
  | "fallback";
export type DingtalkAccountSelectionSource = "explicit" | DingtalkDefaultAccountSelectionSource;

export type ResolvedDingtalkAccount = {
  accountId: string;
  selectionSource: DingtalkAccountSelectionSource;
  enabled: boolean;
  configured: boolean;
  name?: string;
  clientId?: string;
  clientSecret?: string;
  /** Merged config (top-level defaults + account-specific overrides) */
  config: DingtalkConfig;
};

export type DingtalkMessageContext = {
  conversationId: string;
  messageId: string;
  senderId: string;
  senderName?: string;
  conversationType: "1" | "2"; // 1=单聊, 2=群聊
  content: string;
  contentType: string;
  groupSubject?: string;
};

export type DingtalkSendResult = {
  messageId: string;
  conversationId: string;
};

export type DingtalkProbeResult = BaseProbeResult<string> & {
  clientId?: string;
  botName?: string;
};
