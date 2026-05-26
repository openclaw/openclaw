import { u as normalizeMessageChannel } from "./message-channel-CYCKkVrh.js";
import "./routing-79DRZvfm.js";
//#region src/plugin-sdk/approval-delivery-helpers.ts
function buildApproverRestrictedNativeApprovalCapability(params) {
	const pluginSenderAuth = params.isPluginAuthorizedSender ?? params.isExecAuthorizedSender;
	const availabilityState = (enabled) => enabled ? { kind: "enabled" } : { kind: "disabled" };
	const normalizePreferredSurface = (mode) => mode === "channel" ? "origin" : mode === "dm" ? "approver-dm" : "both";
	const hasConfiguredApprovers = ({ cfg, accountId }) => params.hasApprovers({
		cfg,
		accountId
	});
	const isExecInitiatingSurfaceEnabled = ({ cfg, accountId }) => hasConfiguredApprovers({
		cfg,
		accountId
	}) && params.isNativeDeliveryEnabled({
		cfg,
		accountId
	});
	const resolveExecInitiatingSurfaceState = ({ cfg, accountId }) => availabilityState(isExecInitiatingSurfaceEnabled({
		cfg,
		accountId
	}));
	return createChannelApprovalCapability({
		authorizeActorAction: ({ cfg, accountId, senderId, approvalKind }) => {
			return (approvalKind === "plugin" ? pluginSenderAuth({
				cfg,
				accountId,
				senderId
			}) : params.isExecAuthorizedSender({
				cfg,
				accountId,
				senderId
			})) ? { authorized: true } : {
				authorized: false,
				reason: `❌ You are not authorized to approve ${approvalKind} requests on ${params.channelLabel}.`
			};
		},
		getActionAvailabilityState: ({ cfg, accountId }) => availabilityState(hasConfiguredApprovers({
			cfg,
			accountId
		})),
		getExecInitiatingSurfaceState: resolveExecInitiatingSurfaceState,
		describeExecApprovalSetup: params.describeExecApprovalSetup,
		delivery: {
			hasConfiguredDmRoute: ({ cfg }) => params.listAccountIds(cfg).some((accountId) => {
				if (!hasConfiguredApprovers({
					cfg,
					accountId
				})) return false;
				if (!params.isNativeDeliveryEnabled({
					cfg,
					accountId
				})) return false;
				const target = params.resolveNativeDeliveryMode({
					cfg,
					accountId
				});
				return target === "dm" || target === "both";
			}),
			shouldSuppressForwardingFallback: (input) => {
				if ((normalizeMessageChannel(input.target.channel) ?? input.target.channel) !== params.channel) return false;
				if (params.requireMatchingTurnSourceChannel) {
					if (normalizeMessageChannel(input.request.request.turnSourceChannel) !== params.channel) return false;
				}
				const resolvedAccountId = params.resolveSuppressionAccountId?.(input);
				const accountId = (resolvedAccountId === void 0 ? input.target.accountId?.trim() : resolvedAccountId.trim()) || void 0;
				return params.isNativeDeliveryEnabled({
					cfg: input.cfg,
					accountId
				});
			}
		},
		native: params.resolveOriginTarget || params.resolveApproverDmTargets ? {
			describeDeliveryCapabilities: ({ cfg, accountId }) => ({
				enabled: isExecInitiatingSurfaceEnabled({
					cfg,
					accountId
				}),
				preferredSurface: normalizePreferredSurface(params.resolveNativeDeliveryMode({
					cfg,
					accountId
				})),
				supportsOriginSurface: Boolean(params.resolveOriginTarget),
				supportsApproverDmSurface: Boolean(params.resolveApproverDmTargets),
				notifyOriginWhenDmOnly: params.notifyOriginWhenDmOnly ?? false
			}),
			resolveOriginTarget: params.resolveOriginTarget,
			resolveApproverDmTargets: params.resolveApproverDmTargets
		} : void 0,
		nativeRuntime: params.nativeRuntime
	});
}
function createApproverRestrictedNativeApprovalAdapter(params) {
	return splitChannelApprovalCapability(buildApproverRestrictedNativeApprovalCapability(params));
}
function createChannelApprovalCapability(params) {
	const surfaces = {
		delivery: params.delivery ?? params.approvals?.delivery,
		nativeRuntime: params.nativeRuntime ?? params.approvals?.nativeRuntime,
		render: params.render ?? params.approvals?.render,
		native: params.native ?? params.approvals?.native
	};
	return {
		authorizeActorAction: params.authorizeActorAction,
		getActionAvailabilityState: params.getActionAvailabilityState,
		getExecInitiatingSurfaceState: params.getExecInitiatingSurfaceState,
		resolveApproveCommandBehavior: params.resolveApproveCommandBehavior,
		describeExecApprovalSetup: params.describeExecApprovalSetup,
		delivery: surfaces.delivery,
		nativeRuntime: surfaces.nativeRuntime,
		render: surfaces.render,
		native: surfaces.native
	};
}
function splitChannelApprovalCapability(capability) {
	return {
		auth: {
			authorizeActorAction: capability.authorizeActorAction,
			getActionAvailabilityState: capability.getActionAvailabilityState,
			getExecInitiatingSurfaceState: capability.getExecInitiatingSurfaceState,
			resolveApproveCommandBehavior: capability.resolveApproveCommandBehavior
		},
		delivery: capability.delivery,
		nativeRuntime: capability.nativeRuntime,
		render: capability.render,
		native: capability.native,
		describeExecApprovalSetup: capability.describeExecApprovalSetup
	};
}
function createApproverRestrictedNativeApprovalCapability(params) {
	return buildApproverRestrictedNativeApprovalCapability(params);
}
//#endregion
export { splitChannelApprovalCapability as i, createApproverRestrictedNativeApprovalCapability as n, createChannelApprovalCapability as r, createApproverRestrictedNativeApprovalAdapter as t };
