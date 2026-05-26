import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import "./routing-79DRZvfm.js";
import { t as matchesApprovalRequestFilters } from "./approval-request-filters-CMNXbdNy.js";
import { p as getExecApprovalReplyMetadata } from "./exec-approval-reply-DtVFspP8.js";
//#region src/plugin-sdk/approval-client-helpers.ts
function isApprovalTargetsMode(cfg) {
	const execApprovals = cfg.approvals?.exec;
	if (!execApprovals?.enabled) return false;
	return execApprovals.mode === "targets" || execApprovals.mode === "both";
}
function isChannelExecApprovalClientEnabledFromConfig(params) {
	if (params.approverCount <= 0) return false;
	return params.enabled === true || params.enabled === "auto";
}
function isChannelExecApprovalTargetRecipient(params) {
	const normalizeSenderId = params.normalizeSenderId ?? normalizeOptionalString;
	const normalizedSenderId = params.senderId ? normalizeSenderId(params.senderId) : void 0;
	const normalizedChannel = normalizeOptionalLowercaseString(params.channel);
	if (!normalizedSenderId || !isApprovalTargetsMode(params.cfg)) return false;
	const targets = params.cfg.approvals?.exec?.targets;
	if (!targets) return false;
	const normalizedAccountId = params.accountId ? normalizeAccountId(params.accountId) : void 0;
	return targets.some((target) => {
		if (normalizeOptionalLowercaseString(target.channel) !== normalizedChannel) return false;
		if (normalizedAccountId && target.accountId && normalizeAccountId(target.accountId) !== normalizedAccountId) return false;
		return params.matchTarget({
			target,
			normalizedSenderId,
			normalizedAccountId
		});
	});
}
function createChannelExecApprovalProfile(params) {
	const normalizeSenderId = params.normalizeSenderId ?? normalizeOptionalString;
	const isClientEnabled = (input) => {
		return isChannelExecApprovalClientEnabledFromConfig({
			enabled: params.resolveConfig(input)?.enabled,
			approverCount: params.resolveApprovers(input).length
		});
	};
	const isApprover = (input) => {
		const normalizedSenderId = input.senderId ? normalizeSenderId(input.senderId) : void 0;
		if (!normalizedSenderId) return false;
		return params.resolveApprovers(input).includes(normalizedSenderId);
	};
	const isAuthorizedSender = (input) => {
		return isApprover(input) || (params.isTargetRecipient?.(input) ?? false);
	};
	const resolveTarget = (input) => {
		return params.resolveConfig(input)?.target ?? "dm";
	};
	const shouldHandleRequest = (input) => {
		if (params.matchesRequestAccount && !params.matchesRequestAccount(input)) return false;
		const config = params.resolveConfig(input);
		const approverCount = params.resolveApprovers(input).length;
		if (!isChannelExecApprovalClientEnabledFromConfig({
			enabled: config?.enabled,
			approverCount
		})) return false;
		return matchesApprovalRequestFilters({
			request: input.request.request,
			agentFilter: config?.agentFilter,
			sessionFilter: config?.sessionFilter,
			fallbackAgentIdFromSessionKey: params.fallbackAgentIdFromSessionKey === true
		});
	};
	const shouldSuppressLocalPrompt = (input) => {
		if (params.requireClientEnabledForLocalPromptSuppression !== false && !isClientEnabled(input)) return false;
		return getExecApprovalReplyMetadata(input.payload) !== null;
	};
	return {
		isClientEnabled,
		isApprover,
		isAuthorizedSender,
		resolveTarget,
		shouldHandleRequest,
		shouldSuppressLocalPrompt
	};
}
//#endregion
export { isChannelExecApprovalClientEnabledFromConfig as n, isChannelExecApprovalTargetRecipient as r, createChannelExecApprovalProfile as t };
