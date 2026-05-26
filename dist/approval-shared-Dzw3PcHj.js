import { t as resolveApprovalApprovers } from "./approval-approvers-BaAy3FfF.js";
import { t as matchesApprovalRequestFilters } from "./approval-request-filters-CMNXbdNy.js";
import { p as getExecApprovalReplyMetadata } from "./exec-approval-reply-DtVFspP8.js";
import { n as isChannelExecApprovalClientEnabledFromConfig } from "./approval-client-helpers-CA1AIFyl.js";
import "./approval-client-runtime-bIc9vTcH.js";
import "./approval-delivery-runtime-Bm03rV4m.js";
import { a as doesApprovalRequestMatchChannelAccount } from "./exec-approval-session-target-Db-D1QlZ.js";
import "./approval-native-runtime-BzhRXEPX.js";
import { s as resolveDiscordAccount } from "./accounts-DIRzXd2H.js";
import { t as parseDiscordTarget } from "./target-parsing-D1FhMbX6.js";
//#region extensions/discord/src/exec-approvals.ts
function normalizeDiscordApproverId(value) {
	const trimmed = value.trim();
	if (!trimmed) return;
	if (/^\d+$/.test(trimmed)) return trimmed;
	try {
		const target = parseDiscordTarget(trimmed);
		return target?.kind === "user" ? target.id : void 0;
	} catch {
		return;
	}
}
function resolveDiscordOwnerApprovers(cfg) {
	const ownerAllowFrom = cfg.commands?.ownerAllowFrom;
	if (!Array.isArray(ownerAllowFrom) || ownerAllowFrom.length === 0) return [];
	return resolveApprovalApprovers({
		explicit: ownerAllowFrom,
		normalizeApprover: (value) => normalizeDiscordApproverId(String(value))
	});
}
function getDiscordExecApprovalApprovers(params) {
	return resolveApprovalApprovers({
		explicit: params.configOverride?.approvers ?? resolveDiscordAccount(params).config.execApprovals?.approvers ?? resolveDiscordOwnerApprovers(params.cfg),
		normalizeApprover: (value) => normalizeDiscordApproverId(String(value))
	});
}
function isDiscordExecApprovalClientEnabled(params) {
	return isChannelExecApprovalClientEnabledFromConfig({
		enabled: (params.configOverride ?? resolveDiscordAccount(params).config.execApprovals)?.enabled,
		approverCount: getDiscordExecApprovalApprovers({
			cfg: params.cfg,
			accountId: params.accountId,
			configOverride: params.configOverride
		}).length
	});
}
function isDiscordExecApprovalApprover(params) {
	const senderId = params.senderId?.trim();
	if (!senderId) return false;
	return getDiscordExecApprovalApprovers({
		cfg: params.cfg,
		accountId: params.accountId,
		configOverride: params.configOverride
	}).includes(senderId);
}
function shouldSuppressLocalDiscordExecApprovalPrompt(params) {
	const metadata = getExecApprovalReplyMetadata(params.payload);
	const config = resolveDiscordAccount(params).config.execApprovals;
	return params.hint?.kind === "approval-pending" && params.hint.nativeRouteActive === true && isDiscordExecApprovalClientEnabled(params) && metadata !== null && matchesApprovalRequestFilters({
		request: {
			agentId: metadata.agentId,
			sessionKey: metadata.sessionKey
		},
		agentFilter: config?.agentFilter,
		sessionFilter: config?.sessionFilter
	});
}
//#endregion
//#region extensions/discord/src/approval-shared.ts
function shouldHandleDiscordApprovalRequest(params) {
	const config = params.configOverride ?? resolveDiscordAccount({
		cfg: params.cfg,
		accountId: params.accountId
	}).config.execApprovals;
	const approvers = getDiscordExecApprovalApprovers({
		cfg: params.cfg,
		accountId: params.accountId,
		configOverride: params.configOverride
	});
	if (!doesApprovalRequestMatchChannelAccount({
		cfg: params.cfg,
		request: params.request,
		channel: "discord",
		accountId: params.accountId
	})) return false;
	if (!isChannelExecApprovalClientEnabledFromConfig({
		enabled: config?.enabled,
		approverCount: approvers.length
	})) return false;
	return matchesApprovalRequestFilters({
		request: params.request.request,
		agentFilter: config?.agentFilter,
		sessionFilter: config?.sessionFilter
	});
}
//#endregion
export { shouldSuppressLocalDiscordExecApprovalPrompt as a, isDiscordExecApprovalClientEnabled as i, getDiscordExecApprovalApprovers as n, isDiscordExecApprovalApprover as r, shouldHandleDiscordApprovalRequest as t };
