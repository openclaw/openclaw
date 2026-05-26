import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { c as defineStableChannelIngressIdentity, n as createChannelIngressResolver } from "./runtime-BUVuto5K.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { c as resolveMergedAccountConfig } from "./account-helpers-BEXOONiv.js";
import "./account-resolution-Dy8RKAMt.js";
import "./channel-ingress-runtime-C3bbz3sX.js";
import { t as detectIdType } from "./targets-BVM6OB3d.js";
//#region extensions/feishu/src/policy.ts
const FEISHU_PROVIDER_PREFIX_RE = /^(feishu|lark):/i;
const FEISHU_TYPED_PREFIX_RE = /^(chat|group|channel|user|dm|open_id):/i;
const FEISHU_ID_KIND = "plugin:feishu-id";
const feishuIngressIdentity = defineStableChannelIngressIdentity({
	key: "feishu-id",
	kind: FEISHU_ID_KIND,
	normalize: normalizeFeishuAllowEntry,
	sensitivity: "pii",
	aliases: [{
		key: "feishu-alt-id",
		kind: FEISHU_ID_KIND,
		normalizeEntry: () => null,
		normalizeSubject: normalizeFeishuAllowEntry,
		sensitivity: "pii"
	}],
	isWildcardEntry: (entry) => normalizeFeishuAllowEntry(entry) === "*",
	resolveEntryId: ({ entryIndex }) => `feishu-entry-${entryIndex + 1}`
});
function normalizeFeishuAllowEntry(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	if (trimmed === "*") return "*";
	let withoutProviderPrefix = trimmed;
	while (FEISHU_PROVIDER_PREFIX_RE.test(withoutProviderPrefix)) withoutProviderPrefix = withoutProviderPrefix.replace(FEISHU_PROVIDER_PREFIX_RE, "").trim();
	if (withoutProviderPrefix === "*") return "*";
	const lowered = normalizeOptionalLowercaseString(withoutProviderPrefix) ?? "";
	if (!lowered) return "";
	const prefixed = lowered.match(FEISHU_TYPED_PREFIX_RE);
	if (prefixed?.[1]) {
		const kind = [
			"chat",
			"group",
			"channel"
		].includes(prefixed[1]) ? "chat" : "user";
		const value = withoutProviderPrefix.slice(prefixed[0].length).trim();
		return value === "*" ? "*" : value ? `${kind}:${value}` : "";
	}
	const detectedType = detectIdType(withoutProviderPrefix);
	if (detectedType === "chat_id") return `chat:${withoutProviderPrefix}`;
	if (detectedType === "open_id" || detectedType === "user_id") return `user:${withoutProviderPrefix}`;
	return "";
}
function normalizeFeishuDmPolicy(policy) {
	return policy === "open" || policy === "pairing" || policy === "allowlist" || policy === "disabled" ? policy : "pairing";
}
function normalizeFeishuGroupPolicy(policy) {
	return policy === "allowall" ? "open" : policy;
}
function createFeishuIngressSubject(params) {
	const ids = [params.primaryId, ...params.alternateIds ?? []].map((value) => value?.trim()).filter((value) => Boolean(value));
	return {
		stableId: ids[0],
		aliases: { "feishu-alt-id": ids[1] }
	};
}
function createFeishuIngressResolver(params) {
	return createChannelIngressResolver({
		channelId: "feishu",
		accountId: normalizeAccountId(params.accountId) ?? "default",
		identity: feishuIngressIdentity,
		cfg: params.cfg,
		...params.readAllowFromStore ? { readStoreAllowFrom: params.readAllowFromStore } : {}
	});
}
async function resolveFeishuDmIngressAccess(params) {
	return await createFeishuIngressResolver({
		cfg: params.cfg,
		accountId: params.accountId,
		readAllowFromStore: params.readAllowFromStore
	}).message({
		subject: createFeishuIngressSubject({
			primaryId: params.senderOpenId,
			alternateIds: [params.senderUserId]
		}),
		conversation: {
			kind: "direct",
			id: params.conversationId
		},
		event: { mayPair: params.mayPair },
		dmPolicy: normalizeFeishuDmPolicy(params.dmPolicy),
		groupPolicy: "disabled",
		allowFrom: params.allowFrom ?? [],
		...params.command ? { command: params.command } : {}
	});
}
async function resolveFeishuGroupConversationIngressAccess(params) {
	const groupPolicy = normalizeFeishuGroupPolicy(params.groupPolicy);
	const groupAllowFrom = groupPolicy === "allowlist" && params.groupExplicitlyConfigured ? [...params.groupAllowFrom ?? [], params.chatId] : params.groupAllowFrom ?? [];
	return await createFeishuIngressResolver({
		cfg: params.cfg,
		accountId: params.accountId
	}).message({
		subject: createFeishuIngressSubject({ primaryId: params.chatId }),
		conversation: {
			kind: "group",
			id: params.chatId
		},
		dmPolicy: "disabled",
		groupPolicy,
		groupAllowFrom
	});
}
async function resolveFeishuGroupSenderActivationIngressAccess(params) {
	const groupAllowFrom = params.allowFrom ?? [];
	return await createFeishuIngressResolver({
		cfg: params.cfg,
		accountId: params.accountId
	}).message({
		subject: createFeishuIngressSubject({
			primaryId: params.senderOpenId,
			alternateIds: [params.senderUserId]
		}),
		conversation: {
			kind: "group",
			id: params.chatId
		},
		dmPolicy: "disabled",
		groupPolicy: groupAllowFrom.length > 0 ? "allowlist" : "open",
		groupAllowFrom,
		mentionFacts: {
			canDetectMention: true,
			wasMentioned: params.mentionedBot
		},
		policy: { activation: {
			requireMention: params.requireMention,
			allowTextCommands: false
		} },
		...params.command ? { command: params.command } : {}
	});
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
export { resolveFeishuGroupConversationIngressAccess as a, resolveFeishuReplyPolicy as c, resolveFeishuGroupConfig as i, normalizeFeishuAllowEntry as n, resolveFeishuGroupSenderActivationIngressAccess as o, resolveFeishuDmIngressAccess as r, resolveFeishuGroupToolPolicy as s, hasExplicitFeishuGroupConfig as t };
