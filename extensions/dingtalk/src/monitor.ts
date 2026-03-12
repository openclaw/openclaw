import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk/dingtalk";
import { listEnabledDingtalkAccounts, resolveDingtalkAccount } from "./accounts.js";
import { monitorSingleAccount } from "./monitor.account.js";

export type MonitorDingtalkOpts = {
  config?: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
};

/**
 * 启动钉钉消息监控 / Start DingTalk message monitor
 * 支持单账号或多账号模式 / Supports single-account or multi-account mode
 */
export async function monitorDingtalkProvider(opts: MonitorDingtalkOpts = {}): Promise<void> {
  const cfg = opts.config;
  if (!cfg) {
    throw new Error("Config is required for DingTalk monitor");
  }

  const log = opts.runtime?.log ?? console.log;

  // 单账号模式 / Single-account mode
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
    });
  }

  // 多账号模式 / Multi-account mode
  const accounts = listEnabledDingtalkAccounts(cfg);
  if (accounts.length === 0) {
    throw new Error("No enabled DingTalk accounts configured");
  }

  log(
    `dingtalk: starting ${accounts.length} account(s): ${accounts.map((a) => a.accountId).join(", ")}`,
  );

  const monitorPromises: Promise<void>[] = [];
  for (const account of accounts) {
    if (opts.abortSignal?.aborted) {
      log("dingtalk: abort signal received during startup; stopping");
      break;
    }

    monitorPromises.push(
      monitorSingleAccount({
        cfg,
        account,
        runtime: opts.runtime,
        abortSignal: opts.abortSignal,
      }),
    );
  }

  await Promise.all(monitorPromises);
}
