import { t as resolveApprovalApprovers } from "./approval-approvers-CAgKOZSr.js";
import { t as matchesApprovalRequestFilters } from "./approval-request-filters-CoU0XDAm.js";
import { p as getExecApprovalReplyMetadata } from "./exec-approval-reply-CiKq6-2n.js";
import { n as isChannelExecApprovalClientEnabledFromConfig } from "./approval-client-helpers-Cgg4F3NU.js";
import "./approval-client-runtime-DcDmgb-3.js";
import "./approval-delivery-runtime-BCGH-M7s.js";
import { a as doesApprovalRequestMatchChannelAccount } from "./exec-approval-session-target-DGXu7kOW.js";
import "./approval-native-runtime-Cxfxz9ZM.js";
import { s as resolveDiscordAccount } from "./accounts-DzQH7q_E.js";
import { t as parseDiscordTarget } from "./target-parsing-Z-BadXli.js";
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
