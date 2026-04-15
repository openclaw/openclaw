export type YuanbaoDmConfig = {
  policy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
};

export type YuanbaoOverflowPolicy = "stop" | "split";
export type YuanbaoReplyToMode = "off" | "first" | "all";
export type YuanbaoLogInfoExt = {
  trace_id?: string;
};

export type YuanbaoConnectionMode = "websocket";

export type YuanbaoAccountConfig = {
  name?: string;
  enabled?: boolean;

  /** Bot AppKey (used for signing and ticket generation) */
  appKey?: string;
  /** Bot AppSecret (used for signing) */
  appSecret?: string;
  apiDomain?: string; // 接口域名
  logUploadApiUrl?: string; // issue-log 日志登记接口地址
  wsUrl?: string; // WebSocket 地址
  /** Pre-signed token (skips automatic ticket signing if provided) */
  token?: string;

  dm?: YuanbaoDmConfig;
  overflowPolicy?: YuanbaoOverflowPolicy;
  /** Group chat reply-to strategy：off=不引用，first=同一入站消息仅首次引用，all=每条都引用 */
  replyToMode?: YuanbaoReplyToMode;
  routeEnv?: string; // 内部路由环境标识

  /** Media upload configuration */
  /** Max file size in MB (default 20) */
  mediaMaxMb?: number;

  /** Max group chat history context entries (defaults to SDK built-in value) */
  historyLimit?: number;

  /** Whether to disable block streaming output (default false) */
  disableBlockStreaming?: boolean;
  /** Whether group chat requires @mention to reply (default true)*/
  requireMention?: boolean;
  /** Fallback reply text, automatically sent to the user when the AI model returns no reply content */
  fallbackReply?: string;
  /** Whether to inject instructions in the system prompt to prevent markdown code blocks from wrapping the entire reply (default true) */
  markdownHintEnabled?: boolean;
  /** Debug whitelist Bot IDs; logs for whitelisted bots are not sanitized */
  debugBotIds?: string[];
};

export type YuanbaoConfig = YuanbaoAccountConfig & {
  accounts?: Record<string, YuanbaoAccountConfig>;
  defaultAccount?: string;
  /** Internal routing environment identifier */
  routeEnv?: string;
};

export type ResolvedYuanbaoAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  appKey?: string;
  appSecret?: string;
  botId?: string;
  apiDomain?: string; // 接口域名
  wsUrl?: string; // WebSocket 地址
  token?: string;
  wsGatewayUrl: string;
  wsHeartbeatInterval?: number;
  wsMaxReconnectAttempts: number;
  overflowPolicy: YuanbaoOverflowPolicy;
  /** Group chat reply-to strategy */
  replyToMode: YuanbaoReplyToMode;
  /** Internal routing environment identifier */
  /** Max file size in MB */
  mediaMaxMb: number;
  /** Max group chat history context entries */
  historyLimit: number;
  /** Whether to disable block streaming output */
  disableBlockStreaming: boolean;
  /** Whether group chat requires @mention to reply (default true)*/
  requireMention: boolean;
  /** Fallback reply text, automatically sent to the user when the AI model returns no reply content */
  fallbackReply?: string;
  /** Whether to inject instructions in the system prompt to prevent markdown code blocks from wrapping the entire reply */
  markdownHintEnabled: boolean;
  config: YuanbaoAccountConfig;
};

// Image info array element
export type ImImageInfoArrayItem = {
  type?: number; // 原图
  size?: number;
  width?: number;
  height?: number;
  url?: string;
};

// Tencent IM message body element
export type YuanbaoMsgBodyElement = {
  msg_type: string;
  msg_content: {
    text?: string; // 文字聊天内容
    uuid?: string; // 图片
    image_format?: number; // 图片格式
    data?: string; // 扩展数据
    desc?: string; // 描述
    ext?: string; // 扩展字段
    sound?: string; // 语音
    image_info_array?: ImImageInfoArrayItem[]; // 图片内容
    index?: number; // 表情索引
    url?: string; // 文件下载地址
    file_size?: number; // 文件大小（字节）
    file_name?: string; // 文件名称
    // Extensible fields for other message types
    [key: string]: unknown;
  };
};

// Cloud IM message sequence number (used for message recall)
export type ImMsgSeq = {
  /** Message sequence number */
  msg_seq?: number;
  /** Client message unique identifier */
  msg_id?: string;
};

// Message type enum
export enum EnumCLawMsgType {
  CLAW_MSG_UNKNOWN = 0,
  CLAW_MSG_GROUP = 1,
  CLAW_MSG_PRIVATE = 2,
}

// Tencent IM inbound message
export type YuanbaoInboundMessage = {
  callback_command?: string;
  from_account?: string;
  to_account?: string;
  sender_nickname?: string;
  group_id?: string;
  group_code?: string;
  group_name?: string;
  msg_seq?: number;
  msg_random?: number;
  msg_time?: number;
  msg_key?: string;
  msg_id?: string;
  online_only_flag?: number;
  send_msg_result?: number;
  error_info?: string;
  msg_body?: YuanbaoMsgBodyElement[];
  cloud_custom_data?: string;
  event_time?: number;
  bot_owner_id?: string;
  /** Recall消息时携带的Message sequence number列表（Group/C2C.CallbackAfterMsgWithDraw） */
  recall_msg_seq_list?: ImMsgSeq[];
  /** Message type (group/direct) */
  claw_msg_type?: EnumCLawMsgType;
  /** Source group code for direct messages (identifies which group the user initiated the DM from) */
  private_from_group_code?: string;
  /** Trace ID; plugin side generates a fallback when missing */
  trace_id?: string;
  /** Sequence identifier for the current message; prefers real msg_seq, can serve as a trace correlation auxiliary field */
  seq_id?: string;
};

// Quote message info (from cloud_custom_data.quote)
export type QuoteInfo = {
  /** ID of the quoted message */
  id?: string;
  /** Sequence number of the quoted message */
  seq?: number;
  /** Send time of the quoted message (Unix seconds) */
  time?: number;
  /** Message type */
  type?: number;
  /** Message status */
  status?: number;
  /** Text summary of the quoted message */
  desc?: string;
  /** Sender ID of the quoted message */
  sender_id?: string;
  /** Sender nickname of the quoted message */
  sender_nickname?: string;
};

// Parsed structure of cloud_custom_data
export type CloudCustomData = {
  env?: string;
  message_type?: number;
  quote?: QuoteInfo;
  source_group?: string;
  [key: string]: unknown;
};

// Tencent IM send message request
export type YuanbaoSendMsgRequest = {
  sync_other_machine?: number;
  from_account?: string;
  to_account: string;
  msg_seq?: number;
  msg_random: number;
  msg_body: YuanbaoMsgBodyElement[];
  log_ext?: YuanbaoLogInfoExt;
  cloud_custom_data?: string;
  offline_push_info?: {
    push_flag?: number;
    desc?: string;
    ext?: string;
  };
};

// Tencent IM send message response
export type YuanbaoSendMsgResponse = {
  action_status: string;
  error_code: number;
  error_info: string;
  msg_time?: number;
  msg_key?: string;
  msg_id?: string;
  msg_seq?: number;
  stream_msg_id?: string;
};

// Tencent IM group message send request
export type YuanbaoSendGroupMsgRequest = {
  group_code: string;
  random: number;
  msg_seq?: number;
  msg_body: YuanbaoMsgBodyElement[];
  from_account?: string;
  log_ext?: YuanbaoLogInfoExt;
  msg_priority?: string;
  cloud_custom_data?: string;
};
