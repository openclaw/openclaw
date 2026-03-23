/**
 * QQ Bot 配置类型
 */
export interface QQBotConfig {
  appId: string;
  clientSecret?: string;
  clientSecretFile?: string;
}

/**
 * 解析后的 QQ Bot 账户
 */
export interface ResolvedQQBotAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  appId: string;
  clientSecret: string;
  secretSource: "config" | "file" | "env" | "none";
  /** 系统提示词 */
  systemPrompt?: string;
  /** 图床服务器公网地址 */
  imageServerBaseUrl?: string;
  /** 是否支持 markdown 消息（默认 true） */
  markdownSupport: boolean;
  config: QQBotAccountConfig;
}

/**
 * QQ Bot 账户配置
 */
export interface QQBotAccountConfig {
  enabled?: boolean;
  name?: string;
  appId?: string;
  clientSecret?: string;
  clientSecretFile?: string;
  dmPolicy?: "open" | "pairing" | "allowlist";
  allowFrom?: string[];
  /** 系统提示词，会添加在用户消息前面 */
  systemPrompt?: string;
  /** 图床服务器公网地址，用于发送图片，例如 http://your-ip:18765 */
  imageServerBaseUrl?: string;
  /** 是否支持 markdown 消息（默认 true，设为 false 可禁用） */
  markdownSupport?: boolean;
  /**
   * @deprecated 请使用 audioFormatPolicy.uploadDirectFormats
   * 可直接上传的音频格式（不转换为 SILK），向后兼容
   */
  voiceDirectUploadFormats?: string[];
  /**
   * 音频格式策略配置
   * 统一管理入站（STT）和出站（上传）的音频格式转换行为
   */
  audioFormatPolicy?: AudioFormatPolicy;
  /**
   * 是否启用公网 URL 直传 QQ 平台（默认 true）
   * 启用时：公网 URL 先直传给 QQ 开放平台的富媒体 API，平台自行拉取；失败后自动 fallback 到插件下载再 Base64 上传
   * 禁用时：公网 URL 始终由插件先下载到本地，再以 Base64 上传（适用于 QQ 平台无法访问目标 URL 的场景）
   */
  urlDirectUpload?: boolean;
  /**
   * /bot-upgrade 指令返回的升级指引网址
   * 默认: https://doc.weixin.qq.com/doc/w3_AKEAGQaeACgCNHrh1CbHzTAKtT2gB?scode=AJEAIQdfAAozxFEnLZAKEAGQaeACg
   */
  upgradeUrl?: string;
  /**
   * /bot-upgrade 指令的行为模式
   * - "doc"：展示升级文档链接（默认，安全模式）
   * - "hot-reload"：检测到新版本时直接执行 npm 升级脚本进行热更新
   */
  upgradeMode?: "doc" | "hot-reload";
}

/**
 * 音频格式策略：控制哪些格式可跳过转换
 */
export interface AudioFormatPolicy {
  /**
   * STT 模型直接支持的音频格式（入站：跳过 SILK→WAV 转换）
   * 如果 STT 服务支持直接处理某些格式（如 silk/amr），可将其加入此列表
   * 例如: [".silk", ".amr", ".wav", ".mp3", ".ogg"]
   * 默认为空（所有语音都先转换为 WAV 再送 STT）
   */
  sttDirectFormats?: string[];
  /**
   * QQ 平台支持直传的音频格式（出站：跳过→SILK 转换）
   * 默认为 [".wav", ".mp3", ".silk"]（QQ Bot API 原生支持的三种格式）
   * 仅当需要覆盖默认值时才配置此项
   */
  uploadDirectFormats?: string[];
  /**
   * 是否启用语音转码（默认 true）
   * 设为 false 可在环境无 ffmpeg 时跳过转码，直接以文件形式发送
   * 当禁用时，非原生格式的音频会 fallback 到 sendDocument（文件发送）
   */
  transcodeEnabled?: boolean;
}

/**
 * 富媒体附件
 */
export interface MessageAttachment {
  content_type: string; // 如 "image/png"
  filename?: string;
  height?: number;
  width?: number;
  size?: number;
  url: string;
  voice_wav_url?: string; // QQ 提供的 WAV 格式语音直链，有值时优先使用以避免 SILK→WAV 转换
  asr_refer_text?: string; // QQ 事件内置 ASR 语音识别文本
}

/**
 * C2C 消息事件
 */
export interface C2CMessageEvent {
  author: {
    id: string;
    union_openid: string;
    user_openid: string;
  };
  content: string;
  id: string;
  timestamp: string;
  message_scene?: {
    source: string;
    /** ext 数组，可能包含 ref_msg_idx=REFIDX_xxx（引用的消息）和 msg_idx=REFIDX_xxx（自身索引） */
    ext?: string[];
  };
  attachments?: MessageAttachment[];
}

/**
 * 频道 AT 消息事件
 */
export interface GuildMessageEvent {
  id: string;
  channel_id: string;
  guild_id: string;
  content: string;
  timestamp: string;
  author: {
    id: string;
    username?: string;
    bot?: boolean;
  };
  member?: {
    nick?: string;
    joined_at?: string;
  };
  attachments?: MessageAttachment[];
}

/**
 * 群聊 AT 消息事件
 */
export interface GroupMessageEvent {
  author: {
    id: string;
    member_openid: string;
  };
  content: string;
  id: string;
  timestamp: string;
  group_id: string;
  group_openid: string;
  message_scene?: {
    source: string;
    ext?: string[];
  };
  attachments?: MessageAttachment[];
}

/**
 * WebSocket 事件负载
 */
export interface WSPayload {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}
