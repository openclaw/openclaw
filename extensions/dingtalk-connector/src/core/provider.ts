/**
 * 钉钉消息流 Provider 入口
 *
 * 职责：
 * - 提供 monitorDingtalkProvider 函数作为钉钉消息流的统一入口
 * - 协调单账号和多账号监控场景
 * - 并行导入连接层和消息处理模块，避免循环依赖
 *
 * 主要功能：
 * - 根据 accountId 参数决定启动单账号或所有账号
 * - 验证账号配置状态
 * - 并行启动多个账号的消息流连接
 */
import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { createLogger } from "../utils/logger";
import * as monitorState from "./state";

// 只解构 monitorState 的导出
const {
  clearDingtalkWebhookRateLimitStateForTest,
  getDingtalkWebhookRateLimitStateSizeForTest,
  isWebhookRateLimitedForTest,
  stopDingtalkMonitorState,
} = monitorState;

export type MonitorDingtalkOpts = {
  config?: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
  /** 可选：连接状态变更时回调，用于更新 UI 显示的 Connected / Last inbound 字段 */
  onStatusChange?: (patch: Record<string, unknown>) => void;
};

export {
  clearDingtalkWebhookRateLimitStateForTest,
  getDingtalkWebhookRateLimitStateSizeForTest,
  isWebhookRateLimitedForTest,
} from "./state";

// 只导出类型，不 re-export 函数（避免循环依赖）
export type { DingtalkReactionCreatedEvent } from "./connection";

export async function monitorDingtalkProvider(opts: MonitorDingtalkOpts = {}): Promise<void> {
  const cfg = opts.config;
  if (!cfg) {
    throw new Error("Config is required for DingTalk monitor");
  }

  const log = createLogger(cfg.channels?.["dingtalk-connector"]?.debug ?? false);

  // 并行导入所有模块（无循环依赖，可以并行）
  const [accountsModule, monitorAccountModule, monitorSingleModule] = await Promise.all([
    import("../config/accounts"),
    import("./message-handler"),
    import("./connection"),
  ]);

  const { resolveDingtalkAccount, listEnabledDingtalkAccounts } = accountsModule;
  const { handleDingTalkMessage } = monitorAccountModule;
  const { monitorSingleAccount, resolveReactionSyntheticEvent } = monitorSingleModule;

  if (opts.accountId) {
    const account = resolveDingtalkAccount({ cfg, accountId: opts.accountId });
    if (!account.enabled || !account.configured) {
      throw new Error(`DingTalk account "${opts.accountId}" not configured or disabled`);
    }
    return monitorSingleAccount({
      cfg,
      account,
      runtime: opts.runtime,
      abortSignal: opts.abortSignal,
      messageHandler: handleDingTalkMessage,
      onStatusChange: opts.onStatusChange,
    });
  }

  const accounts = listEnabledDingtalkAccounts(cfg);
  if (accounts.length === 0) {
    throw new Error("No enabled DingTalk accounts configured");
  }

  log?.info?.(
    `dingtalk-connector: starting ${accounts.length} account(s): ${accounts.map((a) => a.accountId).join(", ")}`,
  );

  const monitorPromises: Promise<void>[] = [];
  for (const account of accounts) {
    if (opts.abortSignal?.aborted) {
      log?.info?.(
        "dingtalk-connector: abort signal received during startup preflight; stopping startup",
      );
      break;
    }

    monitorPromises.push(
      monitorSingleAccount({
        cfg,
        account,
        runtime: opts.runtime,
        abortSignal: opts.abortSignal,
        messageHandler: handleDingTalkMessage,
        onStatusChange: opts.onStatusChange,
      }),
    );
  }

  await Promise.all(monitorPromises);
}

export function stopDingtalkMonitor(accountId?: string): void {
  stopDingtalkMonitorState(accountId);
}
