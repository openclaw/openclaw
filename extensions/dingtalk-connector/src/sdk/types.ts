/**
 * DingTalk Connector SDK Types
 * 
 * 完全独立的类型定义，不依赖任何外部 SDK。
 * 这是钉钉连接器插件的核心类型系统。
 */

// ============================================================================
// 基础类型
// ============================================================================

/**
 * SecretInput 支持多种输入方式
 */
export type SecretInput = 
  | string // 直接字符串
  | SecretInputRef; // 引用

/**
 * SecretInput 引用类型
 */
export interface SecretInputRef {
  source: "env" | "file" | "exec";
  provider: string;
  id: string;
}

/**
 * 工具权限策略
 */
export interface ToolPolicy {
  allow?: string[];
  deny?: string[];
}

/**
 * DM 策略
 */
export type DmPolicy = "open" | "pairing" | "allowlist";

/**
 * 群组策略
 */
export type GroupPolicy = "open" | "allowlist" | "disabled";

/**
 * 会话作用域
 */
export type GroupSessionScope = "group" | "group_sender";

/**
 * 发送模式
 */
export type DeliveryMode = "direct" | "queued";

// ============================================================================
// 配置类型
// ============================================================================

/**
 * 钉钉工具配置
 */
export interface DingtalkToolsConfig {
  docs?: boolean;
  media?: boolean;
}

/**
 * 钉钉群组配置
 */
export interface DingtalkGroupConfig {
  requireMention?: boolean;
  tools?: ToolPolicy;
  enabled?: boolean;
  allowFrom?: (string | number)[];
  systemPrompt?: string;
  groupSessionScope?: GroupSessionScope;
}

/**
 * 钉钉账号配置
 */
export interface DingtalkAccountConfig {
  enabled?: boolean;
  name?: string;
  clientId?: string | number;
  clientSecret?: SecretInput;
  /**
   * 当前机器人的加密身份。多机器人协作时，其他 Agent 通过 atDingtalkIds=[chatbotUserId]
   * 在群消息里 @ 该机器人。从 connector 启动后第一条群/单聊消息日志的 [BotIdentity] 行获取。
   */
  chatbotUserId?: string;
  chatbotCorpId?: string;
  enableMediaUpload?: boolean;
  systemPrompt?: string;
  dmPolicy?: DmPolicy;
  allowFrom?: (string | number)[];
  groupPolicy?: GroupPolicy;
  groupAllowFrom?: (string | number)[];
  requireMention?: boolean;
  groupSessionScope?: GroupSessionScope;
  separateSessionByConversation?: boolean;
  sharedMemoryAcrossConversations?: boolean;
  historyLimit?: number;
  textChunkLimit?: number;
  mediaMaxMb?: number;
  typingIndicator?: boolean;
  tools?: DingtalkToolsConfig;
}

/**
 * 钉钉通道配置
 */
export interface DingtalkConfig {
  enabled?: boolean;
  defaultAccount?: string;
  clientId?: string | number;
  clientSecret?: SecretInput;
  enableMediaUpload?: boolean;
  systemPrompt?: string;
  dmPolicy?: DmPolicy;
  allowFrom?: (string | number)[];
  groupPolicy?: GroupPolicy;
  groupAllowFrom?: (string | number)[];
  requireMention?: boolean;
  groupSessionScope?: GroupSessionScope;
  separateSessionByConversation?: boolean;
  sharedMemoryAcrossConversations?: boolean;
  historyLimit?: number;
  textChunkLimit?: number;
  mediaMaxMb?: number;
  typingIndicator?: boolean;
  resolveSenderNames?: boolean;
  tools?: DingtalkToolsConfig;
  groups?: Record<string, DingtalkGroupConfig>;
  accounts?: Record<string, DingtalkAccountConfig>;
}

/**
 * 通道配置映射
 */
export interface ChannelsConfig {
  [key: string]: unknown;
  "dingtalk-connector"?: DingtalkConfig;
}

/**
 * 全局配置
 */
export interface ClawdbotConfig {
  channels?: ChannelsConfig;
  [key: string]: unknown;
}

// ============================================================================
// 通道插件类型
// ============================================================================

/**
 * 通道元数据
 */
export interface ChannelMeta {
  id: string;
  label: string;
  selectionLabel: string;
  docsPath: string;
  docsLabel: string;
  blurb: string;
  aliases: string[];
  order: number;
}

/**
 * 通道能力
 */
export interface ChannelCapabilities {
  chatTypes: ("direct" | "group")[];
  polls: boolean;
  threads: boolean;
  media: boolean;
  reactions: boolean;
  edit: boolean;
  reply: boolean;
  nativeCommands?: boolean;
}

/**
 * 配对功能
 */
export interface ChannelPairing {
  idLabel: string;
  normalizeAllowEntry: (entry: string) => string;
  notifyApproval: (params: { cfg: ClawdbotConfig; id: string }) => Promise<void>;
}

/**
 * Agent 提示
 */
export interface ChannelAgentPrompt {
  messageToolHints: () => string[];
}

/**
 * 群组功能
 */
export interface ChannelGroups {
  resolveToolPolicy: (params: { account: unknown; groupId: string }) => ToolPolicy | undefined;
}

/**
 * 提及功能
 */
export interface ChannelMentions {
  stripPatterns: () => RegExp[];
}

/**
 * 重载配置
 */
export interface ChannelReload {
  configPrefixes: string[];
}

/**
 * 配置 Schema
 */
export interface ChannelConfigSchema {
  schema: unknown;
}

/**
 * 配置管理
 */
export interface ChannelConfig<TAccount> {
  listAccountIds: (cfg: ClawdbotConfig) => string[];
  resolveAccount: (cfg: ClawdbotConfig, accountId: string) => TAccount;
  defaultAccountId: (cfg: ClawdbotConfig) => string;
  setAccountEnabled: (params: { cfg: ClawdbotConfig; accountId: string; enabled: boolean }) => ClawdbotConfig;
  deleteAccount: (params: { cfg: ClawdbotConfig; accountId: string }) => ClawdbotConfig;
  isConfigured: (account: TAccount) => boolean;
  describeAccount: (account: TAccount) => unknown;
  resolveAllowFrom: (params: { cfg: ClawdbotConfig; accountId: string }) => string[];
  formatAllowFrom: (params: { allowFrom: (string | number)[] }) => string[];
}

/**
 * 安全功能
 */
export interface ChannelSecurity<TAccount> {
  collectWarnings: (params: { cfg: ClawdbotConfig; accountId: string }) => string[];
}

/**
 * 设置功能
 */
export interface ChannelSetup {
  resolveAccountId: () => string;
  applyAccountConfig: (params: { cfg: ClawdbotConfig; accountId: string }) => ClawdbotConfig;
}

/**
 * 入引导适配器
 */
export interface ChannelOnboardingAdapter {
  channel: string;
  getStatus: (params: { cfg: ClawdbotConfig }) => Promise<{
    channel: string;
    configured: boolean;
    statusLines: string[];
    selectionHint: string;
    quickstartScore: number;
  }>;
  configure: (params: { cfg: ClawdbotConfig; prompter: unknown }) => Promise<{
    cfg: ClawdbotConfig;
    accountId: string;
  }>;
  dmPolicy?: {
    label: string;
    channel: string;
    policyKey: string;
    allowFromKey: string;
    getCurrent: (cfg: ClawdbotConfig) => string;
    setPolicy: (cfg: ClawdbotConfig, policy: string) => ClawdbotConfig;
    promptAllowFrom: (params: { cfg: ClawdbotConfig; prompter: unknown }) => Promise<ClawdbotConfig>;
  };
  disable: (cfg: ClawdbotConfig) => ClawdbotConfig;
}

/**
 * 消息功能
 */
export interface ChannelMessaging {
  normalizeTarget: (raw: string) => string | undefined;
  targetResolver: {
    looksLikeId: (raw: string) => boolean;
    hint: string;
  };
}

/**
 * 目录功能
 */
export interface ChannelDirectory {
  self: () => Promise<unknown>;
  listPeers: (params: { cfg: ClawdbotConfig; query?: string; limit?: number; accountId?: string }) => Promise<unknown[]>;
  listGroups: (params: { cfg: ClawdbotConfig; query?: string; limit?: number; accountId?: string }) => Promise<unknown[]>;
  listPeersLive: (params: { cfg: ClawdbotConfig; query?: string; limit?: number; accountId?: string }) => Promise<unknown[]>;
  listGroupsLive: (params: { cfg: ClawdbotConfig; query?: string; limit?: number; accountId?: string }) => Promise<unknown[]>;
}

/**
 * 发送结果
 */
export interface SendResult {
  channel: string;
  messageId: string;
  conversationId: string;
}

/**
 * 出站消息功能
 */
export interface ChannelOutbound {
  deliveryMode: DeliveryMode;
  chunker: (text: string, limit: number) => string[];
  chunkerMode: "markdown" | "text";
  textChunkLimit: number;
  sendText: (params: {
    cfg: ClawdbotConfig;
    to: string;
    text: string;
    accountId?: string;
    replyToId?: string;
    threadId?: string;
  }) => Promise<SendResult>;
  sendMedia: (params: {
    cfg: ClawdbotConfig;
    to: string;
    text?: string;
    mediaUrl?: string;
    accountId?: string;
    mediaLocalRoots?: string[];
    replyToId?: string;
    threadId?: string;
  }) => Promise<SendResult>;
}

/**
 * 探测结果
 */
export interface BaseProbeResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

/**
 * 运行时状态
 */
export interface ChannelRuntimeState {
  running: boolean;
  lastStartAt: string | null;
  lastStopAt: string | null;
  lastError: string | null;
  port: number | null;
  [key: string]: unknown;
}

/**
 * 状态功能
 */
export interface ChannelStatus<TAccount> {
  defaultRuntime: ChannelRuntimeState;
  buildChannelSummary: (params: { snapshot: unknown }) => unknown;
  probeAccount: (params: { account: TAccount }) => Promise<BaseProbeResult<unknown>>;
  buildAccountSnapshot: (params: { account: TAccount; runtime?: ChannelRuntimeState; probe?: BaseProbeResult<unknown> }) => unknown;
}

/**
 * 网关启动上下文
 */
export interface GatewayStartContext {
  cfg: ClawdbotConfig;
  accountId: string;
  runtime: ChannelRuntimeState;
  abortSignal: AbortSignal;
  setStatus: (params: { accountId: string; port: number | null }) => void;
  log?: {
    info: (message: string) => void;
    error: (message: string) => void;
    warn: (message: string) => void;
  };
}

/**
 * 网关功能
 */
export interface ChannelGateway {
  startAccount: (ctx: GatewayStartContext) => Promise<void>;
}

/**
 * 通道插件接口
 */
export interface ChannelPlugin<TAccount> {
  id: string;
  meta: ChannelMeta;
  pairing?: ChannelPairing;
  capabilities?: ChannelCapabilities;
  agentPrompt?: ChannelAgentPrompt;
  groups?: ChannelGroups;
  mentions?: ChannelMentions;
  reload?: ChannelReload;
  configSchema?: ChannelConfigSchema;
  config: ChannelConfig<TAccount>;
  security?: ChannelSecurity<TAccount>;
  setup?: ChannelSetup;
  onboarding?: ChannelOnboardingAdapter;
  messaging?: ChannelMessaging;
  directory?: ChannelDirectory;
  outbound?: ChannelOutbound;
  status?: ChannelStatus<TAccount>;
  gateway?: ChannelGateway;
  streaming?: unknown;
  actions?: unknown;
  resolver?: unknown;
  threading?: unknown;
}

/**
 * 插件 API
 */
export interface PluginApi {
  registerChannel: (opts: { plugin: ChannelPlugin<unknown> }) => void;
  runtime: {
    env: Record<string, string | undefined>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ============================================================================
// 常量
// ============================================================================

/**
 * 默认账号 ID
 */
export const DEFAULT_ACCOUNT_ID = "default" as const;

// ============================================================================
// 运行时类型
// ============================================================================

/**
 * 运行时环境
 */
export interface RuntimeEnv {
  env: Record<string, string | undefined>;
  [key: string]: unknown;
}

/**
 * 历史记录条目
 */
export interface HistoryEntry {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
  [key: string]: unknown;
}

/**
 * 插件运行时
 */
export interface PluginRuntime {
  env: RuntimeEnv;
  [key: string]: unknown;
}

// ============================================================================
// 向导类型
// ============================================================================

/**
 * 向导提示器
 */
export interface WizardPrompter {
  note: (message: string, title?: string) => Promise<void>;
  text: (params: {
    message: string;
    placeholder?: string;
    initialValue?: string;
    validate?: (value: unknown) => string | undefined;
  }) => Promise<string>;
  select: <T>(params: {
    message: string;
    options: Array<{ value: T; label: string }>;
    initialValue?: T;
  }) => Promise<T>;
  confirm: (params: {
    message: string;
    initialValue?: boolean;
  }) => Promise<boolean>;
  [key: string]: unknown;
}

/**
 * DM 策略入引导
 */
export interface ChannelOnboardingDmPolicy {
  label: string;
  channel: string;
  policyKey: string;
  allowFromKey: string;
  getCurrent: (cfg: ClawdbotConfig) => string;
  setPolicy: (cfg: ClawdbotConfig, policy: string) => ClawdbotConfig;
  promptAllowFrom: (params: { cfg: ClawdbotConfig; prompter: WizardPrompter }) => Promise<ClawdbotConfig>;
}
