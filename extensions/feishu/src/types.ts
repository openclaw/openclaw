import type { BaseProbeResult } from "openclaw/plugin-sdk";
import type {
  FeishuConfigSchema,
  FeishuGroupSchema,
  FeishuAccountConfigSchema,
  z,
} from "./config-schema.js";
import type { MentionTarget } from "./mention.js";

export type FeishuConfig = z.infer<typeof FeishuConfigSchema>;
export type FeishuGroupConfig = z.infer<typeof FeishuGroupSchema>;
export type FeishuAccountConfig = z.infer<typeof FeishuAccountConfigSchema>;

export type FeishuDomain = "feishu" | "lark" | (string & {});
export type FeishuConnectionMode = "websocket" | "webhook";

export type ResolvedFeishuAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  appId?: string;
  appSecret?: string;
  encryptKey?: string;
  verificationToken?: string;
  domain: FeishuDomain;
  /** Merged config (top-level defaults + account-specific overrides) */
  config: FeishuConfig;
};

export type FeishuIdType = "open_id" | "user_id" | "union_id" | "chat_id";

export type FeishuMessageContext = {
  chatId: string;
  messageId: string;
  senderId: string;
  senderOpenId: string;
  senderName?: string;
  chatType: "p2p" | "group";
  mentionedBot: boolean;
  rootId?: string;
  parentId?: string;
  content: string;
  contentType: string;
  /** Mention forward targets (excluding the bot itself) */
  mentionTargets?: MentionTarget[];
  /** Extracted message body (after removing @ placeholders) */
  mentionMessageBody?: string;
};

export type FeishuSendResult = {
  messageId: string;
  chatId: string;
};

export type FeishuProbeResult = BaseProbeResult<string> & {
  appId?: string;
  botName?: string;
  botOpenId?: string;
};

export type FeishuMediaInfo = {
  path: string;
  contentType?: string;
  placeholder: string;
};

export type FeishuToolsConfig = {
  doc?: boolean;
  chat?: boolean;
  wiki?: boolean;
  drive?: boolean;
  perm?: boolean;
  scopes?: boolean;
};

export type DynamicAgentCreationConfig = {
  enabled?: boolean;
  workspaceTemplate?: string;
  agentDirTemplate?: string;
  maxAgents?: number;
};
