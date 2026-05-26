import { l as resolveFeishuRuntimeAccount, r as listEnabledFeishuAccounts } from "./accounts-Djfj3q-S.js";
import { l as fetchBotIdentityForMonitor } from "./monitor.state-e0QxMMNC.js";
//#region extensions/feishu/src/monitor.ts
let monitorAccountRuntimePromise;
async function loadMonitorAccountRuntime() {
	monitorAccountRuntimePromise ??= import("./monitor.account-BB6WFk7p.js");
	return await monitorAccountRuntimePromise;
}
async function monitorFeishuProvider(opts = {}) {
	const cfg = opts.config;
	if (!cfg) throw new Error("Config is required for Feishu monitor");
	const log = opts.runtime?.log ?? console.log;
	if (opts.accountId) {
		const account = resolveFeishuRuntimeAccount({
			cfg,
			accountId: opts.accountId
		}, { requireEventSecrets: true });
		if (!account.enabled || !account.configured) throw new Error(`Feishu account "${opts.accountId}" not configured or disabled`);
		const { monitorSingleAccount } = await loadMonitorAccountRuntime();
		return monitorSingleAccount({
			cfg,
			account,
			runtime: opts.runtime,
			abortSignal: opts.abortSignal
		});
	}
	const accounts = listEnabledFeishuAccounts(cfg);
	if (accounts.length === 0) throw new Error("No enabled Feishu accounts configured");
	log(`feishu: starting ${accounts.length} account(s): ${accounts.map((a) => a.accountId).join(", ")}`);
	const { monitorSingleAccount } = await loadMonitorAccountRuntime();
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
		monitorPromises.push(monitorSingleAccount({
			cfg,
			account,
			runtime: opts.runtime,
			abortSignal: opts.abortSignal,
			botOpenIdSource: {
				kind: "prefetched",
				botOpenId,
				botName
			}
		}));
	}
	await Promise.all(monitorPromises);
}
//#endregion
export { monitorFeishuProvider };
