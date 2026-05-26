import { i as listChannelPlugins } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { n as DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS, r as evaluateChannelHealth, t as DEFAULT_CHANNEL_CONNECT_GRACE_MS } from "./channel-health-policy-D_eDwUBm.js";
//#region src/infra/channels-status-issues.ts
function resolveIssueAccountId(account) {
	return typeof account.accountId === "string" && account.accountId.trim() ? account.accountId : "default";
}
function collectGenericRuntimeStatusIssues(channel, accounts) {
	const now = Date.now();
	const issues = [];
	for (const account of accounts) {
		if (account.enabled === false || account.configured === false) continue;
		const accountId = resolveIssueAccountId(account);
		if (account.restartPending === true) {
			issues.push({
				channel,
				accountId,
				kind: "runtime",
				message: "Channel restart is pending; runtime status may be stale.",
				fix: "wait for restart to complete, then rerun channels status"
			});
			continue;
		}
		const health = evaluateChannelHealth(account, {
			channelId: channel,
			now,
			channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
			staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS
		});
		if (health.healthy) continue;
		if (health.reason === "disconnected") {
			issues.push({
				channel,
				accountId,
				kind: "runtime",
				message: "Channel reports running, but the runtime is disconnected.",
				fix: "restart the channel or gateway"
			});
			continue;
		}
		if (health.reason === "stale-socket") {
			issues.push({
				channel,
				accountId,
				kind: "runtime",
				message: "Channel reports connected, but transport activity is stale; inbound delivery may be broken.",
				fix: "restart the channel or gateway"
			});
			continue;
		}
		if (health.reason === "stuck") issues.push({
			channel,
			accountId,
			kind: "runtime",
			message: "Channel runtime appears stuck with stale run activity.",
			fix: "restart the channel or gateway"
		});
	}
	return issues;
}
function collectChannelStatusIssues(payload) {
	const issues = [];
	const accountsByChannel = payload.channelAccounts;
	for (const plugin of listChannelPlugins()) {
		const raw = accountsByChannel?.[plugin.id];
		if (!Array.isArray(raw)) continue;
		const accounts = raw;
		issues.push(...collectGenericRuntimeStatusIssues(plugin.id, accounts));
		const collect = plugin.status?.collectStatusIssues;
		if (collect) issues.push(...collect(accounts));
	}
	return issues;
}
//#endregion
export { collectChannelStatusIssues as t };
