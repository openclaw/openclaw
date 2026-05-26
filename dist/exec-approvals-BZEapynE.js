import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./routing-79DRZvfm.js";
import { t as resolveApprovalApprovers } from "./approval-approvers-BaAy3FfF.js";
import { t as createResolvedApproverActionAuthAdapter } from "./approval-auth-helpers-dxinAe5Y.js";
import { t as matchesApprovalRequestFilters } from "./approval-request-filters-CMNXbdNy.js";
import { p as getExecApprovalReplyMetadata } from "./exec-approval-reply-DtVFspP8.js";
import { n as isChannelExecApprovalClientEnabledFromConfig, r as isChannelExecApprovalTargetRecipient, t as createChannelExecApprovalProfile } from "./approval-client-helpers-CA1AIFyl.js";
import "./approval-client-runtime-bIc9vTcH.js";
import { s as resolveApprovalRequestChannelAccountId } from "./exec-approval-session-target-Db-D1QlZ.js";
import "./approval-native-runtime-BzhRXEPX.js";
import { i as resolveMatrixAccount, t as listMatrixAccountIds } from "./accounts-CAjG_HwT.js";
import { t as normalizeMatrixApproverId } from "./approval-ids-DC3o8pCu.js";
//#region extensions/matrix/src/approval-auth.ts
function getMatrixApprovalAuthApprovers(params) {
	return resolveApprovalApprovers({
		allowFrom: resolveMatrixAccount(params).config.dm?.allowFrom,
		normalizeApprover: normalizeMatrixApproverId
	});
}
const matrixApprovalAuth = createResolvedApproverActionAuthAdapter({
	channelLabel: "Matrix",
	resolveApprovers: ({ cfg, accountId }) => getMatrixApprovalAuthApprovers({
		cfg,
		accountId
	}),
	normalizeSenderId: (value) => normalizeMatrixApproverId(value)
});
//#endregion
//#region extensions/matrix/src/exec-approvals.ts
function normalizeMatrixExecApproverId(value) {
	const normalized = normalizeMatrixApproverId(value);
	return normalized === "*" ? void 0 : normalized;
}
function resolveMatrixExecApprovalConfig(params) {
	const account = resolveMatrixAccount(params);
	const config = account.config.execApprovals;
	if (!config) return;
	return {
		...config,
		enabled: account.enabled && account.configured ? config.enabled : false
	};
}
function countMatrixExecApprovalEligibleAccounts(params) {
	return listMatrixAccountIds(params.cfg).filter((accountId) => {
		const account = resolveMatrixAccount({
			cfg: params.cfg,
			accountId
		});
		if (!account.enabled || !account.configured) return false;
		const config = resolveMatrixExecApprovalConfig({
			cfg: params.cfg,
			accountId
		});
		const filters = config?.enabled ? {
			agentFilter: config.agentFilter,
			sessionFilter: config.sessionFilter
		} : {
			agentFilter: void 0,
			sessionFilter: void 0
		};
		return isChannelExecApprovalClientEnabledFromConfig({
			enabled: config?.enabled,
			approverCount: getMatrixApprovalApprovers({
				cfg: params.cfg,
				accountId,
				approvalKind: params.approvalKind
			}).length
		}) && matchesApprovalRequestFilters({
			request: params.request.request,
			agentFilter: filters.agentFilter,
			sessionFilter: filters.sessionFilter
		});
	}).length;
}
function matchesMatrixRequestAccount(params) {
	const turnSourceChannel = normalizeLowercaseStringOrEmpty(params.request.request.turnSourceChannel);
	const boundAccountId = resolveApprovalRequestChannelAccountId({
		cfg: params.cfg,
		request: params.request,
		channel: "matrix"
	});
	if (turnSourceChannel && turnSourceChannel !== "matrix" && !boundAccountId) return countMatrixExecApprovalEligibleAccounts({
		cfg: params.cfg,
		request: params.request,
		approvalKind: params.approvalKind
	}) <= 1;
	return !boundAccountId || !params.accountId || normalizeAccountId(boundAccountId) === normalizeAccountId(params.accountId);
}
function getMatrixExecApprovalApprovers(params) {
	const account = resolveMatrixAccount(params).config;
	return resolveApprovalApprovers({
		explicit: account.execApprovals?.approvers,
		allowFrom: account.dm?.allowFrom,
		normalizeApprover: normalizeMatrixExecApproverId
	});
}
function resolveMatrixApprovalKind(request) {
	return request.id.startsWith("plugin:") ? "plugin" : "exec";
}
function getMatrixApprovalApprovers(params) {
	if (params.approvalKind === "plugin") return getMatrixApprovalAuthApprovers({
		cfg: params.cfg,
		accountId: params.accountId
	});
	return getMatrixExecApprovalApprovers(params);
}
function isMatrixExecApprovalTargetRecipient(params) {
	return isChannelExecApprovalTargetRecipient({
		...params,
		channel: "matrix",
		normalizeSenderId: normalizeMatrixApproverId,
		matchTarget: ({ target, normalizedSenderId }) => normalizeMatrixApproverId(target.to) === normalizedSenderId
	});
}
const matrixExecApprovalProfile = createChannelExecApprovalProfile({
	resolveConfig: resolveMatrixExecApprovalConfig,
	resolveApprovers: getMatrixExecApprovalApprovers,
	normalizeSenderId: normalizeMatrixApproverId,
	isTargetRecipient: isMatrixExecApprovalTargetRecipient,
	matchesRequestAccount: (params) => matchesMatrixRequestAccount({
		...params,
		approvalKind: "exec"
	})
});
const isMatrixExecApprovalClientEnabled = matrixExecApprovalProfile.isClientEnabled;
matrixExecApprovalProfile.isApprover;
const isMatrixExecApprovalAuthorizedSender = matrixExecApprovalProfile.isAuthorizedSender;
const resolveMatrixExecApprovalTarget = matrixExecApprovalProfile.resolveTarget;
matrixExecApprovalProfile.shouldHandleRequest;
function isMatrixApprovalClientEnabled(params) {
	if (params.approvalKind === "exec") return isMatrixExecApprovalClientEnabled(params);
	return isChannelExecApprovalClientEnabledFromConfig({
		enabled: resolveMatrixExecApprovalConfig(params)?.enabled,
		approverCount: getMatrixApprovalApprovers(params).length
	});
}
function isMatrixAnyApprovalClientEnabled(params) {
	return isMatrixApprovalClientEnabled({
		...params,
		approvalKind: "exec"
	}) || isMatrixApprovalClientEnabled({
		...params,
		approvalKind: "plugin"
	});
}
function shouldHandleMatrixApprovalRequest(params) {
	const approvalKind = resolveMatrixApprovalKind(params.request);
	if (!matchesMatrixRequestAccount({
		...params,
		approvalKind
	})) return false;
	const config = resolveMatrixExecApprovalConfig(params);
	if (!isChannelExecApprovalClientEnabledFromConfig({
		enabled: config?.enabled,
		approverCount: getMatrixApprovalApprovers({
			...params,
			approvalKind
		}).length
	})) return false;
	return matchesApprovalRequestFilters({
		request: params.request.request,
		agentFilter: config?.agentFilter,
		sessionFilter: config?.sessionFilter
	});
}
function buildFilterCheckRequest(params) {
	if (params.metadata.approvalKind === "plugin") return {
		id: params.metadata.approvalId,
		request: {
			title: "Plugin Approval Required",
			description: "",
			agentId: params.metadata.agentId ?? null,
			sessionKey: params.metadata.sessionKey ?? null
		},
		createdAtMs: 0,
		expiresAtMs: 0
	};
	return {
		id: params.metadata.approvalId,
		request: {
			command: "",
			agentId: params.metadata.agentId ?? null,
			sessionKey: params.metadata.sessionKey ?? null
		},
		createdAtMs: 0,
		expiresAtMs: 0
	};
}
function shouldSuppressLocalMatrixExecApprovalPrompt(params) {
	if (!matrixExecApprovalProfile.shouldSuppressLocalPrompt(params)) return false;
	const metadata = getExecApprovalReplyMetadata(params.payload);
	if (!metadata) return false;
	const request = buildFilterCheckRequest({ metadata });
	return shouldHandleMatrixApprovalRequest({
		cfg: params.cfg,
		accountId: params.accountId,
		request
	});
}
//#endregion
export { isMatrixExecApprovalAuthorizedSender as a, shouldHandleMatrixApprovalRequest as c, matrixApprovalAuth as d, isMatrixApprovalClientEnabled as i, shouldSuppressLocalMatrixExecApprovalPrompt as l, getMatrixExecApprovalApprovers as n, isMatrixExecApprovalClientEnabled as o, isMatrixAnyApprovalClientEnabled as r, resolveMatrixExecApprovalTarget as s, getMatrixApprovalApprovers as t, getMatrixApprovalAuthApprovers as u };
