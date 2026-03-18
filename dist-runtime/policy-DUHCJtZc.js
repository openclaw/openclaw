import { Kt as evaluateSenderGroupAccessForPolicy } from "./registry-ep1yQ6WN.js";
import { r as normalizeFeishuTarget } from "./runtime-D-stDOeW.js";
//#region extensions/feishu/src/policy.ts
function normalizeFeishuAllowEntry(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	if (trimmed === "*") return "*";
	const withoutProviderPrefix = trimmed.replace(/^feishu:/i, "");
	return (normalizeFeishuTarget(withoutProviderPrefix) ?? withoutProviderPrefix).trim().toLowerCase();
}
function resolveFeishuAllowlistMatch(params) {
	const allowFrom = params.allowFrom.map((entry) => normalizeFeishuAllowEntry(String(entry))).filter(Boolean);
	if (allowFrom.length === 0) return { allowed: false };
	if (allowFrom.includes("*")) return {
		allowed: true,
		matchKey: "*",
		matchSource: "wildcard"
	};
	const senderCandidates = [params.senderId, ...params.senderIds ?? []].map((entry) => normalizeFeishuAllowEntry(String(entry ?? ""))).filter(Boolean);
	for (const senderId of senderCandidates) if (allowFrom.includes(senderId)) return {
		allowed: true,
		matchKey: senderId,
		matchSource: "id"
	};
	return { allowed: false };
}
function resolveFeishuGroupConfig(params) {
	const groups = params.cfg?.groups ?? {};
	const wildcard = groups["*"];
	const groupId = params.groupId?.trim();
	if (!groupId) return;
	const direct = groups[groupId];
	if (direct) return direct;
	const lowered = groupId.toLowerCase();
	const matchKey = Object.keys(groups).find((key) => key.toLowerCase() === lowered);
	if (matchKey) return groups[matchKey];
	return wildcard;
}
function resolveFeishuGroupToolPolicy(params) {
	const cfg = params.cfg.channels?.feishu;
	if (!cfg) return;
	return resolveFeishuGroupConfig({
		cfg,
		groupId: params.groupId
	})?.tools;
}
function isFeishuGroupAllowed(params) {
	return evaluateSenderGroupAccessForPolicy({
		groupPolicy: params.groupPolicy === "allowall" ? "open" : params.groupPolicy,
		groupAllowFrom: params.allowFrom.map((entry) => String(entry)),
		senderId: params.senderId,
		isSenderAllowed: () => resolveFeishuAllowlistMatch(params).allowed
	}).allowed;
}
function resolveFeishuReplyPolicy(params) {
	if (params.isDirectMessage) return { requireMention: false };
	return { requireMention: params.groupConfig?.requireMention ?? params.globalConfig?.requireMention ?? true };
}
//#endregion
export { resolveFeishuReplyPolicy as a, resolveFeishuGroupToolPolicy as i, resolveFeishuAllowlistMatch as n, resolveFeishuGroupConfig as r, isFeishuGroupAllowed as t };
