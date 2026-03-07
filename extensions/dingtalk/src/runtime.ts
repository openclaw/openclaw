/**
 * 钉钉插件运行时管理
 *
 * 提供对 Moltbot 核心运行时的访问。
 *
 * 重要：这个模块存储完整的 PluginRuntime，包含 core.channel.routing、
 * core.channel.reply 等 API，用于消息分发到 Agent。
 *
 * 使用方式：
 * 1. 插件注册时调用 setDingtalkRuntime(runtime) 设置完整 runtime
 * 2. 消息处理时调用 getDingtalkRuntime() 获取 runtime 进行分发
 */

/**
 * Moltbot 插件运行时接口
 *
 * 包含 Moltbot 核心 API，用于：
 * - 路由解析 (channel.routing.resolveAgentRoute)
 * - 消息分发 (channel.reply.dispatchReplyFromConfig)
 * - 系统事件 (system.enqueueSystemEvent)
 */
export interface PluginRuntime {
  /** 日志函数 */
  log?: (msg: string) => void;
  /** 错误日志函数 */
  error?: (msg: string) => void;
  /** Moltbot 核心 API */
  channel?: {
    routing?: {
      resolveAgentRoute?: (params: {
        cfg: unknown;
        channel: string;
        peer: { kind: string; id: string };
      }) => { sessionKey: string; accountId: string; agentId?: string };
    };
    reply?: {
      dispatchReplyFromConfig?: (params: {
        ctx: unknown;
        cfg: unknown;
        dispatcher?: unknown;
        replyOptions?: unknown;
      }) => Promise<{ queuedFinal: boolean; counts: { final: number } }>;
      dispatchReplyWithBufferedBlockDispatcher?: (params: {
        ctx: unknown;
        cfg: unknown;
        dispatcherOptions: {
          deliver: (payload: unknown, info?: { kind?: string }) => Promise<void>;
          onError?: (err: unknown, info: { kind: string }) => void;
          onSkip?: (payload: unknown, info: { kind: string; reason: string }) => void;
          onReplyStart?: () => Promise<void> | void;
          humanDelay?: unknown;
        };
        replyOptions?: unknown;
      }) => Promise<unknown>;
      finalizeInboundContext?: (ctx: unknown) => unknown;
      createReplyDispatcher?: (params: unknown) => unknown;
      createReplyDispatcherWithTyping?: (params: unknown) => {
        dispatcher: unknown;
        replyOptions?: unknown;
        markDispatchIdle?: () => void;
      };
      resolveHumanDelayConfig?: (cfg: unknown, agentId?: string) => unknown;
      resolveEnvelopeFormatOptions?: (cfg: unknown) => unknown;
      formatAgentEnvelope?: (params: unknown) => string;
    };
    text?: {
      resolveTextChunkLimit?: (params: {
        cfg: unknown;
        channel: string;
        defaultLimit?: number;
      }) => number;
      resolveChunkMode?: (cfg: unknown, channel: string) => unknown;
      resolveMarkdownTableMode?: (params: { cfg: unknown; channel: string }) => unknown;
      convertMarkdownTables?: (text: string, mode: unknown) => string;
      chunkTextWithMode?: (text: string, limit: number, mode: unknown) => string[];
      /** Markdown 感知的文本分块，不会在代码块中间断开 */
      chunkMarkdownText?: (text: string, limit: number) => string[];
    };
  };
  system?: {
    enqueueSystemEvent?: (message: string, options?: unknown) => void;
  };
  [key: string]: unknown;
}

/** 全局 runtime 实例 */
let runtime: PluginRuntime | null = null;

/**
 * 设置钉钉插件运行时
 *
 * 在插件注册时由 Moltbot 调用，传入完整的 PluginRuntime。
 *
 * @param next Moltbot 插件运行时实例（完整版，包含 core API）
 */
export function setDingtalkRuntime(next: PluginRuntime): void {
  runtime = next;
}

/**
 * 获取钉钉插件运行时
 *
 * 在消息处理时调用，获取完整的 runtime 用于分发消息到 Agent。
 *
 * @returns Moltbot 插件运行时实例
 * @throws Error 如果运行时未初始化（插件未正确注册）
 */
export function getDingtalkRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error(
      "Dingtalk runtime not initialized. Make sure the plugin is properly registered with Moltbot.",
    );
  }
  return runtime;
}

/**
 * 检查运行时是否已初始化
 *
 * 用于诊断和测试
 *
 * @returns 是否已设置 runtime
 */
export function isDingtalkRuntimeInitialized(): boolean {
  return runtime !== null;
}

/**
 * 清除运行时（仅用于测试）
 */
export function clearDingtalkRuntime(): void {
  runtime = null;
}
