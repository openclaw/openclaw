import { s as buildCopilotIdeHeaders } from "./copilot-dynamic-headers-CVy4X1Kj.js";
import "./provider-auth-BtRKd5us.js";
import { n as PROVIDER_LABELS, r as clampPercent } from "./provider-usage.shared-Dk5t9Xpy.js";
import { c as fetchJson, s as buildUsageHttpErrorSnapshot } from "./provider-usage-OfXY2nM7.js";
//#region extensions/github-copilot/usage.ts
async function fetchCopilotUsage(token, timeoutMs, fetchFn) {
	const res = await fetchJson("https://api.github.com/copilot_internal/user", { headers: {
		Authorization: `token ${token}`,
		...buildCopilotIdeHeaders({ includeApiVersion: true })
	} }, timeoutMs, fetchFn);
	if (!res.ok) return buildUsageHttpErrorSnapshot({
		provider: "github-copilot",
		status: res.status
	});
	const data = await res.json();
	const windows = [];
	if (data.quota_snapshots?.premium_interactions) {
		const remaining = data.quota_snapshots.premium_interactions.percent_remaining;
		windows.push({
			label: "Premium",
			usedPercent: clampPercent(100 - (remaining ?? 0))
		});
	}
	if (data.quota_snapshots?.chat) {
		const remaining = data.quota_snapshots.chat.percent_remaining;
		windows.push({
			label: "Chat",
			usedPercent: clampPercent(100 - (remaining ?? 0))
		});
	}
	return {
		provider: "github-copilot",
		displayName: PROVIDER_LABELS["github-copilot"],
		windows,
		plan: data.copilot_plan
	};
}
//#endregion
export { fetchCopilotUsage as t };
