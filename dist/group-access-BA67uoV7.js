import { n as firstDefined } from "./allow-from-D1f7S_rf.js";
import { i as resolveOpenProviderRuntimeGroupPolicy } from "./runtime-group-policy-CmZDlIwd.js";
import { W as isSenderAllowed } from "./format-B4PA8GD8.js";
//#region extensions/telegram/src/group-access.ts
function isGroupAllowOverrideAuthorized(params) {
	if (!params.effectiveGroupAllow.hasEntries) return false;
	const senderId = params.senderId ?? "";
	if (params.requireSenderForAllowOverride && !senderId) return false;
	return isSenderAllowed({
		allow: params.effectiveGroupAllow,
		senderId,
		senderUsername: params.senderUsername ?? ""
	});
}
const evaluateTelegramGroupBaseAccess = (params) => {
	if (params.groupConfig?.enabled === false) return {
		allowed: false,
		reason: "group-disabled"
	};
	if (params.topicConfig?.enabled === false) return {
		allowed: false,
		reason: "topic-disabled"
	};
	if (!params.isGroup) {
		if (params.enforceAllowOverride && params.hasGroupAllowOverride) {
			if (!isGroupAllowOverrideAuthorized({
				effectiveGroupAllow: params.effectiveGroupAllow,
				senderId: params.senderId,
				senderUsername: params.senderUsername,
				requireSenderForAllowOverride: params.requireSenderForAllowOverride
			})) return {
				allowed: false,
				reason: "group-override-unauthorized"
			};
		}
		return { allowed: true };
	}
	if (!params.enforceAllowOverride || !params.hasGroupAllowOverride) return { allowed: true };
	if (!isGroupAllowOverrideAuthorized({
		effectiveGroupAllow: params.effectiveGroupAllow,
		senderId: params.senderId,
		senderUsername: params.senderUsername,
		requireSenderForAllowOverride: params.requireSenderForAllowOverride
	})) return {
		allowed: false,
		reason: "group-override-unauthorized"
	};
	return { allowed: true };
};
const resolveTelegramRuntimeGroupPolicy = (params) => resolveOpenProviderRuntimeGroupPolicy({
	providerConfigPresent: params.providerConfigPresent,
	groupPolicy: params.groupPolicy,
	defaultGroupPolicy: params.defaultGroupPolicy
});
const evaluateTelegramGroupPolicyAccess = (params) => {
	const { groupPolicy: runtimeFallbackPolicy } = resolveTelegramRuntimeGroupPolicy({
		providerConfigPresent: params.cfg.channels?.telegram !== void 0,
		groupPolicy: params.telegramCfg.groupPolicy,
		defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy
	});
	const fallbackPolicy = firstDefined(params.telegramCfg.groupPolicy, params.cfg.channels?.defaults?.groupPolicy) ?? runtimeFallbackPolicy;
	const groupPolicy = params.useTopicAndGroupOverrides ? firstDefined(params.topicConfig?.groupPolicy, params.groupConfig?.groupPolicy, params.telegramCfg.groupPolicy, params.cfg.channels?.defaults?.groupPolicy) ?? runtimeFallbackPolicy : fallbackPolicy;
	if (!params.isGroup || !params.enforcePolicy) return {
		allowed: true,
		groupPolicy
	};
	if (groupPolicy === "disabled") return {
		allowed: false,
		reason: "group-policy-disabled",
		groupPolicy
	};
	let chatExplicitlyAllowed = false;
	if (params.checkChatAllowlist) {
		const groupAllowlist = params.resolveGroupPolicy(params.chatId);
		if (groupAllowlist.allowlistEnabled && !groupAllowlist.allowed) return {
			allowed: false,
			reason: "group-chat-not-allowed",
			groupPolicy
		};
		if (groupAllowlist.allowlistEnabled && groupAllowlist.allowed && groupAllowlist.groupConfig) chatExplicitlyAllowed = true;
	}
	if (groupPolicy === "allowlist" && params.enforceAllowlistAuthorization) {
		const senderId = params.senderId ?? "";
		const allowlistConfigured = chatExplicitlyAllowed || params.allowEmptyAllowlistEntries || params.effectiveGroupAllow.hasEntries;
		const allowlistMatched = chatExplicitlyAllowed && !params.effectiveGroupAllow.hasEntries || isSenderAllowed({
			allow: params.effectiveGroupAllow,
			senderId,
			senderUsername: params.senderUsername ?? ""
		});
		if (params.requireSenderForAllowlistAuthorization && !senderId) return {
			allowed: false,
			reason: "group-policy-allowlist-no-sender",
			groupPolicy
		};
		if (!allowlistConfigured) return {
			allowed: false,
			reason: "group-policy-allowlist-empty",
			groupPolicy
		};
		if (!allowlistMatched) return {
			allowed: false,
			reason: "group-policy-allowlist-unauthorized",
			groupPolicy
		};
	}
	return {
		allowed: true,
		groupPolicy
	};
};
//#endregion
export { evaluateTelegramGroupPolicyAccess as n, resolveTelegramRuntimeGroupPolicy as r, evaluateTelegramGroupBaseAccess as t };
