import { s as normalizeOptionalLowercaseString } from "../../string-coerce-Bje8XVt9.js";
import { n as normalizeAccountId } from "../../account-id-Bj7l9NI7.js";
import "../../text-runtime-FOsx_CPC.js";
import { s as resolveMergedAccountConfig } from "../../account-helpers-CWGvdl90.js";
import { i as evaluateSenderGroupAccessForPolicy } from "../../group-access-D3mywAWZ.js";
import "../../account-resolution-CBPOBqRz.js";
import { t as detectIdType } from "./targets-D918Lakg.js";
//#region extensions/feishu/src/policy.ts
const FEISHU_PROVIDER_PREFIX_RE = /^(feishu|lark):/i;
function stripRepeatedFeishuProviderPrefixes(raw) {
	let normalized = raw.trim();
	while (FEISHU_PROVIDER_PREFIX_RE.test(normalized)) normalized = normalized.replace(FEISHU_PROVIDER_PREFIX_RE, "").trim();
	return normalized;
}
function canonicalizeFeishuAllowlistKey(params) {
	const value = params.value.trim();
	if (!value) return "";
	if (value === "*") return "*";
	return `${params.kind}:${value}`;
}
function normalizeFeishuAllowEntry(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	if (trimmed === "*") return "*";
	const withoutProviderPrefix = stripRepeatedFeishuProviderPrefixes(trimmed);
	if (withoutProviderPrefix === "*") return "*";
	const lowered = normalizeOptionalLowercaseString(withoutProviderPrefix) ?? "";
	if (!lowered) return "";
	if (lowered.startsWith("chat:") || lowered.startsWith("group:") || lowered.startsWith("channel:")) return canonicalizeFeishuAllowlistKey({
		kind: "chat",
		value: withoutProviderPrefix.slice(withoutProviderPrefix.indexOf(":") + 1)
	});
	if (lowered.startsWith("user:") || lowered.startsWith("dm:")) return canonicalizeFeishuAllowlistKey({
		kind: "user",
		value: withoutProviderPrefix.slice(withoutProviderPrefix.indexOf(":") + 1)
	});
	if (lowered.startsWith("open_id:")) return canonicalizeFeishuAllowlistKey({
		kind: "user",
		value: withoutProviderPrefix.slice(withoutProviderPrefix.indexOf(":") + 1)
	});
	const detectedType = detectIdType(withoutProviderPrefix);
	if (detectedType === "chat_id") return canonicalizeFeishuAllowlistKey({
		kind: "chat",
		value: withoutProviderPrefix
	});
	if (detectedType === "open_id" || detectedType === "user_id") return canonicalizeFeishuAllowlistKey({
		kind: "user",
		value: withoutProviderPrefix
	});
	return "";
}
function resolveFeishuAllowlistMatch(params) {
	const allowFrom = params.allowFrom.map((entry) => normalizeFeishuAllowEntry(String(entry))).filter(Boolean);
	if (allowFrom.length === 0) return { allowed: false };
	if (allowFrom.includes("*")) return {
		allowed: true,
		matchKey: "*",
		matchSource: "wildcard"
	};
	const senderCandidates = [params.senderId, ...params.senderIds ?? []].map((entry) => normalizeFeishuAllowEntry(entry ?? "")).filter(Boolean);
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
	const lowered = normalizeOptionalLowercaseString(groupId) ?? "";
	const matchKey = Object.keys(groups).find((key) => normalizeOptionalLowercaseString(key) === lowered);
	if (matchKey) return groups[matchKey];
	return wildcard;
}
function hasExplicitFeishuGroupConfig(params) {
	const groups = params.cfg?.groups ?? {};
	const groupId = params.groupId?.trim();
	if (!groupId) return false;
	if (Object.prototype.hasOwnProperty.call(groups, groupId) && groupId !== "*") return true;
	const lowered = normalizeOptionalLowercaseString(groupId) ?? "";
	return Object.keys(groups).some((key) => key !== "*" && normalizeOptionalLowercaseString(key) === lowered);
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
	const feishuCfg = params.cfg.channels?.feishu;
	const resolvedCfg = resolveMergedAccountConfig({
		channelConfig: feishuCfg,
		accounts: feishuCfg?.accounts,
		accountId: normalizeAccountId(params.accountId),
		normalizeAccountId,
		omitKeys: ["defaultAccount"]
	});
	const groupRequireMention = resolveFeishuGroupConfig({
		cfg: resolvedCfg,
		groupId: params.groupId
	})?.requireMention;
	return { requireMention: typeof groupRequireMention === "boolean" ? groupRequireMention : typeof resolvedCfg.requireMention === "boolean" ? resolvedCfg.requireMention : params.groupPolicy !== "open" };
}
//#endregion
export { resolveFeishuGroupToolPolicy as a, resolveFeishuGroupConfig as i, isFeishuGroupAllowed as n, resolveFeishuReplyPolicy as o, resolveFeishuAllowlistMatch as r, hasExplicitFeishuGroupConfig as t };
