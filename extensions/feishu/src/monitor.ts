import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { listEnabledFeishuAccounts, resolveFeishuRuntimeAccount } from "./accounts.js";
import {
  monitorSingleAccount,
  resolveReactionSyntheticEvent,
  type FeishuReactionCreatedEvent,
} from "./monitor.account.js";
import { fetchBotIdentityForMonitor } from "./monitor.startup.js";
import {
  clearFeishuWebhookRateLimitStateForTest,
  getFeishuWebhookRateLimitStateSizeForTest,
  isWebhookRateLimitedForTest,
  stopFeishuMonitorState,
} from "./monitor.state.js";

export type MonitorFeishuOpts = {
  config?: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
};

const FEISHU_STARTUP_HARD_TIMEOUT_MS = 3_000;

export {
  clearFeishuWebhookRateLimitStateForTest,
  getFeishuWebhookRateLimitStateSizeForTest,
  isWebhookRateLimitedForTest,
  resolveReactionSyntheticEvent,
};
export type { FeishuReactionCreatedEvent };

function logFeishuStartupProbeWarning(
  accountId: string,
  runtime: RuntimeEnv | undefined,
  detail: string,
): void {
  const log = runtime?.error ?? runtime?.log ?? console.warn;
  log(`feishu[${accountId}]: ${detail}`);
}

function startFeishuAccountMonitorInBackground(params: {
  cfg: ClawdbotConfig;
  account: ReturnType<typeof resolveFeishuRuntimeAccount>;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  botOpenIdSource?:
    | {
        kind: "prefetched";
        botOpenId?: string;
        botName?: string;
      }
    | undefined;
}): void {
  void monitorSingleAccount({
    cfg: params.cfg,
    account: params.account,
    runtime: params.runtime,
    abortSignal: params.abortSignal,
    botOpenIdSource: params.botOpenIdSource,
  }).catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    logFeishuStartupProbeWarning(
      params.account.accountId,
      params.runtime,
      `background runtime monitor failed: ${detail}`,
    );
  });
}

export async function monitorFeishuProvider(opts: MonitorFeishuOpts = {}): Promise<void> {
  const cfg = opts.config;
  if (!cfg) {
    throw new Error("Config is required for Feishu monitor");
  }

  const log = opts.runtime?.log ?? console.log;

  if (opts.accountId) {
    const account = resolveFeishuRuntimeAccount(
      { cfg, accountId: opts.accountId },
      { requireEventSecrets: true },
    );
    if (!account.enabled || !account.configured) {
      throw new Error(`Feishu account "${opts.accountId}" not configured or disabled`);
    }
    startFeishuAccountMonitorInBackground({
      cfg,
      account,
      runtime: opts.runtime,
      abortSignal: opts.abortSignal,
    });
    return;
  }

  const accounts = listEnabledFeishuAccounts(cfg);
  if (accounts.length === 0) {
    throw new Error("No enabled Feishu accounts configured");
  }

  log(
    `feishu: starting ${accounts.length} account(s): ${accounts.map((a) => a.accountId).join(", ")}`,
  );

  const startupProbeResults = await Promise.allSettled(
    accounts.map(async (account) => {
      const { botOpenId, botName } = await fetchBotIdentityForMonitor(account, {
        runtime: opts.runtime,
        abortSignal: opts.abortSignal,
        timeoutMs: FEISHU_STARTUP_HARD_TIMEOUT_MS,
      });
      return { account, botOpenId, botName };
    }),
  );

  for (const result of startupProbeResults) {
    if (opts.abortSignal?.aborted) {
      log("feishu: abort signal received during startup preflight; stopping startup");
      break;
    }

    if (result.status === "rejected") {
      logFeishuStartupProbeWarning(
        "unknown",
        opts.runtime,
        `startup probe failed: ${
          result.reason instanceof Error ? result.reason.message : String(result.reason)
        }`,
      );
      continue;
    }

    const { account, botOpenId, botName } = result.value;
    if (!botOpenId) {
      logFeishuStartupProbeWarning(
        account.accountId,
        opts.runtime,
        "startup probe degraded; continuing without prefetched bot identity",
      );
    }

    startFeishuAccountMonitorInBackground({
      cfg,
      account,
      runtime: opts.runtime,
      abortSignal: opts.abortSignal,
      botOpenIdSource: { kind: "prefetched", botOpenId, botName },
    });
  }
}

export function stopFeishuMonitor(accountId?: string): void {
  stopFeishuMonitorState(accountId);
}
