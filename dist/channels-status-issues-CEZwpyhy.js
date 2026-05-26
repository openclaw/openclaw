import { i as listChannelPlugins } from "./registry-BdfZSqhE2.js";
import "./plugins-YTdL-Pji.js";
//#region src/infra/channels-status-issues.ts
function collectChannelStatusIssues(payload) {
	const issues = [];
	const accountsByChannel = payload.channelAccounts;
	for (const plugin of listChannelPlugins()) {
		const collect = plugin.status?.collectStatusIssues;
		if (!collect) continue;
		const raw = accountsByChannel?.[plugin.id];
		if (!Array.isArray(raw)) continue;
		issues.push(...collect(raw));
	}
	return issues;
}
//#endregion
export { collectChannelStatusIssues as t };
