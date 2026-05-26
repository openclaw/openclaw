import { o as channelRouteTargetsMatchExact } from "./channel-route-L2PJ-xNE.js";
import { t as resolveApprovalRequestOriginTarget } from "./exec-approval-session-target-Db-D1QlZ.js";
//#region src/plugin-sdk/approval-native-helpers.ts
function nativeApprovalTargetsMatch(params) {
	return channelRouteTargetsMatchExact({
		left: {
			channel: params.channel,
			to: params.left.to,
			accountId: params.left.accountId,
			threadId: params.left.threadId
		},
		right: {
			channel: params.channel,
			to: params.right.to,
			accountId: params.right.accountId,
			threadId: params.right.threadId
		}
	});
}
function isNativeApprovalTarget(value) {
	return Boolean(value && typeof value === "object" && typeof value.to === "string");
}
function nativeApprovalTargetMatcher(channel) {
	return (left, right) => isNativeApprovalTarget(left) && isNativeApprovalTarget(right) && nativeApprovalTargetsMatch({
		channel,
		left,
		right
	});
}
function createOriginTargetResolver(params) {
	return (input) => {
		if (params.shouldHandleRequest && !params.shouldHandleRequest(input)) return null;
		const normalizeTarget = (target) => {
			if (!target) return null;
			return params.normalizeTarget ? params.normalizeTarget(target, input.request) ?? null : target;
		};
		const normalizeTargetForMatch = (target) => params.normalizeTargetForMatch?.(target, input.request) ?? target;
		return resolveApprovalRequestOriginTarget({
			cfg: input.cfg,
			request: input.request,
			channel: params.channel,
			accountId: input.accountId,
			resolveTurnSourceTarget: (request) => normalizeTarget(params.resolveTurnSourceTarget(request)),
			resolveSessionTarget: (sessionTarget) => normalizeTarget(params.resolveSessionTarget(sessionTarget, input.request)),
			targetsMatch: (left, right) => {
				const normalizedLeft = normalizeTargetForMatch(left);
				const normalizedRight = normalizeTargetForMatch(right);
				return Boolean(normalizedLeft && normalizedRight && params.targetsMatch(normalizedLeft, normalizedRight));
			},
			resolveFallbackTarget: params.resolveFallbackTarget ? (request) => normalizeTarget(params.resolveFallbackTarget?.(request) ?? null) : void 0
		});
	};
}
function hasCustomTargetsMatch(params) {
	return typeof params.targetsMatch === "function";
}
function createChannelNativeOriginTargetResolver(params) {
	if (hasCustomTargetsMatch(params)) return createOriginTargetResolver(params);
	return createOriginTargetResolver({
		...params,
		targetsMatch: nativeApprovalTargetMatcher(params.channel)
	});
}
function createChannelApproverDmTargetResolver(params) {
	return (input) => {
		if (params.shouldHandleRequest && !params.shouldHandleRequest(input)) return [];
		const targets = [];
		for (const approver of params.resolveApprovers({
			cfg: input.cfg,
			accountId: input.accountId
		})) {
			const target = params.mapApprover(approver, input);
			if (target) targets.push(target);
		}
		return targets;
	};
}
//#endregion
export { createChannelNativeOriginTargetResolver as n, createChannelApproverDmTargetResolver as t };
