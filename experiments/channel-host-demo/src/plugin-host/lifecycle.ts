/**
 * Channel Lifecycle — 启动/停止 channel，注入消息回调
 *
 * 对应 openclaw: src/gateway/server-channels.ts（精简版）
 *
 * 命名对齐：
 *   startChannelInternal()  ← server-channels.ts:149
 *   stopChannel()           ← server-channels.ts 对外接口
 *   stopAllChannels()       ← server-channels.ts 对外接口
 *
 * 简化说明（相比 openclaw 原版省略的部分）：
 *   - 自动重试/restart 逻辑
 *   - probe / status 深度检查
 *   - channelRuntimeEnvs（PluginRuntime["channel"]）注入
 *   - ManualStop / restartAttempts 状态
 */

import type {
  ChannelAccountSnapshot,
  ChannelPlugin,
  ChannelGatewayContext,
  DemoChannelGatewayContext,
  InboundMessage,
  PluginRuntime,
} from "../types.js";
// RuntimeEnv 内联定义（避免引用 openclaw 主工程运行时路径）
type RuntimeEnv = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
};

/** 消息处理回调类型（对应 openclaw 中 dispatchInboundReply 的角色） */
export type OnMessageCallback = (msg: InboundMessage) => Promise<void>;

/** 正在运行的 channel 账户实例（对应 server-channels.ts 中的 store.tasks） */
type RunningAccount = {
  channelId: string;
  accountId: string;
  abort: AbortController;
};

const runningAccounts: RunningAccount[] = [];

/**
 * 启动一个 channel 的所有账户
 * openclaw: startChannelInternal() (server-channels.ts:149)
 *
 * 流程（与原版对齐）：
 *   1. plugin.config.listAccountIds(cfg)   → 获取账户列表
 *   2. plugin.config.resolveAccount(cfg, id) → 解析账户对象
 *   3. plugin.config.isEnabled(account, cfg) → 检查是否启用（可选）
 *   4. plugin.config.isConfigured(account, cfg) → 检查是否已配置（可选）
 *   5. 构造 ChannelGatewayContext
 *   6. plugin.gateway.startAccount(ctx)    → 启动长连接，注入 onMessage 回调
 *
 * @param plugin         已注册的 ChannelPlugin
 * @param cfg            channel 配置（openclaw 中为 OpenClawConfig）
 *
 *   TODO: 将 cfg 类型从 Record<string,unknown> 改为 OpenClawConfig。
 *   在 VSCode 中实现时，此参数应接收真实的 OpenClawConfig 对象。
 *   当前用 Record<string,unknown> 是 demo 阶段的权宜之计，内部通过
 *   `cfg as ChannelGatewayContext["cfg"]` 转换给插件。
 *   迁移步骤：
 *     1. import type { OpenClawConfig } from '../../../src/config/types.openclaw.js'
 *     2. 将此参数类型改为 OpenClawConfig
 *     3. 在 index.ts 的 loadOpenClawConfig() 中将返回类型改为 OpenClawConfig
 *
 * @param onMessage      收到消息时的处理函数（openclaw 中对应 dispatchInboundReply）
 * @param channelRuntime PluginRuntime["channel"] stub，注入到 ctx.channelRuntime
 */
export async function startChannelInternal(
  plugin: ChannelPlugin,
  cfg: Record<string, unknown>, // TODO: → OpenClawConfig（见上方注释）
  onMessage: OnMessageCallback,
  channelRuntime?: PluginRuntime["channel"],
): Promise<void> {
  // 对应 server-channels.ts:155-158
  const startAccount = plugin.gateway?.startAccount;
  if (!startAccount) {
    console.warn(`[lifecycle] channel "${plugin.id}" has no gateway.startAccount, skipping`);
    return;
  }

  // 对应 server-channels.ts:163 plugin.config.listAccountIds(cfg)
  const accountIds = plugin.config.listAccountIds(cfg);
  if (accountIds.length === 0) {
    console.warn(`[lifecycle] channel "${plugin.id}" returned no accountIds, using ["default"]`);
    accountIds.push("default");
  }

  // 对应 server-channels.ts:168 Promise.all(accountIds.map(...))
  await Promise.all(
    accountIds.map(async (id) => {
      // 对应 server-channels.ts:173
      const account = plugin.config.resolveAccount(cfg, id);

      // 对应 server-channels.ts:174-186 isEnabled 检查
      const enabled = plugin.config.isEnabled ? plugin.config.isEnabled(account, cfg) : true;
      if (!enabled) {
        console.log(`[lifecycle] channel "${plugin.id}" account "${id}" is disabled, skipping`);
        return;
      }

      // 对应 server-channels.ts:189-197 isConfigured 检查
      if (plugin.config.isConfigured) {
        const configured = await plugin.config.isConfigured(account, cfg);
        if (!configured) {
          console.warn(
            `[lifecycle] channel "${plugin.id}" account "${id}" is not configured, skipping`,
          );
          return;
        }
      }

      const abort = new AbortController();
      runningAccounts.push({ channelId: plugin.id, accountId: id, abort });

      // 构造 ChannelGatewayContext（对应 server-channels.ts:227 startAccount({...})）
      // 使用 DemoChannelGatewayContext（官方类型扩展），加入 onMessage 字段
      const ctx: DemoChannelGatewayContext = {
        // OpenClawConfig 全字段可选，{} 完全合法
        cfg: cfg as ChannelGatewayContext["cfg"],
        accountId: id,
        account,
        abortSignal: abort.signal,

        // runtime: RuntimeEnv（官方必填字段）
        // demo 提供最小 stub，外部插件不应直接依赖此字段
        runtime: {
          log: (...args: unknown[]) => console.log(`[runtime:${plugin.id}:${id}]`, ...args),
          error: (...args: unknown[]) => console.error(`[runtime:${plugin.id}:${id}]`, ...args),
          exit: (code: number) => process.exit(code),
        } satisfies RuntimeEnv,

        // channelRuntime: PluginRuntime["channel"]（官方可选字段）
        // 注入来自 loader.ts 的 channel stub，供新式插件（通过 ctx.channelRuntime.*）使用
        channelRuntime,

        // 对应 server-channels.ts getStatus/setStatus
        getStatus: (): ChannelAccountSnapshot => ({
          accountId: id,
          enabled: true,
          configured: true,
          running: true,
        }),
        setStatus: (next: ChannelAccountSnapshot) => {
          console.debug(
            `[lifecycle] ${plugin.id}:${id} status →`,
            next.running ? "running" : "stopped",
          );
        },

        // log: ChannelLogSink（官方签名为 (msg: string) => void）
        log: {
          info: (msg: string) => console.log(`[channel:${plugin.id}:${id}]`, msg),
          warn: (msg: string) => console.warn(`[channel:${plugin.id}:${id}]`, msg),
          error: (msg: string) => console.error(`[channel:${plugin.id}:${id}]`, msg),
          debug: (msg: string) => console.debug(`[channel:${plugin.id}:${id}]`, msg),
        },

        // 消息回调注入（openclaw 对应 dispatchInboundReply，本工程简化为直接传入）
        onMessage,
      };

      console.log(`[lifecycle] starting channel "${plugin.id}" account "${id}"`);

      // 对应 server-channels.ts：startAccount 是长运行 async 函数，
      // 只有 abort 信号触发时才 resolve（见 qqbot/gateway.ts 末尾）。
      // 不能 await，而是 fire-and-forget，在 setStatus 回调里追踪状态。
      const runPromise = startAccount(ctx)
        .then(() => {
          console.log(`[lifecycle] channel "${plugin.id}" account "${id}" stopped`);
        })
        .catch((err: unknown) => {
          console.error(`[lifecycle] channel "${plugin.id}" account "${id}" failed:`, err);
        });

      // 将运行 promise 附加到 abort controller，方便后续追踪
      (abort as AbortController & { _runPromise?: Promise<void> })._runPromise = runPromise;
    }),
  );
}

/**
 * 停止指定 channel 的所有账户
 * openclaw: 对应 server-channels.ts 中 stopChannel 相关逻辑
 */
export function stopChannel(channelId: string): void {
  const entries = runningAccounts.filter((r) => r.channelId === channelId);
  for (const entry of entries) {
    entry.abort.abort();
    console.log(`[lifecycle] stopped channel "${channelId}" account "${entry.accountId}"`);
  }
  const toRemove = new Set(entries);
  runningAccounts.splice(
    0,
    runningAccounts.length,
    ...runningAccounts.filter((r) => !toRemove.has(r)),
  );
}

/**
 * 停止所有 channel（进程退出时调用）
 */
export function stopAllChannels(): void {
  for (const entry of runningAccounts) {
    entry.abort.abort();
  }
  runningAccounts.length = 0;
  console.log("[lifecycle] all channels stopped");
}
