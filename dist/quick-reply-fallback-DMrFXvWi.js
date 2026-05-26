import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { t as resolveAccountEntry } from "./account-lookup-CQEoGO1F.js";
import { t as createPluginRuntimeStore } from "./runtime-store-Cezm5nT2.js";
import "./account-resolution-Dy8RKAMt.js";
//#region extensions/line/src/group-keys.ts
function resolveLineGroupLookupIds(groupId) {
	const normalized = groupId?.trim();
	if (!normalized) return [];
	if (normalized.startsWith("group:") || normalized.startsWith("room:")) {
		const rawId = normalized.split(":").slice(1).join(":");
		return rawId ? [rawId, normalized] : [normalized];
	}
	return [
		normalized,
		`group:${normalized}`,
		`room:${normalized}`
	];
}
function resolveLineGroupConfigEntry(groups, params) {
	if (!groups) return;
	for (const candidate of resolveLineGroupLookupIds(params.groupId)) {
		const hit = groups[candidate];
		if (hit) return hit;
	}
	for (const candidate of resolveLineGroupLookupIds(params.roomId)) {
		const hit = groups[candidate];
		if (hit) return hit;
	}
	return groups["*"];
}
function resolveLineGroupsConfig(cfg, accountId) {
	const lineConfig = cfg.channels?.line;
	if (!lineConfig) return;
	const normalizedAccountId = normalizeAccountId(accountId);
	return resolveAccountEntry(lineConfig.accounts, normalizedAccountId)?.groups ?? lineConfig.groups;
}
function resolveExactLineGroupConfigKey(params) {
	const groups = resolveLineGroupsConfig(params.cfg, params.accountId);
	if (!groups) return;
	return resolveLineGroupLookupIds(params.groupId).find((candidate) => Object.hasOwn(groups, candidate));
}
//#endregion
//#region extensions/line/src/runtime.ts
const { setRuntime: setLineRuntime, clearRuntime: clearLineRuntime, getRuntime: getLineRuntime } = createPluginRuntimeStore({
	pluginId: "line",
	errorMessage: "LINE runtime not initialized - plugin not registered"
});
//#endregion
//#region extensions/line/src/quick-reply-fallback.ts
function buildLineQuickReplyFallbackText(labels) {
	const normalized = (labels ?? []).map((label) => label.trim()).filter(Boolean).slice(0, 13);
	if (normalized.length === 0) return "Choose an option.";
	return `Options:\n${normalized.map((label) => `- ${label}`).join("\n")}`;
}
//#endregion
export { resolveLineGroupConfigEntry as a, resolveExactLineGroupConfigKey as i, getLineRuntime as n, resolveLineGroupLookupIds as o, setLineRuntime as r, resolveLineGroupsConfig as s, buildLineQuickReplyFallbackText as t };
