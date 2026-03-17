import { listEnabledFeishuAccounts, resolveFeishuAccount } from "./accounts.js";
import {
  monitorSingleAccount,
  resolveReactionSyntheticEvent
} from "./monitor.account.js";
import { fetchBotIdentityForMonitor } from "./monitor.startup.js";
import {
  clearFeishuWebhookRateLimitStateForTest,
  getFeishuWebhookRateLimitStateSizeForTest,
  isWebhookRateLimitedForTest,
  stopFeishuMonitorState
} from "./monitor.state.js";
async function monitorFeishuProvider(opts = {}) {
  const cfg = opts.config;
  if (!cfg) {
    throw new Error("Config is required for Feishu monitor");
  }
  const log = opts.runtime?.log ?? console.log;
  if (opts.accountId) {
    const account = resolveFeishuAccount({ cfg, accountId: opts.accountId });
    if (!account.enabled || !account.configured) {
      throw new Error(`Feishu account "${opts.accountId}" not configured or disabled`);
    }
    return monitorSingleAccount({
      cfg,
      account,
      runtime: opts.runtime,
      abortSignal: opts.abortSignal
    });
  }
  const accounts = listEnabledFeishuAccounts(cfg);
  if (accounts.length === 0) {
    throw new Error("No enabled Feishu accounts configured");
  }
  log(
    `feishu: starting ${accounts.length} account(s): ${accounts.map((a) => a.accountId).join(", ")}`
  );
  const monitorPromises = [];
  for (const account of accounts) {
    if (opts.abortSignal?.aborted) {
      log("feishu: abort signal received during startup preflight; stopping startup");
      break;
    }
    const { botOpenId, botName } = await fetchBotIdentityForMonitor(account, {
      runtime: opts.runtime,
      abortSignal: opts.abortSignal
    });
    if (opts.abortSignal?.aborted) {
      log("feishu: abort signal received during startup preflight; stopping startup");
      break;
    }
    monitorPromises.push(
      monitorSingleAccount({
        cfg,
        account,
        runtime: opts.runtime,
        abortSignal: opts.abortSignal,
        botOpenIdSource: { kind: "prefetched", botOpenId, botName }
      })
    );
  }
  await Promise.all(monitorPromises);
}
function stopFeishuMonitor(accountId) {
  stopFeishuMonitorState(accountId);
}
export {
  clearFeishuWebhookRateLimitStateForTest,
  getFeishuWebhookRateLimitStateSizeForTest,
  isWebhookRateLimitedForTest,
  monitorFeishuProvider,
  resolveReactionSyntheticEvent,
  stopFeishuMonitor
};
