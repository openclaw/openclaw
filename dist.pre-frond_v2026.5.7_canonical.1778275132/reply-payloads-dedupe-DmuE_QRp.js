import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { r as normalizeOptionalAccountId } from "./account-id-Bj7l9NI7.js";
import { a as normalizeAnyChannelId } from "./registry-DCDeYWxU.js";
import { h as stringifyRouteThreadId, o as channelRouteTargetsMatchExact } from "./channel-route-clbSK-46.js";
import { t as getChannelPlugin } from "./registry-sLSHLMDf.js";
import "./plugins-BEXErCqt.js";
import { i as isMessagingToolDuplicate } from "./pi-embedded-helpers-DYMwAeTk.js";
import { a as normalizeTargetForProvider } from "./target-normalization-MVno0zPr.js";
//#region src/auto-reply/reply/reply-payloads-dedupe.ts
function filterMessagingToolDuplicates(params) {
	const { payloads, sentTexts } = params;
	if (sentTexts.length === 0) return payloads;
	return payloads.filter((payload) => {
		if (payload.mediaUrl || payload.mediaUrls?.length) return true;
		return !isMessagingToolDuplicate(payload.text ?? "", sentTexts);
	});
}
function filterMessagingToolMediaDuplicates(params) {
	const normalizeMediaForDedupe = (value) => {
		const trimmed = value.trim();
		if (!trimmed) return "";
		if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith("file://")) return trimmed;
		try {
			const parsed = new URL(trimmed);
			if (parsed.protocol === "file:") return decodeURIComponent(parsed.pathname || "");
		} catch {}
		return trimmed.replace(/^file:\/\//i, "");
	};
	const { payloads, sentMediaUrls } = params;
	if (sentMediaUrls.length === 0) return payloads;
	const sentSet = new Set(sentMediaUrls.map(normalizeMediaForDedupe).filter(Boolean));
	return payloads.map((payload) => {
		const mediaUrl = payload.mediaUrl;
		const mediaUrls = payload.mediaUrls;
		const stripSingle = mediaUrl && sentSet.has(normalizeMediaForDedupe(mediaUrl));
		const filteredUrls = mediaUrls?.filter((u) => !sentSet.has(normalizeMediaForDedupe(u)));
		if (!stripSingle && (!mediaUrls || filteredUrls?.length === mediaUrls.length)) return payload;
		return Object.assign({}, payload, {
			mediaUrl: stripSingle ? void 0 : mediaUrl,
			mediaUrls: filteredUrls?.length ? filteredUrls : void 0
		});
	});
}
function normalizeProviderForComparison(value) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return;
	const lowered = normalizeLowercaseStringOrEmpty(trimmed);
	const normalizedChannel = normalizeAnyChannelId(trimmed);
	if (normalizedChannel) return normalizedChannel;
	return lowered;
}
function normalizeThreadIdForComparison(value) {
	return stringifyRouteThreadId(value);
}
function resolveTargetProviderForComparison(params) {
	const targetProvider = normalizeProviderForComparison(params.targetProvider);
	if (!targetProvider || targetProvider === "message") return params.currentProvider;
	return targetProvider;
}
function normalizeRouteTargetForDedupe(params) {
	const to = normalizeTargetForProvider(params.provider, params.rawTarget);
	if (!to) return null;
	return {
		channel: params.provider,
		to,
		...params.accountId ? { accountId: params.accountId } : {},
		...params.threadId != null ? { threadId: params.threadId } : {}
	};
}
function targetsMatchForDedupe(params) {
	const pluginMatch = getChannelPlugin(params.provider)?.outbound?.targetsMatchForReplySuppression;
	if (pluginMatch) return pluginMatch({
		originTarget: params.originTarget,
		targetKey: params.targetKey,
		targetThreadId: normalizeThreadIdForComparison(params.targetThreadId)
	});
	return params.targetKey === params.originTarget;
}
function shouldDedupeMessagingToolRepliesForRoute(params) {
	return getMatchingMessagingToolReplyTargets(params).length > 0;
}
function getMatchingMessagingToolReplyTargets(params) {
	const provider = normalizeProviderForComparison(params.messageProvider);
	if (!provider) return [];
	const originRawTarget = normalizeOptionalString(params.originatingTo);
	const originAccount = normalizeOptionalAccountId(params.accountId);
	const sentTargets = params.messagingToolSentTargets ?? [];
	if (sentTargets.length === 0) return [];
	return sentTargets.filter((target) => {
		const targetProvider = resolveTargetProviderForComparison({
			currentProvider: provider,
			targetProvider: target?.provider
		});
		if (targetProvider !== provider) return false;
		const targetAccount = normalizeOptionalAccountId(target.accountId);
		if (originAccount && targetAccount && originAccount !== targetAccount) return false;
		const targetRaw = normalizeOptionalString(target.to);
		const routeAccount = originAccount ?? targetAccount;
		const originRoute = normalizeRouteTargetForDedupe({
			provider,
			rawTarget: originRawTarget,
			accountId: routeAccount
		});
		if (!originRoute) return false;
		const targetRoute = normalizeRouteTargetForDedupe({
			provider: targetProvider,
			rawTarget: targetRaw,
			accountId: routeAccount,
			threadId: target.threadId
		});
		if (!targetRoute) return false;
		if (channelRouteTargetsMatchExact({
			left: originRoute,
			right: targetRoute
		})) return true;
		return targetsMatchForDedupe({
			provider,
			originTarget: originRoute.to,
			targetKey: targetRoute.to,
			targetThreadId: target.threadId
		});
	});
}
function resolveMessagingToolPayloadDedupe(params) {
	const sentTargets = params.messagingToolSentTargets ?? [];
	const matchingTargets = getMatchingMessagingToolReplyTargets({
		messageProvider: params.messageProvider,
		messagingToolSentTargets: sentTargets,
		originatingTo: params.originatingTo,
		accountId: params.accountId
	});
	const matchingRoute = matchingTargets.length > 0;
	const routeSentTexts = matchingTargets.flatMap((target) => typeof target.text === "string" && target.text.trim() ? [target.text] : []);
	const routeSentMediaUrls = matchingTargets.flatMap((target) => Array.isArray(target.mediaUrls) ? target.mediaUrls.filter((url) => typeof url === "string" && Boolean(url.trim())) : []);
	const hasTargetTextEvidence = sentTargets.some((target) => typeof target.text === "string" && Boolean(target.text.trim()));
	const hasTargetMediaUrlEvidence = sentTargets.some((target) => Array.isArray(target.mediaUrls) && target.mediaUrls.some((url) => typeof url === "string" && Boolean(url.trim())));
	return {
		shouldDedupePayloads: matchingRoute || sentTargets.length === 0,
		matchingRoute,
		routeSentTexts,
		routeSentMediaUrls,
		useGlobalSentTextEvidenceFallback: matchingRoute && !hasTargetTextEvidence,
		useGlobalSentMediaUrlEvidenceFallback: matchingRoute && !hasTargetMediaUrlEvidence
	};
}
//#endregion
export { shouldDedupeMessagingToolRepliesForRoute as i, filterMessagingToolMediaDuplicates as n, resolveMessagingToolPayloadDedupe as r, filterMessagingToolDuplicates as t };
