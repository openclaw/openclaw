import { i as resolveOpenProviderRuntimeGroupPolicy } from "./runtime-group-policy-CmZDlIwd.js";
//#region src/plugin-sdk/group-access.ts
/**
* @deprecated Public SDK subpath has no bundled extension production imports.
* Use resolveChannelMessageIngress from channel-ingress-runtime instead.
*/
/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
function resolveSenderScopedGroupPolicy(params) {
	if (params.groupPolicy === "disabled") return "disabled";
	return params.groupAllowFrom.length > 0 ? "allowlist" : "open";
}
/** @deprecated Use route descriptors with `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
function evaluateGroupRouteAccessForPolicy(params) {
	if (params.groupPolicy === "disabled") return {
		allowed: false,
		groupPolicy: params.groupPolicy,
		reason: "disabled"
	};
	if (params.routeMatched && params.routeEnabled === false) return {
		allowed: false,
		groupPolicy: params.groupPolicy,
		reason: "route_disabled"
	};
	if (params.groupPolicy === "allowlist") {
		if (!params.routeAllowlistConfigured) return {
			allowed: false,
			groupPolicy: params.groupPolicy,
			reason: "empty_allowlist"
		};
		if (!params.routeMatched) return {
			allowed: false,
			groupPolicy: params.groupPolicy,
			reason: "route_not_allowlisted"
		};
	}
	return {
		allowed: true,
		groupPolicy: params.groupPolicy,
		reason: "allowed"
	};
}
/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
function evaluateMatchedGroupAccessForPolicy(params) {
	if (params.groupPolicy === "disabled") return {
		allowed: false,
		groupPolicy: params.groupPolicy,
		reason: "disabled"
	};
	if (params.groupPolicy === "allowlist") {
		if (params.requireMatchInput && !params.hasMatchInput) return {
			allowed: false,
			groupPolicy: params.groupPolicy,
			reason: "missing_match_input"
		};
		if (!params.allowlistConfigured) return {
			allowed: false,
			groupPolicy: params.groupPolicy,
			reason: "empty_allowlist"
		};
		if (!params.allowlistMatched) return {
			allowed: false,
			groupPolicy: params.groupPolicy,
			reason: "not_allowlisted"
		};
	}
	return {
		allowed: true,
		groupPolicy: params.groupPolicy,
		reason: "allowed"
	};
}
/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
function evaluateSenderGroupAccessForPolicy(params) {
	const providerMissingFallbackApplied = Boolean(params.providerMissingFallbackApplied);
	if (params.groupPolicy === "disabled") return {
		allowed: false,
		groupPolicy: params.groupPolicy,
		providerMissingFallbackApplied,
		reason: "disabled"
	};
	if (params.groupPolicy === "allowlist") {
		if (params.groupAllowFrom.length === 0) return {
			allowed: false,
			groupPolicy: params.groupPolicy,
			providerMissingFallbackApplied,
			reason: "empty_allowlist"
		};
		if (!params.isSenderAllowed(params.senderId, params.groupAllowFrom)) return {
			allowed: false,
			groupPolicy: params.groupPolicy,
			providerMissingFallbackApplied,
			reason: "sender_not_allowlisted"
		};
	}
	return {
		allowed: true,
		groupPolicy: params.groupPolicy,
		providerMissingFallbackApplied,
		reason: "allowed"
	};
}
/** @deprecated Use `resolveOpenProviderRuntimeGroupPolicy` plus `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
function evaluateSenderGroupAccess(params) {
	const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
		providerConfigPresent: params.providerConfigPresent,
		groupPolicy: params.configuredGroupPolicy,
		defaultGroupPolicy: params.defaultGroupPolicy
	});
	return evaluateSenderGroupAccessForPolicy({
		groupPolicy,
		providerMissingFallbackApplied,
		groupAllowFrom: params.groupAllowFrom,
		senderId: params.senderId,
		isSenderAllowed: params.isSenderAllowed
	});
}
//#endregion
export { resolveSenderScopedGroupPolicy as a, evaluateSenderGroupAccessForPolicy as i, evaluateMatchedGroupAccessForPolicy as n, evaluateSenderGroupAccess as r, evaluateGroupRouteAccessForPolicy as t };
