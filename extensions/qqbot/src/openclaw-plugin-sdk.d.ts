/**
 * OpenClaw Plugin SDK 类型声明
 *
 * 此文件为 openclaw/plugin-sdk 模块提供 TypeScript 类型声明
 * 仅包含本项目实际使用的类型和函数
 */

declare module "openclaw/plugin-sdk" {
  // ============ 配置类型 ============

  /**
   * OpenClaw 主配置对象
   */
  export interface OpenClawConfig {
    /** 频道配置 */
    channels?: {
      qqbot?: unknown;
      telegram?: unknown;
      discord?: unknown;
      slack?: unknown;
      whatsapp?: unknown;
      [key: string]: unknown;
    };
    /** 其他配置字段 */
    [key: string]: unknown;
  }

  // ============ 插件运行时 ============

  /**
   * Channel Activity 接口
   */
  export interface ChannelActivity {
    record?: (...args: unknown[]) => void;
    recordActivity?: (key: string, data?: unknown) => void;
    [key: string]: unknown;
  }

  /**
   * Channel Routing 接口
   */
  export interface ChannelRouting {
    resolveAgentRoute?: (...args: unknown[]) => unknown;
    resolveSenderAndSession?: (options: unknown) => unknown;
    [key: string]: unknown;
  }

  /**
   * Channel Reply 接口
   */
  export interface ChannelReply {
    handleIncomingMessage?: (options: unknown) => Promise<unknown>;
    formatInboundEnvelope?: (...args: unknown[]) => unknown;
    finalizeInboundContext?: (...args: unknown[]) => unknown;
    resolveEnvelopeFormatOptions?: (...args: unknown[]) => unknown;
    handleAutoReply?: (...args: unknown[]) => Promise<unknown>;
    [key: string]: unknown;
  }

  /**
   * Channel 接口（用于 PluginRuntime）
   * 注意：这是一个宽松的类型定义，实际 SDK 中的类型更复杂
   */
  export interface ChannelInterface {
    recordInboundSession?: (options: unknown) => void;
    handleIncomingMessage?: (options: unknown) => Promise<unknown>;
    activity?: ChannelActivity;
    routing?: ChannelRouting;
    reply?: ChannelReply;
    [key: string]: unknown;
  }

  /**
   * 插件运行时接口
   * 注意：channel 属性设为 any 是因为 SDK 内部类型非常复杂，
   * 且会随 SDK 版本变化。实际使用时 SDK 会提供正确的运行时类型。
   */
  export interface PluginRuntime {
    /** 获取当前配置 */
    getConfig(): OpenClawConfig;
    /** 更新配置 */
    setConfig(config: OpenClawConfig): void;
    /** 获取数据目录路径 */
    getDataDir(): string;
    /** Channel 接口 - 使用 any 类型以兼容 SDK 内部复杂类型 */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    channel?: any;
    /** 日志函数 */
    log: {
      info: (message: string, ...args: unknown[]) => void;
      warn: (message: string, ...args: unknown[]) => void;
      error: (message: string, ...args: unknown[]) => void;
      debug: (message: string, ...args: unknown[]) => void;
    };
    /** 其他运行时方法 */
    [key: string]: unknown;
  }

  // ============ 插件 API ============

  /**
   * OpenClaw 插件 API
   */
  export interface OpenClawPluginApi {
    /** 运行时实例 */
    runtime: PluginRuntime;
    /** 注册频道 */
    registerChannel<TAccount = unknown>(options: { plugin: ChannelPlugin<TAccount> }): void;
    /** 其他 API 方法 */
    [key: string]: unknown;
  }

  // ============ 插件配置 Schema ============

  /**
   * 空的插件配置 Schema
   */
  export function emptyPluginConfigSchema(): unknown;

  // ============ 频道插件 ============

  /**
   * 频道插件 Meta 信息
   */
  export interface ChannelPluginMeta {
    id: string;
    label: string;
    selectionLabel?: string;
    docsPath?: string;
    blurb?: string;
    order?: number;
    [key: string]: unknown;
  }

  /**
   * 频道插件能力配置
   */
  export interface ChannelPluginCapabilities {
    chatTypes?: ("direct" | "group" | "channel")[];
    media?: boolean;
    reactions?: boolean;
    threads?: boolean;
    blockStreaming?: boolean;
    [key: string]: unknown;
  }

  /**
   * 账户描述
   */
  export interface AccountDescription {
    accountId: string;
    name?: string;
    enabled: boolean;
    configured: boolean;
    tokenSource?: string;
    [key: string]: unknown;
  }

  /**
   * 频道插件配置接口（泛型）
   */
  export interface ChannelPluginConfig<TAccount> {
    listAccountIds: (cfg: OpenClawConfig) => string[];
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => TAccount;
    defaultAccountId: (cfg: OpenClawConfig) => string;
    setAccountEnabled?: (ctx: {
      cfg: OpenClawConfig;
      accountId: string;
      enabled: boolean;
    }) => OpenClawConfig;
    deleteAccount?: (ctx: { cfg: OpenClawConfig; accountId: string }) => OpenClawConfig;
    isConfigured?: (account: TAccount | undefined) => boolean;
    describeAccount?: (account: TAccount | undefined) => AccountDescription;
    [key: string]: unknown;
  }

  /**
   * Setup 输入参数（扩展类型以支持 QQBot 特定字段）
   */
  export interface SetupInput {
    token?: string;
    tokenFile?: string;
    useEnv?: boolean;
    name?: string;
    imageServerBaseUrl?: string;
    [key: string]: unknown;
  }

  /**
   * 频道插件 Setup 接口
   */
  export interface ChannelPluginSetup {
    resolveAccountId?: (ctx: { accountId?: string }) => string;
    applyAccountName?: (ctx: {
      cfg: OpenClawConfig;
      accountId: string;
      name: string;
    }) => OpenClawConfig;
    validateInput?: (ctx: { input: SetupInput }) => string | null;
    applyConfig?: (ctx: {
      cfg: OpenClawConfig;
      accountId: string;
      input: SetupInput;
    }) => OpenClawConfig;
    applyAccountConfig?: (ctx: {
      cfg: OpenClawConfig;
      accountId: string;
      input: SetupInput;
    }) => OpenClawConfig;
    [key: string]: unknown;
  }

  /**
   * 消息目标解析结果
   */
  export interface NormalizeTargetResult {
    ok: boolean;
    to?: string;
    error?: string;
  }

  /**
   * 目标解析器
   */
  export interface TargetResolver {
    looksLikeId?: (id: string) => boolean;
    hint?: string;
  }

  /**
   * 频道插件 Messaging 接口
   */
  export interface ChannelPluginMessaging {
    normalizeTarget?: (target: string) => NormalizeTargetResult;
    targetResolver?: TargetResolver;
    [key: string]: unknown;
  }

  /**
   * 发送文本结果
   */
  export interface SendTextResult {
    channel: string;
    messageId?: string;
    error?: Error;
  }

  /**
   * 发送文本上下文
   */
  export interface SendTextContext {
    to: string;
    text: string;
    accountId?: string;
    replyToId?: string;
    cfg: OpenClawConfig;
  }

  /**
   * 发送媒体上下文
   */
  export interface SendMediaContext {
    to: string;
    text?: string;
    mediaUrl?: string;
    accountId?: string;
    replyToId?: string;
    cfg: OpenClawConfig;
  }

  /**
   * 频道插件 Outbound 接口
   */
  export interface ChannelPluginOutbound {
    deliveryMode?: "direct" | "queued";
    chunker?: (text: string, limit: number) => string[];
    chunkerMode?: "markdown" | "plain";
    textChunkLimit?: number;
    sendText?: (ctx: SendTextContext) => Promise<SendTextResult>;
    sendMedia?: (ctx: SendMediaContext) => Promise<SendTextResult>;
    [key: string]: unknown;
  }

  /**
   * 账户状态
   */
  export interface AccountStatus {
    running?: boolean;
    connected?: boolean;
    lastConnectedAt?: number;
    lastError?: string;
    [key: string]: unknown;
  }

  /**
   * Gateway 启动上下文
   */
  export interface GatewayStartContext<TAccount = unknown> {
    account: TAccount;
    accountId: string;
    abortSignal: AbortSignal;
    cfg: OpenClawConfig;
    log?: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
      debug: (msg: string) => void;
    };
    getStatus: () => AccountStatus;
    setStatus: (status: AccountStatus) => void;
    [key: string]: unknown;
  }

  /**
   * Gateway 登出上下文
   */
  export interface GatewayLogoutContext {
    accountId: string;
    cfg: OpenClawConfig;
    [key: string]: unknown;
  }

  /**
   * Gateway 登出结果
   */
  export interface GatewayLogoutResult {
    ok: boolean;
    cleared: boolean;
    updatedConfig?: OpenClawConfig;
    error?: string;
  }

  /**
   * 频道插件 Gateway 接口
   */
  export interface ChannelPluginGateway<TAccount = unknown> {
    startAccount?: (ctx: GatewayStartContext<TAccount>) => Promise<void>;
    logoutAccount?: (ctx: GatewayLogoutContext) => Promise<GatewayLogoutResult>;
    [key: string]: unknown;
  }

  /**
   * 频道插件接口（泛型）
   */
  export interface ChannelPlugin<TAccount = unknown> {
    /** 插件 ID */
    id: string;
    /** 插件 Meta 信息 */
    meta?: ChannelPluginMeta;
    /** 插件版本 */
    version?: string;
    /** 插件能力 */
    capabilities?: ChannelPluginCapabilities;
    /** 重载配置 */
    reload?: { configPrefixes?: string[] };
    /** Onboarding 适配器 */
    onboarding?: ChannelOnboardingAdapter;
    /** 配置方法 */
    config?: ChannelPluginConfig<TAccount>;
    /** Setup 方法 */
    setup?: ChannelPluginSetup;
    /** Messaging 配置 */
    messaging?: ChannelPluginMessaging;
    /** Outbound 配置 */
    outbound?: ChannelPluginOutbound;
    /** Gateway 配置 */
    gateway?: ChannelPluginGateway<TAccount>;
    /** 启动函数 */
    start?: (runtime: PluginRuntime) => void | Promise<void>;
    /** 停止函数 */
    stop?: () => void | Promise<void>;
    /** deliver 函数 - 发送消息 */
    deliver?: (ctx: unknown) => Promise<unknown>;
    /** 其他插件属性 */
    [key: string]: unknown;
  }

  // ============ Onboarding 类型 ============

  /**
   * Onboarding 状态结果
   */
  export interface ChannelOnboardingStatus {
    channel?: string;
    configured: boolean;
    statusLines?: string[];
    selectionHint?: string;
    quickstartScore?: number;
    [key: string]: unknown;
  }

  /**
   * Onboarding 状态字符串枚举（部分 API 使用）
   */
  export type ChannelOnboardingStatusString =
    | "not-configured"
    | "configured"
    | "connected"
    | "error";

  /**
   * Onboarding 状态上下文
   */
  export interface ChannelOnboardingStatusContext {
    /** 当前配置 */
    config: OpenClawConfig;
    /** 账户 ID */
    accountId?: string;
    /** Prompter */
    prompter?: unknown;
    /** 其他上下文 */
    [key: string]: unknown;
  }

  /**
   * Onboarding 配置上下文
   */
  export interface ChannelOnboardingConfigureContext {
    /** 当前配置 */
    config: OpenClawConfig;
    /** 账户 ID */
    accountId?: string;
    /** 输入参数 */
    input?: Record<string, unknown>;
    /** Prompter */
    prompter?: unknown;
    /** 其他上下文 */
    [key: string]: unknown;
  }

  /**
   * Onboarding 结果
   */
  export interface ChannelOnboardingResult {
    /** 是否成功 */
    success: boolean;
    /** 更新后的配置 */
    config?: OpenClawConfig;
    /** 错误信息 */
    error?: string;
    /** 消息 */
    message?: string;
    /** 其他结果字段 */
    [key: string]: unknown;
  }

  /**
   * Onboarding 适配器接口
   */
  export interface ChannelOnboardingAdapter {
    /** 获取状态 */
    getStatus?: (
      ctx: ChannelOnboardingStatusContext,
    ) => ChannelOnboardingStatus | Promise<ChannelOnboardingStatus>;
    /** 配置函数 */
    configure?: (
      ctx: ChannelOnboardingConfigureContext,
    ) => ChannelOnboardingResult | Promise<ChannelOnboardingResult>;
    /** 其他适配器方法 */
    [key: string]: unknown;
  }

  // ============ 配置辅助函数 ============

  /**
   * 将账户名称应用到频道配置段
   */
  export function applyAccountNameToChannelSection(ctx: {
    cfg: OpenClawConfig;
    channelKey: string;
    accountId: string;
    name: string;
  }): OpenClawConfig;

  /**
   * 从配置段删除账户
   */
  export function deleteAccountFromConfigSection(ctx: {
    cfg: OpenClawConfig;
    sectionKey: string;
    accountId: string;
    clearBaseFields?: string[];
  }): OpenClawConfig;

  /**
   * 设置账户启用状态
   */
  export function setAccountEnabledInConfigSection(ctx: {
    cfg: OpenClawConfig;
    sectionKey: string;
    accountId: string;
    enabled: boolean;
    allowTopLevel?: boolean;
  }): OpenClawConfig;

  // ============ 其他导出 ============

  /** 默认账户 ID 常量 */
  export const DEFAULT_ACCOUNT_ID: string;

  /** 规范化账户 ID */
  export function normalizeAccountId(accountId: string | undefined | null): string;
}
